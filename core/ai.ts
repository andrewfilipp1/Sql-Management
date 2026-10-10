import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { AI_LIMITS, AI_PRESETS, DEFAULT_AI, type AiMessage, type AiRequest, type AiResponse, type AiSettings, type AiState, type AiUsageTotals } from '../shared/ai.ts';
import type { DbKind, SchemaSnapshot, TableInfo } from '../shared/types.ts';
import { decodeSecret, encodeSecret, getConnection, getDataDir } from './store.ts';
import { CodedError, HttpError } from './util.ts';

/**
 * AI assistant. Runs in the main process only, so the provider key never reaches the renderer.
 * What is sent to the provider: table/column/index/FK names and types, approximate row counts, the user's question and
 * the SQL in the editor. Row data is never sent. Answers are returned as text; SQL in them is
 * never executed here — the user reviews it in the editor and the normal guards apply.
 */

interface Stored {
  settings: AiSettings;
  key?: string;
  usage: AiUsageTotals;
}

const file = () => path.join(getDataDir(), 'ai.json');
let cache: Stored | null = null;
const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD, local time
const emptyUsage = (): AiUsageTotals => ({ day: today(), requestsToday: 0, inputTokens: 0, outputTokens: 0, requests: 0 });

function load(): Stored {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Stored>;
    cache = { settings: { ...DEFAULT_AI, ...raw.settings }, key: raw.key, usage: { ...emptyUsage(), ...raw.usage } };
  } catch {
    cache = { settings: { ...DEFAULT_AI }, usage: emptyUsage() };
  }
  return cache;
}

function save() {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(load(), null, 2), { mode: 0o600 });
}

function apiKey(): string | undefined {
  const s = load();
  if (!s.key) return undefined;
  const d = decodeSecret(s.key);
  if (d.legacy) {
    s.key = encodeSecret(d.value); // migrate to the current keychain key
    save();
  }
  return d.value;
}

export function aiState(): AiState {
  const s = load();
  if (s.usage.day !== today()) s.usage = { ...s.usage, day: today(), requestsToday: 0 };
  return { settings: s.settings, hasKey: !!s.key, usage: s.usage };
}

/** `key`: undefined keeps the stored key, '' removes it. */
export function saveAiSettings(patch: Partial<AiSettings>, key?: string): AiState {
  const s = load();
  const next: AiSettings = { ...s.settings, ...patch };
  if (next.provider !== 'anthropic' && next.provider !== 'openai-compatible') throw new HttpError(400, 'Unknown provider');
  if (!next.model?.trim()) throw new HttpError(400, 'Model is required');
  next.model = next.model.trim();
  const [minTok, maxTok] = AI_LIMITS.maxOutputTokens;
  if (!Number.isInteger(next.maxOutputTokens) || next.maxOutputTokens < minTok || next.maxOutputTokens > maxTok) {
    throw new HttpError(400, `Max output tokens must be ${minTok}–${maxTok}`);
  }
  const [minReq, maxReq] = AI_LIMITS.dailyRequestLimit;
  if (!Number.isInteger(next.dailyRequestLimit) || next.dailyRequestLimit < minReq || next.dailyRequestLimit > maxReq) {
    throw new HttpError(400, `Daily request limit must be ${minReq}–${maxReq}`);
  }
  if (!['low', 'medium', 'high'].includes(next.effort)) next.effort = 'medium';
  if (next.provider === 'openai-compatible') next.baseUrl = checkBaseUrl(next.baseUrl);
  s.settings = next;
  if (key !== undefined) s.key = key.trim() ? encodeSecret(key.trim()) : undefined;
  save();
  return aiState();
}

/** Keys travel in a header, so anything that leaves this machine must use HTTPS. */
function checkBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HttpError(400, 'Base URL is not a valid URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new HttpError(400, 'Base URL must use https:// (plain http is only allowed for localhost)');
  }
  return u.toString().replace(/\/+$/, '');
}

// ---------------------------------------------------------------- prompts

