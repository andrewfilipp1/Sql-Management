import { AnimatePresence, motion } from 'motion/react';
import { ArrowDownToLine, BookOpen, Check, Copy, Rocket, Send, Settings2, Sparkles, Trash2, Wrench, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AiMessage, AiResponse, AiTask } from '../../../shared/ai';
import { api, type ApiError } from '../../lib/api';
import { useStore } from '../../lib/store';
import { cn, formatMs } from '../../lib/utils';
import { Button, IconButton, spring } from '../ui';

interface Entry {
  id: number;
  role: 'user' | 'assistant' | 'error';
  /** Shown in the panel. */
  text: string;
  /** Sent as history on later turns (includes the SQL the turn was about). */
  context?: string;
  meta?: AiResponse;
  code?: string;
}

export interface AiTrigger {
  task: Exclude<AiTask, 'generate' | 'chat'>;
  nonce: number;
}

let seq = 0;

/** Chat-style assistant next to the SQL editor. Answers are text; SQL goes to the editor only when the user asks. */
export function AiPanel({
  connId,
  database,
  getSql,
  lastError,
  trigger,
  onUseSql,
  onClose,
}: {
  connId: string;
  database: string;
  getSql: () => string;
  lastError: string | null;
  trigger: AiTrigger | null;
  onUseSql: (sql: string, mode: 'replace' | 'append') => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries, busy]);

  const history = (): AiMessage[] =>
    entries.filter((e) => e.role !== 'error').map((e) => ({ role: e.role as 'user' | 'assistant', content: e.context ?? e.text }));

  const ask = async (task: AiTask, prompt?: string) => {
    if (busy) return;
    const sql = task === 'generate' || task === 'chat' ? undefined : getSql().trim();
    if (task !== 'generate' && task !== 'chat' && !sql) {
      useStore.getState().toast('The editor is empty', 'info');
      return;
    }
    const label: Record<AiTask, string> = {
      generate: prompt ?? '',
      chat: prompt ?? '',
      explain: 'Explain the query in the editor',
      optimize: 'How can this query be faster?',
      fix: 'Fix the error',
    };
    const context = sql ? `${label[task]}\n\n\`\`\`sql\n${sql}\n\`\`\`${task === 'fix' && lastError ? `\n\nError: ${lastError}` : ''}` : undefined;
    const previous = history();
    setEntries((xs) => [...xs, { id: ++seq, role: 'user', text: label[task], context }]);
    setBusy(true);
    try {
      const r = await api.ask({
        connId,
        database,
        task: task === 'generate' && previous.length ? 'chat' : task,
        prompt,
        sql,
        error: task === 'fix' ? (lastError ?? undefined) : undefined,
        history: previous,
      });
      setEntries((xs) => [...xs, { id: ++seq, role: 'assistant', text: r.text, meta: r }]);
    } catch (e) {
      const err = e as ApiError;
      setEntries((xs) => [...xs, { id: ++seq, role: 'error', text: err.message, code: err.code }]);
    } finally {
      setBusy(false);
    }
  };

  // Toolbar / error-box shortcuts from the query tab.
  useEffect(() => {
    if (trigger) void ask(trigger.task);
  }, [trigger?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    const q = input.trim();
    if (!q) return;
    setInput('');
    void ask('generate', q);
  };

  return (
    <motion.aside
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 380, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={spring}
      className="flex h-full shrink-0 flex-col overflow-hidden border-l border-line bg-black/20"
      data-testid="ai-panel"
    >
      <div className="flex min-w-[380px] items-center gap-2 border-b border-line px-3 py-2">
        <Sparkles className="size-4 text-accent" />
        <span className="flex-1 text-[13px] font-semibold">AI assistant</span>
        <IconButton label="Clear conversation" disabled={!entries.length || busy} onClick={() => setEntries([])}>
          <Trash2 className="size-3.5" />
        </IconButton>
        <IconButton label="AI settings" onClick={() => useStore.getState().openAiSettings(true)}>
          <Settings2 className="size-3.5" />
        </IconButton>
        <IconButton label="Close" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </div>

      <div className="flex min-w-[380px] gap-1.5 border-b border-line px-3 py-2">
        <Button size="sm" variant="ghost" icon={<BookOpen className="size-3.5" />} disabled={busy} onClick={() => void ask('explain')}>
          Explain
        </Button>
        <Button size="sm" variant="ghost" icon={<Rocket className="size-3.5" />} disabled={busy} onClick={() => void ask('optimize')}>
          Optimize
        </Button>
        <Button size="sm" variant="ghost" icon={<Wrench className="size-3.5" />} disabled={busy || !lastError} onClick={() => void ask('fix')} title={lastError ? 'Fix the last error' : 'No error to fix'}>
          Fix error
        </Button>
      </div>

      <div ref={scrollRef} className="min-h-0 min-w-[380px] flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {!entries.length && !busy && (
          <div className="space-y-2 px-1 pt-6 text-center text-xs text-muted">
            <Sparkles className="mx-auto size-6 text-accent/70" />
            <p>Ask for a query in plain words, e.g. “top 10 customers by revenue last month”.</p>
            <p className="text-faint">The assistant sees table and column names, not your data. Nothing runs until you press Run.</p>
          </div>
        )}
        <AnimatePresence initial={false}>
          {entries.map((e) => (
            <motion.div key={e.id} initial={{ opacity: 0, y: 10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={spring}>
              {e.role === 'user' ? (
                <div className="ml-8 rounded-xl rounded-br-sm bg-accent-soft px-3 py-2 text-[13px] whitespace-pre-wrap ring-1 ring-accent/25">{e.text}</div>
              ) : e.role === 'error' ? (
                <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100" data-testid="ai-error">
                  {e.text}
                  {(e.code === 'AI_NOT_CONFIGURED' || e.code === 'AI_LIMIT') && (
                    <button className="mt-1.5 block text-accent hover:underline" onClick={() => useStore.getState().openAiSettings(true)}>
                      Open AI settings
                    </button>
                  )}
                </div>
              ) : (
                <div className="mr-2 space-y-2 text-[13px] leading-relaxed" data-testid="ai-answer">
                  <Answer text={e.text} onUseSql={onUseSql} />
                  {e.meta && (
                    <div className="flex flex-wrap gap-x-2 text-[10.5px] text-faint">
                      <span>{e.meta.model}</span>
                      <span>{formatMs(e.meta.durationMs)}</span>
                      <span>
                        {e.meta.inputTokens}→{e.meta.outputTokens} tokens
                      </span>
                      {e.meta.fallbackModel && <span className="text-warn">answered by fallback model</span>}
                      {e.meta.truncated && <span className="text-warn">cut at the token limit</span>}
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
        {busy && <Thinking />}
      </div>

      <div className="min-w-[380px] border-t border-line p-2.5">
        <div className="flex items-end gap-2 rounded-xl border border-line bg-white/[0.03] px-2.5 py-2 focus-within:border-accent/50">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder="Describe the query you need…"
            className="max-h-32 min-h-[2.5rem] flex-1 resize-none bg-transparent text-[13px] outline-none placeholder:text-faint"
            data-testid="ai-input"
          />
          <IconButton label="Send (Enter)" disabled={busy || !input.trim()} onClick={submit}>
            <Send className="size-4" />
          </IconButton>
        </div>
      </div>
    </motion.aside>
  );
}

function Thinking() {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 px-1 text-xs text-muted" data-testid="ai-thinking">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="size-1.5 rounded-full bg-accent"
            animate={{ opacity: [0.25, 1, 0.25], y: [0, -3, 0] }}
            transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }}
          />
        ))}
      </span>
      Thinking…
    </motion.div>
  );
}

/** Renders the answer as plain text + code blocks. Never as HTML. */
function Answer({ text, onUseSql }: { text: string; onUseSql: (sql: string, mode: 'replace' | 'append') => void }) {
  const parts: ReactNode[] = [];
  const re = /```([a-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)(?:```|$)/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<Prose key={i++} text={text.slice(last, m.index)} />);
    parts.push(<CodeBlock key={i++} code={m[2].trimEnd()} lang={m[1]} onUseSql={onUseSql} />);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(<Prose key={i++} text={text.slice(last)} />);
  return <>{parts}</>;
}

