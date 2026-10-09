import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpCircle, Download, ExternalLink, RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { RELEASES_URL, type UpdateState } from '../../shared/update';
import { api } from '../lib/api';
import { Button, Modal, spring } from './ui';

/** Version in the status bar; turns into a glowing pill when GitHub has a newer release. */
export function UpdateIndicator() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.updateState().then(setState, () => undefined);
    return window.schemascope?.onUpdate(setState);
  }, []);
  if (!state) return <span>SchemaScope</span>;

  const has = state.phase === 'available' || state.phase === 'downloading' || state.phase === 'ready';
  const run = (p: Promise<UpdateState>) => p.then(setState, () => undefined);

  return (
    <>
      <AnimatePresence mode="wait">
        {has ? (
          <motion.button
            key="update"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1, boxShadow: ['0 0 0px rgb(129 140 248 / 0)', '0 0 12px rgb(129 140 248 / 0.8)', '0 0 0px rgb(129 140 248 / 0)'] }}
            transition={{ ...spring, boxShadow: { duration: 2.4, repeat: Infinity } }}
            onClick={() => setOpen(true)}
            className="flex items-center gap-1 rounded-full bg-accent-soft px-2 text-accent ring-1 ring-accent/40"
            data-testid="update-pill"
          >
            <ArrowUpCircle className="size-3" />
            {state.phase === 'ready' ? 'Restart to update' : state.phase === 'downloading' ? `Downloading ${state.percent ?? 0}%` : `Update ${state.version}`}
          </motion.button>
        ) : (
          <motion.button key="version" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={() => setOpen(true)} className="hover:text-fg" title="Check for updates">
            SchemaScope {state.currentVersion}
          </motion.button>
        )}
      </AnimatePresence>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={has ? `SchemaScope ${state.version} is available` : 'Updates'}
        icon={<ArrowUpCircle className="size-4" />}
        width={520}
        footer={
          <>
            <Button variant="ghost" icon={<RefreshCw className="size-3.5" />} disabled={state.phase === 'disabled' || state.phase === 'checking' || state.phase === 'downloading'} loading={state.phase === 'checking'} onClick={() => run(api.checkForUpdates())}>
              Check now
            </Button>
            <div className="flex-1" />
            {state.phase === 'available' && state.canInstall && (
              <Button variant="primary" icon={<Download className="size-3.5" />} onClick={() => run(api.downloadUpdate())}>
                Download
              </Button>
            )}
            {state.phase === 'available' && !state.canInstall && (
              <Button variant="primary" icon={<ExternalLink className="size-3.5" />} onClick={() => window.open(state.releaseUrl ?? RELEASES_URL, '_blank')}>
                Open download page
              </Button>
            )}
            {state.phase === 'ready' && (
              <Button variant="primary" icon={<RotateCcw className="size-3.5" />} onClick={() => void api.installUpdate()}>
                Restart and install
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
            {state.phase === 'error' && <span className="text-warn">{state.error}</span>}
          </p>
          {state.phase === 'available' && !state.canInstall && (
            <p className="text-xs text-muted">macOS installs updates in place only for signed apps. Download the new version and replace the app in Applications.</p>
          )}
          {(state.phase === 'downloading' || state.phase === 'ready') && (
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <motion.div className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-cyan-400" animate={{ width: `${state.percent ?? 0}%` }} transition={spring} />
            </div>
          )}
          {has && state.notes && <pre className="max-h-64 overflow-auto rounded-lg border border-line bg-black/20 p-3 font-sans text-xs whitespace-pre-wrap text-fg/85">{state.notes}</pre>}
          <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
            All releases <ExternalLink className="size-3" />
          </a>
        </div>
      </Modal>
    </>
  );
}
