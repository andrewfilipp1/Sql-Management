import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Code2, Info, Pencil, Play, X, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useConnection, useStore } from '../lib/store';
import { Button, Field, Input, Modal, spring } from './ui';
import { SqlEditor } from './SqlEditor';

/** Every structural change goes through here: the user sees (and may edit) the exact SQL first. */
export function SqlConfirmDialog() {
  const req = useStore((s) => s.sqlRequest);
  const close = () => useStore.getState().confirmSql(null);
  const conn = useConnection(req?.connId ?? '');
  const toast = useStore((s) => s.toast);
  const [sql, setSql] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (req) {
      setSql(req.sql);
      setError(null);
    }
  }, [req]);

  const run = async () => {
    if (!req) return;
    setRunning(true);
    setError(null);
    try {
      // This dialog is the user's explicit review of the exact SQL, so it counts as confirmation.
      await api.query(req.connId, req.database, sql, { confirmed: true });
      toast('Executed successfully', 'success');
      req.onDone?.();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open={!!req}
      onClose={close}
      title={req?.title ?? ''}
      icon={req?.danger ? <AlertTriangle className="size-4 text-danger" /> : <Code2 className="size-4" />}
      width={680}
      footer={
        <>
          <span className="mr-auto text-xs text-faint">Review the SQL — you can edit it before running.</span>
          <Button onClick={close}>Cancel</Button>
          <Button variant={req?.danger ? 'danger' : 'primary'} icon={<Play className="size-3.5" />} loading={running} onClick={() => void run()}>
            Execute
          </Button>
        </>
      }
    >
      {conn?.environment === 'production' && (
        <p className="mb-3 flex items-center gap-2 rounded-lg border border-rose-400/40 bg-rose-500/15 p-2.5 text-[13px] font-medium text-rose-200">
          <AlertTriangle className="size-4 shrink-0" /> Production connection “{conn.name}”.
        </p>
      )}
      {req?.description && (
        <p className={req.danger ? 'mb-3 rounded-lg border border-rose-400/25 bg-rose-500/10 p-2.5 text-[13px] text-rose-200' : 'mb-3 text-[13px] text-muted'}>
          {req.description}
        </p>
      )}
      <div className="h-56 overflow-hidden rounded-xl border border-line bg-black/30">
        {conn && <SqlEditor value={sql} onChange={setSql} kind={conn.kind} onRun={() => void run()} />}
      </div>
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-3 overflow-hidden rounded-lg border border-rose-400/25 bg-rose-500/10 p-2.5 font-mono text-xs whitespace-pre-wrap text-rose-200"
          >
            {error}
          </motion.div>
        )}
      </AnimatePresence>
    </Modal>
  );
}

export function PromptDialog() {
  const req = useStore((s) => s.promptRequest);
  const closePrompt = useStore((s) => s.closePrompt);
  const [value, setValue] = useState('');
  useEffect(() => setValue(req?.initial ?? ''), [req]);

  const finish = (v: string | null) => {
    req?.resolve(v);
    closePrompt();
  };

  return (
    <Modal
      open={!!req}
      onClose={() => finish(null)}
      title={req?.title ?? ''}
      icon={<Pencil className="size-4" />}
      width={420}
      footer={
        <>
          <Button onClick={() => finish(null)}>Cancel</Button>
          <Button variant="primary" disabled={!value.trim()} onClick={() => finish(value.trim())}>
            OK
          </Button>
        </>
      }
    >
      <Field label={req?.label ?? ''}>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && value.trim() && finish(value.trim())}
          onFocus={(e) => e.target.select()}
        />
      </Field>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    // Top centre, under the tab bar: bottom-right toasts covered the diagram's Apply button.
    <div className="pointer-events-none fixed top-14 left-1/2 z-[70] flex w-[420px] max-w-[calc(100%-32px)] -translate-x-1/2 flex-col items-center gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: -24, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -16, scale: 0.95 }}
            transition={spring}
            className="glass-strong pointer-events-auto flex w-full items-start gap-2.5 rounded-xl p-3 shadow-[var(--shadow)]"
            style={{
              boxShadow:
                t.kind === 'error'
                  ? '0 0 0 1px rgb(251 113 133 / 0.35), 0 0 30px -10px rgb(251 113 133 / 0.7)'
                  : t.kind === 'success'
                    ? '0 0 0 1px rgb(52 211 153 / 0.3), 0 0 30px -10px rgb(52 211 153 / 0.6)'
                    : undefined,
            }}
          >
            {t.kind === 'error' ? (
              <XCircle className="mt-px size-4 shrink-0 text-danger" />
            ) : t.kind === 'success' ? (
              <CheckCircle2 className="mt-px size-4 shrink-0 text-ok" />
            ) : (
              <Info className="mt-px size-4 shrink-0 text-accent" />
            )}
            <div className="min-w-0 flex-1 text-[13px] break-words">{t.message}</div>
            <button onClick={() => dismiss(t.id)} className="text-faint hover:text-fg" aria-label="Dismiss">
              <X className="size-3.5" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
