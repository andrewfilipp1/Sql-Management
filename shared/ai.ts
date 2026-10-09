/** AI assistant: provider settings, requests and presets shared by the main process and the UI. */

export type AiProviderKind = 'anthropic' | 'openai-compatible';
export type AiEffort = 'low' | 'medium' | 'high';
export type AiTask = 'generate' | 'explain' | 'optimize' | 'fix' | 'chat';

export interface AiSettings {
  provider: AiProviderKind;
  /** Which preset the user picked (only used to pre-fill the form). */
  preset: string;
  model: string;
  /** OpenAI-compatible providers only (Ollama, Gemini, Groq, OpenRouter, OpenAI…). */
  baseUrl: string;
  /** Hard cap on output tokens per request. */
  maxOutputTokens: number;
  /** Claude only: how much the model thinks before answering. */
  effort: AiEffort;
  /** Requests allowed per day before the assistant refuses (0 = no limit). */
  dailyRequestLimit: number;
}

/** What the renderer sees: the key itself never leaves the main process. */
export interface AiState {
  settings: AiSettings;
  hasKey: boolean;
  usage: AiUsageTotals;
}

export interface AiUsageTotals {
  /** Local date (YYYY-MM-DD) the counters below belong to. */
  day: string;
  requestsToday: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  connId: string;
  database: string;
  task: AiTask;
  /** The user's question / instruction. */
  prompt?: string;
  /** SQL the task is about (explain / optimize / fix). */
  sql?: string;
  /** Database error for the "fix" task. */
  error?: string;
  /** Earlier turns of a chat. */
  history?: AiMessage[];
}

export interface AiResponse {
  text: string;
  /** First ```sql block of the answer, if any. Never executed automatically. */
  sql?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** Claude: another model answered after the requested one declined. */
  fallbackModel?: string;
  /** The answer was cut at the token cap. */
  truncated: boolean;
  durationMs: number;
}

export interface AiPreset {
  id: string;
  label: string;
  provider: AiProviderKind;
  baseUrl: string;
  models: string[];
  needsKey: boolean;
  /** Short, factual note shown under the preset. */
  note: string;
  keyUrl?: string;
}

export const AI_PRESETS: AiPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    provider: 'anthropic',
    baseUrl: '',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
    needsKey: true,
    note: 'Paid API, billed per token by Anthropic.',
    keyUrl: 'https://platform.claude.com/settings/keys',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5-coder:7b', 'llama3.1:8b'],
    needsKey: false,
    note: 'Free and offline: models run on this computer. Install Ollama and pull a model first.',
    keyUrl: 'https://ollama.com/download',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    provider: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash'],
    needsKey: true,
    note: 'Has a free tier with rate limits. On the free tier Google may use prompts to improve its products.',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'groq',
    label: 'Groq',
    provider: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile'],
    needsKey: true,
    note: 'Has a free tier with rate limits.',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    provider: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [],
    needsKey: true,
    note: 'Gateway to many models; some are free (ids ending in “:free”).',
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    models: [],
    needsKey: true,
    note: 'Paid API, billed per token by OpenAI.',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'custom',
    label: 'Other OpenAI-compatible',
    provider: 'openai-compatible',
    baseUrl: '',
    models: [],
    needsKey: false,
    note: 'Any server that implements POST /chat/completions (LM Studio, vLLM, LiteLLM…).',
  },
];

export const DEFAULT_AI: AiSettings = {
  provider: 'anthropic',
  preset: 'anthropic',
  model: 'claude-opus-5-5',
  baseUrl: '',
  maxOutputTokens: 4096,
  effort: 'medium',
  dailyRequestLimit: 200,
};

export const AI_LIMITS = { maxOutputTokens: [256, 32_000] as const, dailyRequestLimit: [0, 10_000] as const };