const DIALECT: Record<DbKind, string> = {
  sqlite: 'SQLite',
  postgres: 'PostgreSQL',
  mysql: 'MySQL / MariaDB',
  mssql: 'Microsoft SQL Server (T-SQL)',
};

const MAX_SCHEMA_CHARS = 60_000;

function tableName(t: { schema?: string; name: string }) {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

function describeTable(t: TableInfo): string {
  const cols = t.columns.map((c) => {
    const flags = [c.isPrimaryKey && 'PK', c.isIdentity && 'identity', !c.nullable && !c.isPrimaryKey && 'NOT NULL'].filter(Boolean);
    return `  ${c.name} ${c.type}${flags.length ? ' ' + flags.join(' ') : ''}`;
  });
  const fks = t.foreignKeys.map((f) => `  FK (${f.columns.join(', ')}) -> ${tableName({ schema: f.refSchema, name: f.refTable })}(${f.refColumns.join(', ')})`);
  const idx = t.indexes.filter((i) => !i.primary).map((i) => `  ${i.unique ? 'UNIQUE ' : ''}INDEX ${i.name} (${i.columns.join(', ')})`);
  return `${t.type === 'view' ? 'VIEW' : 'TABLE'} ${tableName(t)}${t.rowCount != null ? ` -- ~${t.rowCount} rows` : ''}\n${[...cols, ...fks, ...idx].join('\n')}`;
}

/**
 * Compact schema text for the system prompt. Very large schemas keep full detail for the
 * tables the request mentions (and their neighbours) and list the rest by name only.
 */
export function schemaContext(s: SchemaSnapshot, hint: string): string {
  const full = s.tables.map(describeTable).join('\n\n');
  if (full.length <= MAX_SCHEMA_CHARS) return full;
  const words = new Set(hint.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
  const picked = new Set(s.tables.filter((t) => words.has(t.name.toLowerCase())));
  for (const t of [...picked]) {
    for (const f of t.foreignKeys) s.tables.filter((x) => x.name === f.refTable).forEach((x) => picked.add(x));
    s.tables.filter((x) => x.foreignKeys.some((f) => f.refTable === t.name)).forEach((x) => picked.add(x));
  }
  let out = '';
  for (const t of picked) {
    const d = describeTable(t);
    if (out.length + d.length > MAX_SCHEMA_CHARS) break;
    out += d + '\n\n';
  }
  const rest = s.tables.filter((t) => !picked.has(t)).map(tableName);
  return `${out}-- Other tables (columns omitted, ask for them by name): ${rest.join(', ')}`.slice(0, MAX_SCHEMA_CHARS * 1.2);
}

function systemRules(kind: DbKind, database: string): string {
  return [
    `You are the SQL assistant inside SQL Graphic Tool, a database management tool. The user is connected to a ${DIALECT[kind]} database named "${database}".`,
    `Write SQL for ${DIALECT[kind]} only, using the exact table and column names from the schema below. If something the user asks for is not in the schema, say so instead of inventing names.`,
    'Put SQL in a single ```sql code block. Keep explanations short and concrete.',
    'Your SQL is shown to the user in an editor; it is never run automatically. For statements that change data or structure, mention what they will change.',
    'You only see the schema (names and types), never the data in the tables.',
  ].join('\n');
}

function taskPrompt(r: AiRequest): string {
  const sql = r.sql?.trim() ? `\n\n\`\`\`sql\n${r.sql.trim().slice(0, 50_000)}\n\`\`\`` : '';
  const ask = r.prompt?.trim().slice(0, 20_000) ?? '';
  switch (r.task) {
    case 'generate':
      return `Write a query for this request:\n${ask}`;
    case 'explain':
      return `Explain what this query does, step by step, and point out anything surprising.${sql}`;
    case 'optimize':
      return `Suggest how to make this query faster on this schema (rewrites and indexes). Show the improved SQL.${sql}${ask ? `\n\nContext: ${ask}` : ''}`;
    case 'fix':
      return `This query failed with the error below. Explain the cause and give the corrected SQL.${sql}\n\nError:\n${(r.error ?? '').slice(0, 5_000)}`;
    case 'chat':
      return ask + sql;
  }
}

function conversation(r: AiRequest): AiMessage[] {
  const history = (r.history ?? [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 20_000) }));
  // Both providers expect the conversation to start with a user turn.
  while (history[0]?.role === 'assistant') history.shift();
  return [...history, { role: 'user', content: taskPrompt(r) }];
}

