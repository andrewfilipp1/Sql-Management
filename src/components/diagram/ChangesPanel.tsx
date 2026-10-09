import { AnimatePresence, motion } from 'motion/react';
import { Ban, CheckCircle2, Code2, Loader2, Play, Redo2, ShieldAlert, Trash2, Undo2, X, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { DbKind } from '../../../shared/types';
import type { Step } from '../../lib/designer';
import { cn } from '../../lib/utils';
import { SqlEditor } from '../SqlEditor';
import { Button, IconButton, spring } from '../ui';

export type StepStatus = 'running' | 'done' | 'failed';

interface Props {
  kind: DbKind;
  steps: Step[];
  status: Record<number, StepStatus>;
  blockingErrors: number;
  applying: boolean;
  production: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onRemove(step: Step): void;
  onDiscard(): void;
  onApply(): void;
  onShowProblems(): void;
}

export function ChangesPanel(p: Props) {
  const [showSql, setShowSql] = useState(false);
  const [confirmProd, setConfirmProd] = useState(false);
  const script = p.steps.map((s) => `-- ${s.label}\n${s.sql ?? '-- (not supported by this database)'}`).join(p.kind === 'mssql' ? '\nGO\n\n' : '\n\n');

  return (
    <motion.div
      initial={{ opacity: 0, y: 30, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 30 }}
      transition={spring}
      className="glass-strong absolute bottom-3 left-1/2 z-20 w-[min(560px,calc(100%-24px))] -translate-x-1/2 overflow-hidden rounded-2xl shadow-[var(--shadow)]"
      style={{ boxShadow: '0 0 0 1px rgb(52 211 153 / 0.35), 0 0 40px -14px rgb(52 211 153 / 0.6), var(--shadow)' }}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="relative flex size-2.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex size-2.5 rounded-full bg-emerald-400" />
        </span>
        <span className="flex-1 text-[13px] font-semibold">
          {p.steps.length} pending change{p.steps.length === 1 ? '' : 's'}
        </span>
        <IconButton label="Undo (⌘Z)" disabled={!p.canUndo || p.applying} onClick={p.onUndo}>
          <Undo2 className="size-4" />
        </IconButton>
        <IconButton label="Redo (⇧⌘Z)" disabled={!p.canRedo || p.applying} onClick={p.onRedo}>
          <Redo2 className="size-4" />
        </IconButton>
        <IconButton label={showSql ? 'Hide SQL' : 'Show SQL'} active={showSql} onClick={() => setShowSql((v) => !v)}>
          <Code2 className="size-4" />
        </IconButton>
      </div>

      <div className="max-h-48 overflow-auto px-2 py-1.5">
        <AnimatePresence initial={false}>
          {p.steps.map((s, i) => {
            const st = p.status[i];
            return (
              <motion.div
                key={`${s.label}-${s.ops.join(',')}`}
                layout
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20, height: 0 }}
                transition={spring}
                className={cn(
                  'group flex items-center gap-2 rounded-lg px-2 py-1 text-[12.5px]',
                  st === 'failed' && 'bg-rose-500/15',
                  st === 'done' && 'text-emerald-200',
                  s.sql === null && 'text-rose-200',
                )}
              >
                <span className="flex w-4 justify-center">
                  {st === 'running' ? (
                    <Loader2 className="size-3.5 animate-spin text-accent" />
                  ) : st === 'done' ? (
                    <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 14 }}>
                      <CheckCircle2 className="size-3.5 text-ok" />
                    </motion.span>
                  ) : st === 'failed' ? (
                    <XCircle className="size-3.5 text-danger" />
                  ) : s.sql === null ? (
                    <Ban className="size-3.5 text-danger" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-emerald-400/70" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                {!p.applying && (
                  <button
                    className="hidden size-5 items-center justify-center rounded text-faint group-hover:flex hover:bg-white/10 hover:text-fg"
                    title="Remove this change"
                    aria-label="Remove this change"
                    onClick={() => p.onRemove(s)}
                  >
                    <X className="size-3" />
                  </button>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {showSql && (
          <motion.div initial={{ height: 0 }} animate={{ height: 180 }} exit={{ height: 0 }} transition={spring} className="overflow-hidden border-t border-line bg-black/30">
            <SqlEditor value={script} kind={p.kind} readOnly minimal />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex items-center gap-2 border-t border-line px-3 py-2">
        {p.blockingErrors > 0 ? (
          <button onClick={p.onShowProblems} className="mr-auto flex items-center gap-1.5 text-[12px] text-rose-300 hover:underline">
            <XCircle className="size-3.5" /> Fix {p.blockingErrors} problem{p.blockingErrors === 1 ? '' : 's'} before applying
          </button>
        ) : (
          <span className="mr-auto text-[11.5px] text-faint">Nothing has been changed in the database yet.</span>
        )}
        <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={p.applying} onClick={p.onDiscard}>
          Discard
        </Button>
        {p.production && !confirmProd ? (
          <Button size="sm" variant="danger" icon={<ShieldAlert className="size-3.5" />} disabled={p.applying || p.blockingErrors > 0 || !p.steps.length} onClick={() => setConfirmProd(true)}>
            Apply to production…
          </Button>
        ) : (
          <Button
            size="sm"
            variant={p.production ? 'danger' : 'primary'}
            icon={<Play className="size-3.5" />}
            loading={p.applying}
            disabled={p.blockingErrors > 0 || !p.steps.length}
            onClick={() => {
              setConfirmProd(false);
              p.onApply();
            }}
          >
            {p.production ? 'Yes, apply to production' : `Apply ${p.steps.length}`}
          </Button>
        )}
      </div>
    </motion.div>
  );
}