function Prose({ text }: { text: string }) {
  const t = text.trim();
  if (!t) return null;
  // Inline `code` and **bold**, everything else as text.
  const bits = t.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  return (
    <p className="whitespace-pre-wrap text-fg/90">
      {bits.map((b, i) =>
        b.startsWith('`') && b.endsWith('`') && b.length > 2 ? (
          <code key={i} className="rounded bg-white/10 px-1 font-mono text-[12px] text-cyan-200">
            {b.slice(1, -1)}
          </code>
        ) : b.startsWith('**') && b.endsWith('**') && b.length > 4 ? (
          <strong key={i}>{b.slice(2, -2)}</strong>
        ) : (
          b
        ),
      )}
    </p>
  );
}

function CodeBlock({ code, lang, onUseSql }: { code: string; lang: string; onUseSql: (sql: string, mode: 'replace' | 'append') => void }) {
  const [copied, setCopied] = useState(false);
  const isSql = !lang || /sql/i.test(lang);
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-black/30">
      <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[12px] text-cyan-50">{code}</pre>
      <div className="flex gap-1 border-t border-line px-1.5 py-1">
        {isSql && (
          <>
            <button
              className={cn('flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent-soft')}
              onClick={() => onUseSql(code, 'replace')}
              data-testid="ai-use-sql"
            >
              <ArrowDownToLine className="size-3" /> Replace editor
            </button>
            <button className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-white/5 hover:text-fg" onClick={() => onUseSql(code, 'append')}>
              Append
            </button>
          </>
        )}
        <div className="flex-1" />
        <button
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-white/5 hover:text-fg"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <Check className="size-3 text-ok" /> : <Copy className="size-3" />} Copy
        </button>
      </div>
    </div>
  );
}