export function extractSql(text: string): string | undefined {
  const m = text.match(/```(?:sql|tsql|postgresql|mysql|sqlite)?[ \t]*\r?\n([\s\S]*?)```/i);
  return m?.[1]?.trim() || undefined;
}

// ---------------------------------------------------------------- providers

interface Completion {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  fallbackModel?: string;
  truncated: boolean;
}

const TIMEOUT_MS = 180_000;

/** Effort and server-side fallbacks exist on the Claude 5 generation; older models reject them. */
const isClaude5 = (model: string) => /^claude-(opus|sonnet|fable)-5/.test(model);

async function callAnthropic(st: AiSettings, key: string, system: string, schema: string, messages: AiMessage[]): Promise<Completion> {
  const client = new Anthropic({ apiKey: key, timeout: TIMEOUT_MS, maxRetries: 2 });
  const modern = isClaude5(st.model);
  const stream = client.beta.messages.stream({
    model: st.model,
    max_tokens: st.maxOutputTokens,
    // The schema is the large, stable part of every request: cache it.
    system: [
      { type: 'text', text: system },
      { type: 'text', text: `Schema:\n${schema}`, cache_control: { type: 'ephemeral' } },
    ],
    messages,
    ...(modern
      ? {
          output_config: { effort: st.effort },
          // If the requested model declines, Anthropic re-runs the request on its recommended fallback model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default' as const,
        }
      : {}),
  });
  const msg = await stream.finalMessage();
  const text = msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (msg.stop_reason === 'refusal') {
    throw new CodedError('AI_REFUSED', 'The model declined this request. Try rephrasing it.');
  }
  const fellBack = (msg.usage.iterations ?? []).some((i) => i.type === 'fallback_message');
  return {
    text,
    model: msg.model,
    inputTokens: (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
    outputTokens: msg.usage.output_tokens ?? 0,
    cachedInputTokens: msg.usage.cache_read_input_tokens ?? 0,
    fallbackModel: fellBack ? msg.model : undefined,
    truncated: msg.stop_reason === 'max_tokens',
  };
}

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

async function callOpenAiCompatible(st: AiSettings, key: string | undefined, system: string, schema: string, messages: AiMessage[]): Promise<Completion> {
  const url = `${checkBaseUrl(st.baseUrl)}/chat/completions`;
  const send = async (tokenField: 'max_tokens' | 'max_completion_tokens') => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: st.model,
        messages: [{ role: 'system', content: `${system}\n\nSchema:\n${schema}` }, ...messages],
        [tokenField]: st.maxOutputTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as ChatCompletion;
    return { res, body };
  };
  let { res, body } = await send('max_tokens');
  // Newer OpenAI models only accept max_completion_tokens.
  if (res.status === 400 && /max_completion_tokens/.test(JSON.stringify(body.error ?? ''))) ({ res, body } = await send('max_completion_tokens'));
  if (!res.ok) {
    const detail = typeof body.error === 'string' ? body.error : body.error?.message;
    throw new HttpError(res.status === 401 || res.status === 403 ? 401 : 502, providerError(res.status, detail));
  }
  const choice = body.choices?.[0];
  return {
    text: choice?.message?.content ?? '',
    model: body.model ?? st.model,
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
    truncated: choice?.finish_reason === 'length',
  };
}

function providerError(status: number, detail?: string): string {
  const what =
    status === 401 || status === 403
      ? 'The API key was rejected'
      : status === 404
        ? 'Model or endpoint not found'
        : status === 429
          ? 'Rate limit or quota reached at the provider'
          : `The provider returned HTTP ${status}`;
  return detail ? `${what}: ${detail.slice(0, 300)}` : what;
}

