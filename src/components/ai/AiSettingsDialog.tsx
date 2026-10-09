import { motion } from 'motion/react';
import { ExternalLink, KeyRound, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AI_PRESETS, type AiSettings, type AiState } from '../../../shared/ai';
import { api } from '../../lib/api';
import { useStore } from '../../lib/store';
import { formatNumber } from '../../lib/utils';
import { Badge, Button, Field, Input, Modal, Select, spring } from '../ui';

export function AiSettingsDialog() {
  const open = useStore((s) => s.aiSettingsOpen);
  const close = () => useStore.getState().openAiSettings(false);
  const [state, setState] = useState<AiState | null>(null);
  const [draft, setDraft] = useState<AiSettings | null>(null);
  /** undefined = keep the stored key. */
  const [key, setKey] = useState<string | undefined>(undefined);
  const [models, setModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKey(undefined);
    setModels([]);
    api.aiState().then(
      (s) => (setState(s), setDraft(s.settings)),
      (e: Error) => useStore.getState().toast(e.message, 'error'),
    );
  }, [open]);

  const preset = AI_PRESETS.find((p) => p.id === draft?.preset) ?? AI_PRESETS[0];
  const set = (patch: Partial<AiSettings>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const choosePreset = (id: string) => {
    const p = AI_PRESETS.find((x) => x.id === id)!;
    set({ preset: p.id, provider: p.provider, baseUrl: p.baseUrl, model: p.models[0] ?? '' });
    setModels([]);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const s = await api.saveAiSettings(draft, key);
      setState(s);
      setKey(undefined);
      useStore.getState().toast('AI settings saved', 'success');
      close();
    } catch (e) {
      useStore.getState().toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  // Lists models from the provider using the settings as saved, so save first.
  const fetchModels = async () => {
    if (!draft) return;
    setLoadingModels(true);
    try {
      setState(await api.saveAiSettings(draft, key));
      setKey(undefined);
      const list = await api.aiModels();
      setModels(list);
      if (!list.length) useStore.getState().toast('The provider returned no models', 'info');
    } catch (e) {
      useStore.getState().toast((e as Error).message, 'error');
    } finally {
      setLoadingModels(false);
    }
  };

  const modelOptions = [...new Set([...(preset.models ?? []), ...models])];
  const anthropic = draft?.provider === 'anthropic';

  return (
    <Modal
      open={open}
      onClose={close}
      title="AI assistant"
      icon={<Sparkles className="size-4" />}
      width={600}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!draft} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      {draft && state && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {AI_PRESETS.map((p) => (
              <motion.button
                key={p.id}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                transition={spring}
                onClick={() => choosePreset(p.id)}
                className={
                  'rounded-xl border px-3 py-2 text-left transition-colors ' +
                  (draft.preset === p.id ? 'border-accent/60 bg-accent-soft shadow-[0_0_20px_-8px_rgb(129_140_248/0.9)]' : 'border-line bg-white/[0.02] hover:border-white/20')
                }
              >
                <div className="flex items-center gap-1.5 text-[13px] font-medium">
                  {p.label}
                  {!p.needsKey && p.id !== 'custom' && <Badge tone="ok">no key</Badge>}
                </div>
              </motion.button>
            ))}
          </div>

          <p className="flex items-start gap-2 rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-xs text-muted">
            <span className="flex-1">{preset.note}</span>
            {preset.keyUrl && (
              <a href={preset.keyUrl} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 text-accent hover:underline">
                {preset.needsKey ? 'Get a key' : 'Download'} <ExternalLink className="size-3" />
              </a>
            )}
          </p>

          {!anthropic && (
            <Field label="Base URL" hint="The server must implement POST /chat/completions. Remote servers need https://.">
              <Input value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://…/v1" spellCheck={false} />
            </Field>
          )}

          <Field
            label="API key"
            hint={
              <span className="flex items-center gap-1">
                <ShieldCheck className="size-3" /> Stored encrypted with the OS keychain and only used by the app's main process.
              </span>
            }
          >
            <div className="flex gap-2">
              <Input
                type="password"
                className="flex-1"
                icon={<KeyRound className="size-3.5" />}
                value={key ?? ''}
                onChange={(e) => setKey(e.target.value)}
                placeholder={state.hasKey ? '•••••••• saved — type to replace' : preset.needsKey ? 'Paste your key' : 'Not needed'}
                autoComplete="off"
              />
              {state.hasKey && (
                <Button variant="ghost" onClick={() => setKey('')} title="Remove the saved key when you press Save">
                  Remove
                </Button>
              )}
            </div>
            {key === '' && state.hasKey && <span className="text-[11px] text-warn">The saved key will be removed.</span>}
          </Field>

          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <Field label="Model">
              <Input value={draft.model} onChange={(e) => set({ model: e.target.value })} list="ai-models" spellCheck={false} />
              <datalist id="ai-models">
                {modelOptions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            {!anthropic && (
              <Button icon={<RefreshCw className="size-3.5" />} loading={loadingModels} onClick={() => void fetchModels()} title="Save and ask the provider for its models">
                Load models
              </Button>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="Max answer tokens" hint="Hard cap per request">
              <Input type="number" min={256} max={32000} value={draft.maxOutputTokens} onChange={(e) => set({ maxOutputTokens: Number(e.target.value) })} />
            </Field>
            <Field label="Requests per day" hint="0 = no limit">
              <Input type="number" min={0} max={10000} value={draft.dailyRequestLimit} onChange={(e) => set({ dailyRequestLimit: Number(e.target.value) })} />
            </Field>
            {anthropic ? (
              <Field label="Effort" hint="Higher = slower, more tokens">
                <Select value={draft.effort} onChange={(e) => set({ effort: e.target.value as AiSettings['effort'] })}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </Select>
              </Field>
            ) : (
              <div />
            )}
          </div>

          <div className="rounded-lg border border-line bg-white/[0.02] px-3 py-2.5 text-xs leading-relaxed text-muted">
            <div className="mb-1 font-medium text-fg">What is sent to the provider</div>
            Table, column, index and foreign-key names and types, approximate row counts, your question and the SQL in the editor. Row data is never sent. Answers are
            only shown and inserted into the editor — nothing runs until you press Run.
            {anthropic && (
              <div className="mt-1.5">
                Server-side fallback is on for Claude 5 models: if the chosen model declines a request, Anthropic retries it on its recommended
                fallback model (billed at that model's rates) and the answer is marked.
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-faint">
            <span>
              Today: {formatNumber(state.usage.requestsToday)}
              {draft.dailyRequestLimit ? ` / ${formatNumber(draft.dailyRequestLimit)}` : ''} requests
            </span>
            <span>All time: {formatNumber(state.usage.requests)} requests</span>
            <span>
              {formatNumber(state.usage.inputTokens)} in / {formatNumber(state.usage.outputTokens)} out tokens
            </span>
          </div>
        </div>
      )}
    </Modal>
  );
}
