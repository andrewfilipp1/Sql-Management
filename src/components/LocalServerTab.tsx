import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, Circle, Database, Download, ExternalLink, Loader2, Plus, RefreshCw, Server, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LICENSES, type LocalEdition, type LocalServerState, type SetupStep } from '../../shared/localServer';
import { openDashboard } from '../lib/actions';
import { api, platform } from '../lib/api';
import { useStore } from '../lib/store';
import { cn } from '../lib/utils';
import { Button, Checkbox, EmptyState, Field, Select, Spinner, spring } from './ui';

/** One-click local SQL Server: shows each requirement, what is already there, and installs the rest. */
export function LocalServerTab() {
  const [state, setState] = useState<LocalServerState | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [edition, setEdition] = useState<LocalEdition>('Express');

  useEffect(() => {
    const off = window.schemascope?.onLocalServer(setState);
    api.localServerState().then((s) => {
      setState(s);
      if (!s.busy) void api.checkLocalServer().then(setState);
    });
    return off;
  }, []);

  if (!state) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (!state.supported) {
    return <EmptyState icon={<Server className="size-6" />} title="Not available here">{state.unsupportedReason}</EmptyState>;
  }

  const missing = state.steps.filter((s) => s.status === 'missing' || s.status === 'failed' || s.status === 'pending');
  const mac = platform === 'darwin';

  const install = async () => {
    try {
      const s = await api.installLocalServer({ edition, acceptLicenses: accepted });
      setState(s);
      if (s.ready) {
        await useStore.getState().loadConnections();
        useStore.getState().toast('Local SQL Server is ready', 'success');
      }
    } catch (e) {
      useStore.getState().toast((e as Error).message, 'error');
    }
  };

  const openServer = async () => {
    if (!state.connId) return;
    await useStore.getState().loadConnections();
    const s = await useStore.getState().connect(state.connId);
    if (s) {
      useStore.getState().toggle(state.connId, true);
      openDashboard(state.connId, s.defaultDatabase);
    }
  };

  return (
    <div className="h-full overflow-y-auto" data-testid="local-server">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <div className="mb-6 flex items-center gap-3">
          <motion.div
            initial={{ scale: 0.6, rotate: -20 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={spring}
            className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-rose-400 to-indigo-400 shadow-[0_0_30px_-6px_rgb(251_113_133/0.8)]"
          >
            <Server className="size-5 text-white" />
          </motion.div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Local SQL Server</h1>
            <p className="text-[13px] text-muted">
              {mac
                ? 'SQL Server 2022 running on this Mac (in Docker), reachable only from this computer.'
                : 'SQL Server 2022 Express on this PC, signed in with your Windows account.'}
            </p>
          </div>
        </div>

        <div className="glass space-y-1 rounded-2xl p-3">
          {state.steps.map((s, i) => (
            <StepRow key={s.id} step={s} index={i} />
          ))}
        </div>

        <AnimatePresence>
          {state.error && !state.busy && (
            <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
              {state.error}
            </motion.div>
          )}
        </AnimatePresence>

        {state.ready ? (
          <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={spring} className="mt-5 flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-[13px] text-ok">
              <CheckCircle2 className="size-4" /> Everything is installed and running.
            </span>
            <div className="flex-1" />
            <Button icon={<Database className="size-3.5" />} onClick={() => void openServer()} data-testid="ls-open">
              Open server
            </Button>
            <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => useStore.getState().openNewDatabase(true)}>
              New database
            </Button>
          </motion.div>
        ) : (
          <div className="mt-5 space-y-3">
            {mac && (
              <Field label="Edition" hint={edition === 'Express' ? 'Free, also for production use. Databases up to 10 GB.' : 'Free with all features, for development and testing only (not production).'}>
                <Select value={edition} onChange={(e) => setEdition(e.target.value as LocalEdition)} disabled={state.busy} className="max-w-xs">
                  <option value="Express">Express</option>
                  <option value="Developer">Developer</option>
                </Select>
              </Field>
            )}
            <div className="rounded-xl border border-line bg-white/[0.02] p-3 text-xs leading-relaxed text-muted">
              <Checkbox
                checked={accepted}
                onChange={setAccepted}
                label={<span className="text-[12.5px] text-fg">I accept the license terms of the software that will be installed</span>}
              />
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 pl-5">
                {mac && <LicenseLink href={LICENSES.docker}>Docker Subscription Service Agreement</LicenseLink>}
                <LicenseLink href={mac ? LICENSES.sqlServer : LICENSES.sqlExpress}>Microsoft SQL Server license</LicenseLink>
              </div>
              {mac && (
                <p className="mt-2 pl-5">
                  Docker Desktop is free for personal use, education and small businesses (under 250 employees and under $10M revenue); larger
                  companies need a paid Docker subscription. Downloads: Docker ~600 MB, SQL Server ~1.5 GB. Your Mac password is asked for the
                  installs that need it.
                </p>
              )}
              {!mac && <p className="mt-2 pl-5">Downloads about 300 MB and takes several minutes. Windows asks for permission to install.</p>}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                icon={state.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                disabled={!accepted || state.busy}
                onClick={() => void install()}
                data-testid="ls-install"
              >
                {state.busy ? 'Working…' : missing.length ? `Install (${missing.length} step${missing.length === 1 ? '' : 's'})` : 'Install'}
              </Button>
              <Button variant="ghost" icon={<RefreshCw className="size-3.5" />} disabled={state.busy} onClick={() => void api.checkLocalServer().then(setState)}>
                Check again
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LicenseLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <button className="inline-flex items-center gap-1 text-accent hover:underline" onClick={() => window.open(href, '_blank')}>
      {children} <ExternalLink className="size-3" />
    </button>
  );
}

const STATUS_TEXT: Record<SetupStep['status'], string> = {
  pending: 'Waiting',
  checking: 'Checking…',
  ok: 'Already installed',
  missing: 'Will be installed',
  working: 'Working…',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
};

function StepRow({ step, index }: { step: SetupStep; index: number }) {
  const good = step.status === 'ok' || step.status === 'done';
  const busy = step.status === 'working' || step.status === 'checking';
  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ ...spring, delay: index * 0.05 }}
      className={cn('relative overflow-hidden rounded-xl px-3 py-2.5', busy && 'bg-accent-soft/60', step.status === 'failed' && 'bg-rose-500/10')}
      data-testid="ls-step"
      data-status={step.status}
    >
      <div className="flex items-center gap-3">
        <AnimatePresence mode="wait">
          <motion.span key={step.status} initial={{ scale: 0, rotate: -90 }} animate={{ scale: 1, rotate: 0 }} exit={{ scale: 0 }} transition={spring}>
            {good ? (
              <CheckCircle2 className="size-5 text-ok drop-shadow-[0_0_6px_rgb(52_211_153/0.7)]" />
            ) : busy ? (
              <Loader2 className="size-5 animate-spin text-accent" />
            ) : step.status === 'failed' ? (
              <XCircle className="size-5 text-danger" />
            ) : (
              <Circle className={cn('size-5', step.status === 'missing' ? 'text-warn' : 'text-faint')} />
            )}
          </motion.span>
        </AnimatePresence>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{step.label}</div>
          <div className={cn('truncate text-[11.5px]', step.status === 'failed' ? 'text-rose-200' : good ? 'text-ok/90' : 'text-muted')}>
            {step.detail ?? STATUS_TEXT[step.status]}
          </div>
        </div>
      </div>
      {step.status === 'working' && step.percent != null && (
        <div className="mt-2 ml-8 h-1 overflow-hidden rounded-full bg-white/10">
          <motion.div className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-cyan-400" animate={{ width: `${step.percent}%` }} transition={spring} />
        </div>
      )}
    </motion.div>
  );
}