function anthropicError(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new HttpError(401, 'The Anthropic API key was rejected');
  if (e instanceof Anthropic.RateLimitError) return new HttpError(429, 'Anthropic rate limit reached — try again in a moment');
  if (e instanceof Anthropic.NotFoundError) return new HttpError(404, 'Model not found — check the model name');
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new HttpError(504, 'The request to Anthropic timed out');
  if (e instanceof Anthropic.APIConnectionError) return new HttpError(502, 'Could not reach the Anthropic API');
  if (e instanceof Anthropic.APIError) return new HttpError(502, providerError(e.status ?? 0, e.message));
  return e as Error;
}

// ---------------------------------------------------------------- entry point

export async function askAi(r: AiRequest, schema: SchemaSnapshot): Promise<AiResponse> {
  const s = load();
  const st = s.settings;
  const cfg = getConnection(r.connId);
  if (!cfg) throw new HttpError(404, 'Connection not found');
  if (!['generate', 'explain', 'optimize', 'fix', 'chat'].includes(r.task)) throw new HttpError(400, 'Unknown task');
  if ((r.task === 'generate' || r.task === 'chat') && !r.prompt?.trim()) throw new HttpError(400, 'Write a question first');
  if ((r.task === 'explain' || r.task === 'optimize' || r.task === 'fix') && !r.sql?.trim()) throw new HttpError(400, 'The editor is empty');

  const key = apiKey();
  const preset = AI_PRESETS.find((p) => p.id === st.preset);
  if (st.provider === 'anthropic' && !key) throw new CodedError('AI_NOT_CONFIGURED', 'Add an Anthropic API key in AI settings');
  if (st.provider === 'openai-compatible' && !st.baseUrl) throw new CodedError('AI_NOT_CONFIGURED', 'Set the provider base URL in AI settings');
  if (st.provider === 'openai-compatible' && preset?.needsKey && !key) throw new CodedError('AI_NOT_CONFIGURED', `Add a ${preset.label} API key in AI settings`);

  // Spending guard: count the request before sending it, so failures cannot be retried without bound.
  aiState();
  if (st.dailyRequestLimit > 0 && s.usage.requestsToday >= st.dailyRequestLimit) {
    throw new CodedError('AI_LIMIT', `Daily AI request limit reached (${st.dailyRequestLimit}). Change it in AI settings.`);
  }
  s.usage.requestsToday++;
  s.usage.requests++;
  save();

  const system = systemRules(cfg.kind, r.database);
  const context = schemaContext(schema, `${r.prompt ?? ''} ${r.sql ?? ''}`);
  const messages = conversation(r);
  const started = performance.now();
  let out: Completion;
  try {
    out =
      st.provider === 'anthropic'
        ? await callAnthropic(st, key!, system, context, messages)
        : await callOpenAiCompatible(st, key, system, context, messages);
  } catch (e) {
    if (e instanceof CodedError || e instanceof HttpError) throw e;
    if (st.provider === 'anthropic') throw anthropicError(e);
    const err = e as Error;
    if (err.name === 'TimeoutError') throw new HttpError(504, 'The AI provider did not answer in time');
    throw new HttpError(502, `Could not reach ${st.baseUrl} — is the server running?`);
  }
  s.usage.inputTokens += out.inputTokens;
  s.usage.outputTokens += out.outputTokens;
  save();
  if (!out.text.trim()) throw new HttpError(502, 'The model returned an empty answer');
  return { ...out, sql: extractSql(out.text), durationMs: Math.round(performance.now() - started) };
}

/** Lists models from an OpenAI-compatible server (GET /models) to fill the model picker. */
export async function listAiModels(): Promise<string[]> {
  const st = load().settings;
  if (st.provider === 'anthropic') return AI_PRESETS[0].models;
  const key = apiKey();
  const res = await fetch(`${checkBaseUrl(st.baseUrl)}/models`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res?.ok) throw new HttpError(502, res ? providerError(res.status) : `Could not reach ${st.baseUrl}`);
  const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort();
}
