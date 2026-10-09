import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, FilePlus2, FolderOpen, PlugZap, ShieldAlert, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DEFAULT_PORT, KIND_LABEL, type ConnectionEnvironment, type DbKind, type MssqlAuth } from '../../shared/types';
import { api, platform, type ConnectionInput } from '../lib/api';
import { useStore } from '../lib/store';
import { cn, CONNECTION_COLORS } from '../lib/utils';
import { DbIcon, KIND_COLOR } from './DbIcon';
import { Button, Checkbox, Field, Input, Modal, Segmented, Select, spring } from './ui';

const KINDS: { kind: DbKind; hint: string }[] = [
  { kind: 'sqlite', hint: 'Local .db / .sqlite file' },
  { kind: 'mssql', hint: 'SQL Server & Express' },
  { kind: 'postgres', hint: 'PostgreSQL server' },
  { kind: 'mysql', hint: 'MySQL or MariaDB' },
];

const DEFAULT_USER: Partial<Record<DbKind, string>> = { postgres: 'postgres', mysql: 'root', mssql: 'sa' };

function blank(kind: DbKind): ConnectionInput {
  return {
    kind,
    name: '',
    host: kind === 'sqlite' ? undefined : 'localhost',
    port: DEFAULT_PORT[kind],
    user: DEFAULT_USER[kind],
    trustServerCertificate: kind === 'mssql' ? true : undefined,
    encrypt: kind === 'mssql' ? false : undefined,
    color: KIND_COLOR[kind],
  };
}

