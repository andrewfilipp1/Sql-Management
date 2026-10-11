import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpCircle, Bell, ChevronDown, ExternalLink, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { RELEASES_URL, type UpdateState } from '../../shared/update';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { cn } from '../lib/utils';
import { Button, IconButton, Modal, spring } from './ui';

/** Live update state from the main process. */
function useUpdateState() {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    api.updateState().then(setState, () => undefined);
    return window.schemascope?.onUpdate(setState);
  }, []);
  return [state, setState] as const;
}

/** A newer version is known and waiting for the user (downloaded or not yet). */
function hasUpdate(s: UpdateState | null): s is UpdateState & { version: string } {
  return !!s?.version && (s.phase === 'available' || s.phase === 'downloading' || s.phase === 'ready' || s.phase === 'error');
}

/**
 * Notification bell in the sidebar header. An available update waits here until the user clicks
 * "Update now"; the download happens quietly beforehand, so the click only restarts the app.
 */
export function NotificationBell() {
  const [state] = useUpdateState();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const announced = useRef<string | null>(null);
  const pending = hasUpdate(state);

  // Announce each new version once per session; the bell keeps it afterwards.
  useEffect(() => {
    if (pending && announced.current !== state.version) {
      announced.current = state.version;
      useStore.getState().toast(`SQL Graphic Tool ${state.version} is available. Open the bell to update.`, 'info');
    }
  }, [pending, state?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <div ref={ref} className="no-drag relative">
      <IconButton label={pending ? `Notifications: update ${state.version} available` : 'Notifications'} active={open} onClick={() => setOpen((o) => !o)} data-testid="bell">
        <motion.span
          animate={pending && !open ? { rotate: [0, -14, 12, -8, 6, 0] } : { rotate: 0 }}
          transition={pending && !open ? { duration: 0.9, repeat: Infinity, repeatDelay: 6 } : spring}
          className="inline-flex"
        >
          <Bell className="size-4" />
        </motion.span>
        <AnimatePresence>
          {pending && (
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={spring}
              className="absolute top-1 right-1 size-2 rounded-full bg-rose-400 shadow-[0_0_8px_rgb(251_113_133/0.9)] ring-2 ring-[#0b0e1a]"
              data-testid="bell-badge"
            />
          )}
        </AnimatePresence>
      </IconButton>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            style={{ transformOrigin: 'top left' }}
            className="absolute top-9 left-0 z-[60] w-[320px] rounded-xl border border-line bg-[#0e1120] p-2 shadow-[var(--shadow)]"
            data-testid="bell-panel"
          >
            <div className="px-2 pt-1 pb-2 text-[11px] font-semibold tracking-wider text-muted uppercase">Notifications</div>
            {!pending ? (
              <div className="px-2 pb-3 text-[13px] text-muted">Nothing new. You have the latest version{state ? ` (${state.currentVersion})` : ''}.</div>
            ) : (
              <div className="rounded-lg bg-accent-soft/50 p-3 ring-1 ring-accent/30">
                <div className="flex items-start gap-2.5">
                  <ArrowUpCircle className="mt-0.5 size-4 shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium">Version {state.version} is available</div>
                    <div className="text-xs text-muted">
                      You have {state.currentVersion}.{' '}
                      {state.installing
                        ? 'Updating — the app will restart…'
                        : state.phase === 'ready'
                          ? 'Downloaded and ready; updating takes a few seconds.'
                          : state.phase === 'downloading'
                            ? `Downloading in the background (${state.percent ?? 0}%).`
                            : state.phase === 'error'
                              ? <span className="text-warn">{state.error}</span>
                              : ''}
                    </div>
                  </div>
                </div>
                {state.phase === 'downloading' && !state.installing && (
                  <div className="mt-2 ml-6.5 h-1 overflow-hidden rounded-full bg-white/10">
                    <motion.div className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-cyan-400" animate={{ width: `${state.percent ?? 0}%` }} transition={spring} />
                  </div>
                )}
                {state.notes && (
                  <button onClick={() => setNotes((n) => !n)} className="mt-2 ml-6.5 flex items-center gap-1 text-xs text-accent hover:underline">
                    What’s new <ChevronDown className={cn('size-3 transition-transform', notes && 'rotate-180')} />
                  </button>
                )}
                {notes && state.notes && (
                  <pre className="mt-1.5 ml-6.5 max-h-40 overflow-auto rounded-md border border-line bg-black/20 p-2 font-sans text-[11.5px] whitespace-pre-wrap text-fg/85">{state.notes}</pre>
                )}
                <div className="mt-3 flex items-center justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                    Later
                  </Button>
                  {state.canInstall ? (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={state.installing ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                      disabled={state.installing}
                      onClick={() => void api.installUpdate()}
                      data-testid="bell-update"
                    >
                      {state.installing ? 'Updating…' : state.phase === 'error' ? 'Try again' : 'Update now'}
                    </Button>
                  ) : (
                    <Button size="sm" variant="primary" icon={<ExternalLink className="size-3.5" />} onClick={() => window.open(state.releaseUrl ?? RELEASES_URL, '_blank')}>
                      Download page
                    </Button>
                  )}
                </div>
                {!state.canInstall && state.installBlockedReason && <p className="mt-2 text-[11.5px] text-muted">{state.installBlockedReason}</p>}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Version in the status bar; opens update details and "Check now". */
export function UpdateIndicator() {
  const [state, setState] = useUpdateState();
  const [open, setOpen] = useState(false);
  if (!state) return <span>SQL Graphic Tool</span>;

  const pending = hasUpdate(state);
  const run = (p: Promise<UpdateState>) => p.then(setState, () => undefined);

  return (
    <>
      <button onClick={() => setOpen(true)} className={cn('hover:text-fg', pending && 'text-accent')} title="Updates">
        SQL Graphic Tool {state.currentVersion}
        {pending && ` → ${state.version}`}
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={pending ? `SQL Graphic Tool ${state.version} is available` : 'Updates'}
        icon={<ArrowUpCircle className="size-4" />}
        width={520}
        footer={
          <>
            <Button variant="ghost" icon={<RefreshCw className="size-3.5" />} disabled={state.phase === 'disabled' || state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'ready'} loading={state.phase === 'checking'} onClick={() => run(api.checkForUpdates())}>
              Check now
            </Button>
            <div className="flex-1" />
            {pending && state.canInstall && (
              <Button variant="primary" icon={<RotateCcw className="size-3.5" />} loading={state.installing} onClick={() => void api.installUpdate()}>
                Update now
              </Button>
            )}
            {pending && !state.canInstall && (
              <Button variant="primary" icon={<ExternalLink className="size-3.5" />} onClick={() => window.open(state.releaseUrl ?? RELEASES_URL, '_blank')}>
                Open download page
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-3 text-[13px]">
          <p className="text-muted">
            You have version <span className="text-fg">{state.currentVersion}</span>.{' '}
            {state.phase === 'disabled' && `Update checks are off (${state.disabledReason}).`}
            {state.phase === 'none' && 'This is the latest version.'}
            {state.phase === 'checking' && 'Checking GitHub Releases…'}
            {state.phase === 'idle' && 'Updates are published on GitHub Releases.'}
            {state.phase === 'ready' && 'The new version is downloaded. “Update now” restarts the app; your connections and settings stay as they are.'}
            {state.phase === 'downloading' && `Downloading in the background (${state.percent ?? 0}%).`}
            {state.phase === 'error' && <span className="text-warn">{state.error}</span>}
          </p>
          {pending && !state.canInstall && (
            <p className="text-xs text-muted">{state.installBlockedReason ?? 'This copy cannot update itself.'} Or download the new version and replace the app in Applications.</p>
          )}
          {pending && state.notes && <pre className="max-h-64 overflow-auto rounded-lg border border-line bg-black/20 p-3 font-sans text-xs whitespace-pre-wrap text-fg/85">{state.notes}</pre>}
          <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
            All releases <ExternalLink className="size-3" />
          </a>
        </div>
      </Modal>
    </>
  );
}
