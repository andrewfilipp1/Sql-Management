import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, Archive, DatabaseZap, FileBox, Plus, Server } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createDatabaseSql } from '../../shared/dialect';
import { databaseNameProblem, MSSQL_COLLATIONS, MYSQL_COLLATIONS, type CreateDatabaseOptions } from '../../shared/localServer';
import { KIND_LABEL } from '../../shared/types';
import { openDashboard } from '../lib/actions';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Field, Input, Modal, Select, spring } from './ui';

type Mode = 'choose' | 'file' | 'server';

/** “New database”: a local SQLite file, a database on a server, or set up a local SQL Server first. */
export function NewDatabaseDialog() {
  const open = useStore((s) => s.newDatabaseOpen);
  const connections = useStore((s) => s.connections);
  const servers = connections.filter((c) => c.kind !== 'sqlite');
  const [mode, setMode] = useState<Mode>('choose');
  const [name, setName] = useState('');
  const [connId, setConnId] = useState('');
  const [opts, setOpts] = useState<CreateDatabaseOptions>({});
  const [busy, setBusy] = useState(false);
  const close = () => useStore.getState().openNewDatabase(false);

  useEffect(() => {
    if (!open) return;
    setMode('choose');
    setName('');
    setOpts({});
    setConnId((id) => (servers.some((c) => c.id === id) ? id : (servers.find((c) => c.localServer)?.id ?? servers[0]?.id ?? '')));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const conn = servers.find((c) => c.id === connId);
  const problem = name ? databaseNameProblem(name) : null;
  const preview = useMemo(() => (conn && name && !problem ? createDatabaseSql(conn.kind, name, opts) : ''), [conn, name, opts, problem]);

  const createFile = async () => {
    if (databaseNameProblem(name)) return;
    const file = await api.pickSqliteFile('create', name.trim());
    if (!file) return;
    setBusy(true);
    try {
      const saved = await useStore.getState().saveConnection({ name: name.trim(), kind: 'sqlite', file, environment: 'development' });
      const s = await useStore.getState().connect(saved.id);
      if (s) {
        useStore.getState().toggle(saved.id, true);
        openDashboard(saved.id, s.defaultDatabase);
      }
      useStore.getState().toast(`Created ${file.split(/[\\/]/).pop()}`, 'success');
      close();
    } catch (e) {
      useStore.getState().toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const createOnServer = async () => {
    if (!conn || databaseNameProblem(name)) return;
    setBusy(true);
    try {
      const store = useStore.getState();
      const session = await store.connect(conn.id);
      if (!session) return;
      const { databases } = await api.createDatabase(conn.id, name.trim(), opts);
      useStore.setState((s) => ({ sessions: { ...s.sessions, [conn.id]: { ...s.sessions[conn.id], databases } } }));
      store.toggle(conn.id, true);
      openDashboard(conn.id, name.trim());
      store.toast(`Database “${name.trim()}” created on ${conn.name}`, 'success');
      close();
    } catch (e) {
      useStore.getState().toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const footer =
    mode === 'choose' ? (
      <Button onClick={close}>Cancel</Button>
    ) : (
      <>
        <Button variant="ghost" icon={<ArrowLeft className="size-3.5" />} className="mr-auto" onClick={() => setMode('choose')}>
          Back
        </Button>
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="primary"
          icon={<Plus className="size-3.5" />}
          loading={busy}
          disabled={!name.trim() || !!problem || (mode === 'server' && !conn)}
          onClick={() => void (mode === 'file' ? createFile() : createOnServer())}
          data-testid="nd-create"
        >
          {mode === 'file' ? 'Choose location & create' : 'Create database'}
        </Button>
      </>
    );

  return (
    <Modal open={open} onClose={close} title="New database" icon={<DatabaseZap className="size-4" />} width={600} footer={footer}>
      <AnimatePresence mode="wait">
        {mode === 'choose' && (
          <motion.div key="choose" initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={spring} className="grid gap-2.5">
            <Choice
              icon={<FileBox className="size-5 text-sky-300" />}
              title="Local file (SQLite)"
              text="A complete database in one file on this computer. No server needed — ready in a second."
              onClick={() => setMode('file')}
              testId="nd-file"
            />
            <Choice
              icon={<DatabaseZap className="size-5 text-indigo-300" />}
              title="On a database server"
              text={servers.length ? `Create a database on ${servers.map((s) => s.name).slice(0, 3).join(', ')}${servers.length > 3 ? '…' : ''}.` : 'Add a SQL Server, PostgreSQL or MySQL connection first, or set up a local SQL Server below.'}
              disabled={!servers.length}
              onClick={() => setMode('server')}
              testId="nd-server"
            />
            <Choice
              icon={<Server className="size-5 text-rose-300" />}
              title="Set up a local SQL Server"
              text="Like installing SQL Server Express: downloads and installs everything needed on this computer with one click, then creates the connection."
              onClick={() => {
                close();
                useStore.getState().openLocalServer();
              }}
              testId="nd-local"
            />
            <Choice
              icon={<Archive className="size-5 text-amber-300" />}
              title="From a SQL Server backup (.bak)"
              text="Restore a .bak file as a new database on a SQL Server connection."
              disabled={!servers.some((s) => s.kind === 'mssql')}
              onClick={() => {
                close();
                useStore.getState().openRestoreBak(servers.find((s) => s.kind === 'mssql' && s.localServer)?.id ?? servers.find((s) => s.kind === 'mssql')!.id);
              }}
              testId="nd-bak"
            />
          </motion.div>
        )}
        {mode !== 'choose' && (
          <motion.div key={mode} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={spring} className="space-y-4">
            {mode === 'server' && (
              <Field label="Server">
                <Select value={connId} onChange={(e) => (setConnId(e.target.value), setOpts({}))} data-testid="nd-conn">
                  {servers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} — {KIND_LABEL[c.kind]}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Database name" hint={problem ? <span className="text-warn">{problem}</span> : mode === 'file' ? 'You choose the folder next.' : undefined}>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={mode === 'file' ? 'my_app' : 'Sales'}
                                data-testid="nd-name"
                onKeyDown={(e) => e.key === 'Enter' && !problem && name.trim() && void (mode === 'file' ? createFile() : createOnServer())}
              />
            </Field>
            {mode === 'server' && conn?.kind === 'mssql' && (
              <Field label="Collation" hint="Greek_CI_AS sorts and compares Greek text correctly; empty = server default.">
                <Select value={opts.collation ?? ''} onChange={(e) => setOpts({ collation: e.target.value || undefined })}>
                  {MSSQL_COLLATIONS.map((c) => (
                    <option key={c} value={c}>
                      {c || 'Server default'}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {mode === 'server' && conn?.kind === 'mysql' && (
              <Field label="Collation" hint="Character set utf8mb4 (all languages and emoji).">
                <Select value={opts.collation ?? MYSQL_COLLATIONS[0]} onChange={(e) => setOpts({ charset: 'utf8mb4', collation: e.target.value })}>
                  {MYSQL_COLLATIONS.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
            )}
            {mode === 'server' && conn?.kind === 'postgres' && <p className="text-xs text-muted">Encoding UTF8 (all languages).</p>}
            {preview && (
              <motion.pre layout className="rounded-lg border border-line bg-black/30 px-3 py-2 font-mono text-[12px] text-cyan-50" data-testid="nd-sql">
                {preview}
              </motion.pre>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </Modal>
  );
}

function Choice({ icon, title, text, onClick, disabled, testId }: { icon: React.ReactNode; title: string; text: string; onClick: () => void; disabled?: boolean; testId: string }) {
  return (
    <motion.button
      whileHover={disabled ? undefined : { scale: 1.015 }}
      whileTap={disabled ? undefined : { scale: 0.985 }}
      transition={spring}
      disabled={disabled}
      onClick={onClick}
      className="flex items-start gap-3 rounded-xl border border-line bg-white/[0.02] px-4 py-3 text-left transition-colors hover:border-accent/40 hover:bg-accent-soft/40 disabled:opacity-45"
      data-testid={testId}
    >
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] ring-1 ring-line">{icon}</span>
      <span>
        <span className="block text-[13.5px] font-medium">{title}</span>
        <span className="block text-xs leading-relaxed text-muted">{text}</span>
      </span>
    </motion.button>
  );
}