export function ConnectionDialog() {
  const { open, editing } = useStore((s) => s.connectionDialog);
  const close = useStore((s) => s.closeConnectionDialog);
  const save = useStore((s) => s.saveConnection);
  const connect = useStore((s) => s.connect);
  const toggle = useStore((s) => s.toggle);
  const toast = useStore((s) => s.toast);

  const [form, setForm] = useState<ConnectionInput>(blank('sqlite'));
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'fail'; message?: string }>({ state: 'idle' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(editing ? { ...editing, password: '', keepPassword: editing.hasPassword } : blank('sqlite'));
    setTest({ state: 'idle' });
  }, [open, editing]);

  const set = (patch: Partial<ConnectionInput>) => {
    setForm((f) => ({ ...f, ...patch }));
    setTest({ state: 'idle' });
  };

  const setKind = (kind: DbKind) => {
    if (editing) return;
    setForm((f) => ({ ...blank(kind), name: f.name }));
    setTest({ state: 'idle' });
  };

  const kind = form.kind ?? 'sqlite';
  const sqlServerNamed = kind === 'mssql' && !!form.instance?.trim();
  const auth: MssqlAuth = kind === 'mssql' ? (form.authType ?? 'sql') : 'sql';
  const valid = kind === 'sqlite' ? !!form.file?.trim() : !!form.host?.trim();

  const payload = (): ConnectionInput => {
    const name =
      form.name?.trim() ||
      (kind === 'sqlite'
        ? (form.file?.split(/[\\/]/).pop() ?? 'SQLite')
        : `${form.host}${form.instance ? '\\' + form.instance : ''}${form.database ? '/' + form.database : ''}`);
    return { ...form, name, port: form.port ? Number(form.port) : undefined };
  };

  const runTest = async () => {
    setTest({ state: 'running' });
    try {
      const r = await api.testConnection(payload());
      setTest({ state: 'ok', message: `${r.version} · ${r.durationMs} ms` });
    } catch (e) {
      setTest({ state: 'fail', message: (e as Error).message });
    }
  };

  const submit = async () => {
    setSaving(true);
    try {
      const saved = await save(payload());
      close();
      toast(editing ? 'Connection updated' : `Added “${saved.name}”`, 'success');
      const s = await connect(saved.id);
      if (s) toggle(saved.id, true);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const browse = async (mode: 'open' | 'create') => {
    const file = await api.pickSqliteFile(mode);
    if (file) set({ file, name: form.name || file.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') });
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={editing ? 'Edit connection' : 'New connection'}
      icon={<PlugZap className="size-4" />}
      width={620}
      footer={
        <>
          <div className="mr-auto min-w-0 flex-1 text-xs">
            {test.state === 'ok' && (
              <motion.span initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-1.5 text-ok">
                <CheckCircle2 className="size-4 shrink-0" /> <span className="truncate">{test.message}</span>
              </motion.span>
            )}
            {test.state === 'fail' && (
              <motion.span initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex items-start gap-1.5 text-danger">
                <XCircle className="mt-px size-4 shrink-0" /> <span className="line-clamp-3">{test.message}</span>
              </motion.span>
            )}
          </div>
          <Button onClick={() => void runTest()} loading={test.state === 'running'} disabled={!valid}>
            Test
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={saving} disabled={!valid}>
            {editing ? 'Save' : 'Save & connect'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-4 gap-2">
        {KINDS.map(({ kind: k, hint }) => (
          <motion.button
            key={k}
            whileHover={editing ? undefined : { scale: 1.03, y: -2 }}
            whileTap={editing ? undefined : { scale: 0.97 }}
            transition={spring}
            onClick={() => setKind(k)}
            disabled={!!editing && editing.kind !== k}
            className={cn(
              'relative flex flex-col items-center gap-2 rounded-xl border p-3 text-center transition-[border-color,box-shadow,opacity] disabled:opacity-30',
              kind === k ? 'border-transparent' : 'border-line bg-white/[0.02] hover:border-line-strong',
            )}
            style={kind === k ? { boxShadow: `0 0 0 1.5px ${KIND_COLOR[k]}, 0 0 26px -6px ${KIND_COLOR[k]}`, background: `color-mix(in srgb, ${KIND_COLOR[k]} 8%, transparent)` } : undefined}
          >
            <DbIcon kind={k} size="lg" />
            <div>
              <div className="text-[12.5px] font-semibold">{KIND_LABEL[k]}</div>
              <div className="text-[10.5px] text-faint">{hint}</div>
            </div>
          </motion.button>
        ))}
      </div>

      <motion.div key={kind} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="mt-5 grid grid-cols-6 gap-3">
        <Field label="Name" className="col-span-4">
          <Input value={form.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder="My database" autoFocus />
        </Field>
        <Field label="Color" className="col-span-2">
          <div className="flex h-8 items-center gap-1.5">
            {CONNECTION_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => set({ color: c })}
                className={cn('size-4 rounded-full transition-transform hover:scale-125', form.color === c && 'ring-2 ring-white/80 ring-offset-2 ring-offset-[#0d1020]')}
                style={{ background: c, boxShadow: `0 0 10px -2px ${c}` }}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
        </Field>

        {kind === 'sqlite' ? (
          <>
            <Field label="Database file" className="col-span-6">
              <div className="flex gap-2">
                <Input value={form.file ?? ''} onChange={(e) => set({ file: e.target.value })} placeholder="/path/to/database.sqlite" className="font-mono text-xs" />
                <Button icon={<FolderOpen className="size-3.5" />} onClick={() => void browse('open')}>
                  Browse
                </Button>
                <Button icon={<FilePlus2 className="size-3.5" />} onClick={() => void browse('create')} title="Create a new empty database file">
                  New
                </Button>
              </div>
            </Field>
          </>
        ) : (
          <>
            <Field label={kind === 'mssql' ? 'Server' : 'Host'} className={kind === 'mssql' ? 'col-span-3' : 'col-span-4'}>
              <Input value={form.host ?? ''} onChange={(e) => set({ host: e.target.value })} placeholder="localhost" />
            </Field>
            {kind === 'mssql' && (
              <Field label="Instance" className="col-span-2" hint="e.g. SQLEXPRESS">
                <Input
                  value={form.instance ?? ''}
                  // A named instance (SQLEXPRESS) usually listens on a dynamic port found via SQL Browser,
                  // so drop the default 1433 rather than silently bypassing the lookup.
                  onChange={(e) => set({ instance: e.target.value, port: e.target.value.trim() && form.port === 1433 ? undefined : form.port })}
                  placeholder="(default)"
                />
              </Field>
            )}
            <Field label="Port" className={kind === 'mssql' ? 'col-span-1' : 'col-span-2'}>
              <Input
                type="number"
                value={form.port ?? ''}
                onChange={(e) => set({ port: e.target.value ? Number(e.target.value) : undefined })}
                placeholder={sqlServerNamed ? 'auto' : String(DEFAULT_PORT[kind] ?? '')}
              />
            </Field>
            {kind === 'mssql' && (
              <Field label="Authentication" className="col-span-6">
                <Select value={auth} onChange={(e) => set({ authType: e.target.value as MssqlAuth })} data-testid="mssql-auth">
                  <option value="sql">SQL Server login</option>
                  <option value="ntlm">Windows account (domain, user, password)</option>
                  <option value="windows" disabled={platform !== 'win32'}>
                    Windows — current user{platform !== 'win32' ? ' (only on Windows)' : ''}
                  </option>
                </Select>
              </Field>
            )}
            {auth === 'ntlm' && (
              <Field label="Domain" className="col-span-2" hint="Or write DOMAIN\user">
                <Input value={form.domain ?? ''} onChange={(e) => set({ domain: e.target.value })} placeholder="CONTOSO" autoComplete="off" />
              </Field>
            )}
            {auth !== 'windows' && (
              <>
                <Field label="User" className={auth === 'ntlm' ? 'col-span-2' : 'col-span-3'}>
                  <Input value={form.user ?? ''} onChange={(e) => set({ user: e.target.value })} autoComplete="off" />
                </Field>
                <Field label="Password" className={auth === 'ntlm' ? 'col-span-2' : 'col-span-3'}>
                  <Input
                    type="password"
                    value={form.password ?? ''}
                    onChange={(e) => set({ password: e.target.value, keepPassword: false })}
                    placeholder={form.keepPassword ? '•••••• (unchanged)' : ''}
                    autoComplete="new-password"
                  />
                </Field>
              </>
            )}
            {auth === 'windows' && (
              <p className="col-span-6 -mt-1 text-[11.5px] text-muted">
                Signs in as the Windows user running SchemaScope, through the SQL Server ODBC driver (ODBC Driver 18/17 if installed, otherwise the
                driver built into Windows).
              </p>
            )}
            <Field label="Database" className="col-span-6" hint="Optional — the database to open first. All databases you can access are listed after connecting.">
              <Input value={form.database ?? ''} onChange={(e) => set({ database: e.target.value })} placeholder={kind === 'postgres' ? 'postgres' : kind === 'mssql' ? 'master' : ''} />
            </Field>
            <div className="col-span-6 flex flex-wrap gap-x-5 gap-y-2">
              {kind === 'mssql' ? (
                <>
                  <Checkbox checked={!!form.encrypt} onChange={(v) => set({ encrypt: v })} label="Encrypt connection" />
                  <Checkbox checked={form.trustServerCertificate ?? true} onChange={(v) => set({ trustServerCertificate: v })} label="Trust server certificate" />
                </>
              ) : (
                <Checkbox checked={!!form.ssl} onChange={(v) => set({ ssl: v })} label="Use SSL" />
              )}
            </div>
            {kind === 'mssql' && (
              <p className="col-span-6 rounded-lg border border-line bg-white/[0.02] p-2.5 text-[11.5px] leading-relaxed text-muted">
                SQL Server Express: use server <span className="font-mono text-fg">localhost</span> with instance{' '}
                <span className="font-mono text-fg">SQLEXPRESS</span> (needs the SQL Server Browser service), or enter the TCP port
                directly. LocalDB: server <span className="font-mono text-fg">(localdb)\MSSQLLocalDB</span> with “Windows — current user”.
                {auth === 'sql' && ' SQL Server logins need “SQL Server and Windows Authentication mode”.'} TCP/IP must be enabled in SQL Server
                Configuration Manager for network connections.
              </p>
            )}
            <div className="col-span-6">
              <Checkbox checked={!!form.sshEnabled} onChange={(v) => set({ sshEnabled: v })} label="Connect through an SSH tunnel" />
            </div>
            <AnimatePresence initial={false}>
              {form.sshEnabled && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={spring}
                  className="col-span-6 grid grid-cols-6 gap-3 overflow-hidden rounded-xl border border-line bg-white/[0.02] p-3"
                >
                  <Field label="SSH host" className="col-span-4">
                    <Input value={form.sshHost ?? ''} onChange={(e) => set({ sshHost: e.target.value })} placeholder="bastion.example.com" />
                  </Field>
                  <Field label="SSH port" className="col-span-2">
                    <Input type="number" value={form.sshPort ?? ''} onChange={(e) => set({ sshPort: e.target.value ? Number(e.target.value) : undefined })} placeholder="22" />
                  </Field>
                  <Field label="SSH user" className="col-span-2">
                    <Input value={form.sshUser ?? ''} onChange={(e) => set({ sshUser: e.target.value })} autoComplete="off" />
                  </Field>
                  <Field label="SSH password" className="col-span-4" hint="Leave empty when using a private key.">
                    <Input
                      type="password"
                      value={form.sshPassword ?? ''}
                      onChange={(e) => set({ sshPassword: e.target.value })}
                      placeholder={editing?.hasSshPassword ? '•••••• (unchanged)' : ''}
                      autoComplete="new-password"
                    />
                  </Field>
                  <Field label="Private key file" className="col-span-4">
                    <Input value={form.sshKeyFile ?? ''} onChange={(e) => set({ sshKeyFile: e.target.value })} placeholder="~/.ssh/id_ed25519" className="font-mono text-xs" />
                  </Field>
                  <Field label="Key passphrase" className="col-span-2">
                    <Input
                      type="password"
                      value={form.sshPassphrase ?? ''}
                      onChange={(e) => set({ sshPassphrase: e.target.value })}
                      placeholder={editing?.hasSshPassphrase ? '••••••' : ''}
                      autoComplete="new-password"
                    />
                  </Field>
                  <p className="col-span-6 text-[11px] text-faint">
                    Host and port above are resolved from the SSH server. A SQL Server named instance needs its TCP port when tunnelled.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}

        <div className="col-span-6 mt-1 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-4">
          <span className="text-[11px] font-medium tracking-wide text-muted uppercase">Environment</span>
          <Segmented<ConnectionEnvironment>
            layoutId="conn-env"
            value={form.environment ?? 'development'}
            onChange={(v) => set({ environment: v })}
            options={[
              { value: 'development', label: 'Development' },
              { value: 'staging', label: 'Staging' },
              { value: 'production', label: 'Production', icon: <ShieldAlert className="size-3.5 text-danger" /> },
            ]}
          />
          <Checkbox checked={!!form.readOnly} onChange={(v) => set({ readOnly: v })} label="Read-only" />
          {form.environment === 'production' && (
            <p className="w-full text-[11.5px] text-rose-200/80">
              Production connections are outlined in red and ask before running DELETE/UPDATE without WHERE, DROP or TRUNCATE.
            </p>
          )}
        </div>
      </motion.div>
    </Modal>
  );
}
