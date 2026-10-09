import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Info, Wrench, X, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { Problem, Severity } from '../../lib/lint';
import { cn } from '../../lib/utils';
import { Button, IconButton, spring } from '../ui';

const ICON: Record<Severity, React.ReactNode> = {
  error: <XCircle className="size-4 text-danger" />,
  warning: <AlertTriangle className="size-4 text-warn" />,
  info: <Info className="size-4 text-sky-300" />,
};

export function ProblemsPanel({
  problems,
  onClose,
  onSelect,
  onFix,
}: {
  problems: Problem[];
  onClose(): void;
  onSelect(p: Problem): void;
  onFix(p: Problem): void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const shown = problems.filter((p) => showInfo || p.severity !== 'info');
  const infos = problems.filter((p) => p.severity === 'info').length;
  return (
    <motion.div
      initial={{ opacity: 0, x: 30 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 30 }}
      transition={spring}
      className="glass-strong absolute top-14 right-3 z-30 flex max-h-[70%] w-[380px] flex-col overflow-hidden rounded-2xl shadow-[var(--shadow)]"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <AlertTriangle className="size-4 text-warn" />
        <span className="flex-1 text-[13px] font-semibold">Problems</span>
        {infos > 0 && (
          <button className="text-[11px] text-muted hover:text-fg" onClick={() => setShowInfo((v) => !v)}>
            {showInfo ? 'Hide' : 'Show'} {infos} hint{infos === 1 ? '' : 's'}
          </button>
        )}
        <IconButton label="Close" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {!shown.length ? (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-[13px] text-muted">
            <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 400, damping: 12 }}>
              <CheckCircle2 className="size-8 text-ok drop-shadow-[0_0_12px_rgb(52_211_153)]" />
            </motion.span>
            No problems found.
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {shown.map((p, i) => (
              <motion.div
                key={p.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ ...spring, delay: Math.min(i * 0.02, 0.3) }}
                onClick={() => onSelect(p)}
                className={cn(
                  'mb-1.5 flex cursor-pointer gap-2.5 rounded-xl border px-3 py-2 hover:bg-white/[0.04]',
                  p.severity === 'error' ? 'border-rose-400/30 bg-rose-500/5' : p.severity === 'warning' ? 'border-amber-400/20' : 'border-line',
                )}
              >
                <span className="mt-0.5">{ICON[p.severity]}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-medium">{p.title}</div>
                  {p.detail && <div className="mt-0.5 text-[11.5px] text-muted">{p.detail}</div>}
                  <div className="mt-1 flex items-center gap-2 text-[10.5px] text-faint">
                    <span className="font-mono">{p.table}</span>
                    {p.draft && <span className="rounded bg-emerald-400/15 px-1 text-emerald-200">in your changes</span>}
                  </div>
                </div>
                {p.fix && (
                  <Button
                    size="sm"
                    icon={<Wrench className="size-3" />}
                    onClick={(e) => {
                      e.stopPropagation();
                      onFix(p);
                    }}
                  >
                    {p.fix.label}
                  </Button>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
    </motion.div>
  );
}
