import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, Circle, Copy, Database, Download, ExternalLink, Eye, EyeOff, Loader2, Plus, RefreshCw, Server, Settings2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  databaseNameProblem,
  DEFAULT_INSTANCE,
  DEFAULT_LOCAL_DATABASE,
  DEFAULT_SERVER_COLLATION,
  LICENSES,
  LOCAL_SERVER_NAME,
  MSSQL_COLLATIONS,
  portProblem,
  instanceNameProblem,
  saPasswordProblem,
  SERVER_COLLATIONS,
  windowsPasswordProblem,
  type LocalEdition,
  type LocalServerState,
  type SetupStep,
} from '../../shared/localServer';
import { openDashboard } from '../lib/actions';
import { api, platform } from '../lib/api';
import { useStore } from '../lib/store';
import { cn } from '../lib/utils';
import { Button, Checkbox, EmptyState, Field, Input, Select, Spinner, spring } from './ui';

/** One-click local SQL Server: shows each requirement, what is already there, and installs the rest. */
export function LocalServerTab() {
  const [state, setState] = useState<LocalServerState | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [edition, setEdition] = useState<LocalEdition>('Express');
  const [name, setName] = useState(LOCAL_SERVER_NAME);
  const [port, setPort] = useState('');
  const [ownPassword, setOwnPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [collation, setCollation] = useState(DEFAULT_SERVER_COLLATION);
  const [makeDb, setMakeDb] = useState(true);
  const [dbName, setDbName] = useState(DEFAULT_LOCAL_DATABASE);
  const [dbCollation, setDbCollation] = useState('');
  // Windows only
  const [instance, setInstance] = useState(DEFAULT_INSTANCE);
  const [mixed, setMixed] = useState(false);
  const [tcp, setTcp] = useState(false);
  const [winCollation, setWinCollation] = useState('');

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
  // Server settings only apply when the server is created; an existing one keeps its own.
  const fixed = !!state.server;
  const portValue = port.trim() ? Number(port) : (state.suggestedPort ?? 1433);
  const usesPort = mac || tcp;
  const usesSa = mac || mixed;
  const problems = {
    name: !name.trim() ? 'Enter a name' : null,
    instance: !mac && !fixed ? instanceNameProblem(instance) : null,
    port: !fixed && usesPort && port.trim() ? portProblem(Number(port)) : null,
    password: !fixed && usesSa && ownPassword ? (mac ? saPasswordProblem(password) : windowsPasswordProblem(password)) : null,
    db: makeDb ? databaseNameProblem(dbName) : null,
  };
  const invalid = Object.values(problems).some(Boolean);

  const install = async () => {
    try {
      const s = await api.installLocalServer({
        acceptLicenses: accepted,
        name: name.trim(),
        edition,
        ...(fixed
          ? {}
          : mac
            ? { port: portValue, password: ownPassword ? password : undefined, serverCollation: collation }
            : {
                instance,
                authMode: mixed ? ('mixed' as const) : ('windows' as const),
                password: mixed && ownPassword ? password : undefined,
                serverCollation: winCollation || undefined,
                tcp,
                port: tcp ? portValue : undefined,
              }),
        database: makeDb ? { name: dbName.trim(), collation: dbCollation || undefined } : undefined,
      });
      setState(s);
      if (s.ready) {
        await useStore.getState().loadConnections();
        useStore.getState().toast(s.database ? `Local SQL Server is ready with database “${s.database}”` : 'Local SQL Server is ready', 'success');
        if (s.database && s.connId) {
          const session = await useStore.getState().connect(s.connId);
          if (session) {
            useStore.getState().toggle(s.connId, true);
            openDashboard(s.connId, s.database);
          }
        }
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
                : 'SQL Server Express on this PC (free, from Microsoft), signed in with your Windows account.'}
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

        {state.ready && state.server && <ServerSummary info={state.server} database={state.database} />}

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
            <fieldset disabled={state.busy} className="glass space-y-4 rounded-2xl p-4" data-testid="ls-settings">
              <legend className="sr-only">Settings</legend>
              <div className="flex items-center gap-2 text-[13px] font-medium">
                <Settings2 className="size-4 text-accent" /> Settings
              </div>
              {fixed && (
                <p className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-muted">
                  {mac
                    ? `A local server already exists (port ${state.server?.port}, ${state.server?.edition}, ${state.server?.collation}). Its port, password and collation stay as they are.`
                    : `SQL Server Express is already installed (${state.server?.host}). Its authentication, collation and network settings stay as they are.`}
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Server name" hint={problems.name ? <span className="text-warn">{problems.name}</span> : 'How it appears in the sidebar.'}>
                  <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} data-testid="ls-name" />
                </Field>
                {mac && !fixed && (
                  <Field label="Edition" hint={edition === 'Express' ? 'Free, also for production. Databases up to 10 GB.' : 'All features; development and testing only.'}>
                    <Select value={edition} onChange={(e) => setEdition(e.target.value as LocalEdition)}>
                      <option value="Express">Express</option>
                      <option value="Developer">Developer</option>
                    </Select>
                  </Field>
                )}
                {mac && !fixed && (
                  <Field label="Port" hint={problems.port ? <span className="text-warn">{problems.port}</span> : `Connect with localhost,${portValue}. Reachable only from this Mac.`}>
                    <Input value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} placeholder={String(state.suggestedPort ?? 1433)} inputMode="numeric" data-testid="ls-port" />
                  </Field>
                )}
                {!mac && !fixed && (
                  <Field label="Instance name" hint={problems.instance ? <span className="text-warn">{problems.instance}</span> : `Connect with localhost\\${instance || DEFAULT_INSTANCE}.`}>
                    <Input value={instance} onChange={(e) => setInstance(e.target.value.toUpperCase())} maxLength={16} data-testid="ls-instance" />
                  </Field>
                )}
                {!mac && !fixed && (
                  <Field label="Server collation" hint="How text is sorted and compared by default. Fixed once installed.">
                    <Select value={winCollation} onChange={(e) => setWinCollation(e.target.value)} data-testid="ls-collation">
                      <option value="">Based on the Windows language (default)</option>
                      {SERVER_COLLATIONS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                {mac && !fixed && (
                  <Field label="Server collation" hint="How text is sorted and compared by default. Fixed once the server is created.">
                    <Select value={collation} onChange={(e) => setCollation(e.target.value)} data-testid="ls-collation">
                      {SERVER_COLLATIONS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                          {c === DEFAULT_SERVER_COLLATION ? ' (default)' : ''}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </div>

              {!mac && !fixed && (
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">Authentication</div>
                  <div className="space-y-1.5 text-[13px]">
                    <label className="flex items-start gap-2">
                      <input type="radio" name="ls-auth" checked={!mixed} onChange={() => setMixed(false)} className="mt-1 accent-indigo-400" />
                      <span>
                        Windows only <span className="text-muted">(recommended)</span>
                        <span className="block text-xs text-muted">You sign in with your Windows account; no password to remember.</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2">
                      <input type="radio" name="ls-auth" checked={mixed} onChange={() => setMixed(true)} className="mt-1 accent-indigo-400" data-testid="ls-mixed" />
                      <span>
                        Windows and SQL logins (mixed)
                        <span className="block text-xs text-muted">Also allows the sa user with a password — for other programs or computers that cannot use your Windows account.</span>
                      </span>
                    </label>
                  </div>
                  <p className="text-xs text-muted">Your Windows account becomes an administrator of the server automatically.</p>
                </div>
              )}

              {!mac && !fixed && (
                <div className="space-y-2">
                  <Checkbox checked={tcp} onChange={setTcp} label={<span className="text-[13px]">Allow connections from other programs (TCP/IP)</span>} />
                  {tcp && (
                    <div className="grid gap-3 pl-5 sm:grid-cols-2">
                      <Field label="Port" hint={problems.port ? <span className="text-warn">{problems.port}</span> : `Connect with localhost,${portValue}. Other computers also need a Windows Firewall rule.`}>
                        <Input value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} placeholder={String(state.suggestedPort ?? 1433)} inputMode="numeric" data-testid="ls-port" />
                      </Field>
                    </div>
                  )}
                </div>
              )}

              {usesSa && !fixed && (
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">Administrator (sa) password</div>
                  <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px]">
                    <label className="flex items-center gap-2">
                      <input type="radio" name="ls-pw" checked={!ownPassword} onChange={() => setOwnPassword(false)} className="accent-indigo-400" />
                      Generate a strong password (recommended)
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="radio" name="ls-pw" checked={ownPassword} onChange={() => setOwnPassword(true)} className="accent-indigo-400" data-testid="ls-own-pw" />
                      Choose my own
                    </label>
                  </div>
                  {ownPassword ? (
                    <Field label="" hint={problems.password ? <span className="text-warn">{problems.password}</span> : 'Saved encrypted on this computer. Fixed once the server is created.'}>
                      <div className="relative max-w-sm">
                        <Input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className="pr-9" data-testid="ls-password" />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          className="absolute inset-y-0 right-2 flex items-center text-faint hover:text-fg"
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          title={showPassword ? 'Hide password' : 'Show password'}
                        >
                          {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </button>
                      </div>
                    </Field>
                  ) : (
                    <p className="text-xs text-muted">Saved encrypted on this computer. You can copy it later from this page, e.g. for another SQL tool.</p>
                  )}
                </div>
              )}

              <div className="space-y-2 border-t border-line pt-3">
                <Checkbox checked={makeDb} onChange={setMakeDb} label={<span className="text-[13px]">Create a database</span>} />
                {makeDb && (
                  <div className="grid gap-3 pl-5 sm:grid-cols-2">
                    <Field label="Database name" hint={problems.db ? <span className="text-warn">{problems.db}</span> : 'Opens when the install finishes.'}>
                      <Input value={dbName} onChange={(e) => setDbName(e.target.value)} data-testid="ls-db-name" />
                    </Field>
                    <Field label="Database collation" hint="Empty = same as the server.">
                      <Select value={dbCollation} onChange={(e) => setDbCollation(e.target.value)} data-testid="ls-db-collation">
                        {MSSQL_COLLATIONS.map((c) => (
                          <option key={c} value={c}>
                            {c || 'Same as server'}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                )}
              </div>
            </fieldset>
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
              {!mac && <p className="mt-2 pl-5">Downloads about 300 MB from Microsoft and takes several minutes. Windows asks once for permission to install.</p>}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                icon={state.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                disabled={!accepted || state.busy || invalid}
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

function ServerSummary({ info, database }: { info: NonNullable<LocalServerState['server']>; database?: string }) {
  const [copied, setCopied] = useState(false);
  const address = info.port ? `localhost,${info.port}` : info.host;
  const copy = async () => {
    if (await api.copyLocalServerPassword().catch(() => false)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="glass mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-2xl p-4 text-[13px]" data-testid="ls-summary">
      <span className="text-muted">Server</span>
      <span className="font-mono">{address}</span>
      {info.user && (
        <>
          <span className="text-muted">User</span>
          <span className="flex items-center gap-2">
            <span className="font-mono">{info.user}</span>
            <button onClick={() => void copy()} className="inline-flex items-center gap-1 text-xs text-accent hover:underline" data-testid="ls-copy-pw">
              <Copy className="size-3" /> {copied ? 'Password copied' : 'Copy password'}
            </button>
          </span>
        </>
      )}
      {!info.user && (
        <>
          <span className="text-muted">Sign-in</span>
          <span>Your Windows account</span>
        </>
      )}
      {info.edition && (
        <>
          <span className="text-muted">Edition</span>
          <span>{info.edition}</span>
        </>
      )}
      {info.collation && (
        <>
          <span className="text-muted">Collation</span>
          <span className="font-mono">{info.collation}</span>
        </>
      )}
      {database && (
        <>
          <span className="text-muted">Database</span>
          <span className="font-mono">{database}</span>
        </>
      )}
    </motion.div>
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
