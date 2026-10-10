import { AnimatePresence, motion } from 'motion/react';
import { Archive, FolderOpen, HardDrive, RotateCcw, Server } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { databaseNameProblem } from '../../shared/localServer';
import type { BakInfo } from '../../shared/types';
import { openDashboard } from '../lib/actions';
import { api, type ApiError } from '../lib/api';
import { useStore } from '../lib/store';
import { formatNumber } from '../lib/utils';
import { Button, Field, Input, Modal, Select, spring } from './ui';

const mb = (b?: number) => (b ? `${formatNumber(Math.round(b / 1048576))} MB` : '—');
const FILE_TYPE: Record<string, string> = { D: 'data', L: 'log', F: 'full-text / filestream', S: 'filestream' };

/** Restore a SQL Server .bak file as a new database. */
export function RestoreBakDialog() {
  const req = useStore((s) => s.restoreBak);
  const connections = useStore((s) => s.connections);
  const servers = useMemo(() => connections.filter((c) => c.kind === 'mssql'), [connections]);
  const [connId, setConnId] = useState('');
  const [info, setInfo] = useState<BakInfo | null>(null);
  const [name, setName] = useState('');
  const [serverPath, setServerPath] = useState('');
  const [needsServerPath, setNeedsServerPath] = useState(false);
  const [busy, setBusy] = useState<'' | 'reading' | 'restoring'>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!req) return;
    setConnId(req.connId);
    setInfo(null);
    setName('');
    setServerPath('');
    setNeedsServerPath(false);
    setError(null);
  }, [req]);

  const close = () => {
    if (info) void api.discardBak(info.token);
    useStore.getState().openRestoreBak(null);
  };
  const conn = servers.find((c) => c.id === connId);

  const read = async (fromServer: boolean) => {
    setError(null);
    setBusy('reading');
    try {
      await useStore.getState().connect(connId);
      if (info) void api.discardBak(info.token);
      const r = fromServer ? await api.inspectBakOnServer(connId, serverPath) : await api.pickBak(connId);
      if (r) {
        setInfo(r);
        setName(r.suggestedName);
      }
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'BAK_SERVER_PATH') setNeedsServerPath(true);
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const restore = async () => {
    if (!info) return;
    setError(null);
    setBusy('restoring');
    try {
      const { database } = await api.restoreBak(info.token, name);
      const store = useStore.getState();
      await store.disconnect(connId);
      const s = await store.connect(connId);
      store.toggle(connId, true);
      if (s) openDashboard(connId, database);
      store.toast(`Restored “${database}” from ${info.fileName}`, 'success');
      setInfo(null);
      store.openRestoreBak(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const problem = name ? databaseNameProblem(name) : null;

  return (
    <Modal
      open={!!req}
      onClose={close}
      title="Open a SQL Server backup (.bak)"
      icon={<Archive className="size-4" />}
      width={580}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            icon={<RotateCcw className="size-3.5" />}
            disabled={!info || !name.trim() || !!problem || !!busy}
            loading={busy === 'restoring'}
            onClick={() => void restore()}
            data-testid="bak-restore"
          >
            Restore as new database
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="SQL Server">
          <Select value={connId} onChange={(e) => (setConnId(e.target.value), setInfo(null), setNeedsServerPath(false), setError(null))} disabled={!!busy}>
            {servers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.localServer ? ' (local)' : ''}
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex flex-wrap items-end gap-2">
          <Button icon={<FolderOpen className="size-3.5" />} loading={busy === 'reading'} disabled={!conn || !!busy} onClick={() => void read(false)} data-testid="bak-pick">
            Choose .bak file…
          </Button>
          {!needsServerPath && (
            <button className="pb-1.5 text-xs text-muted hover:text-accent" onClick={() => setNeedsServerPath(true)}>
              The file is on the server
            </button>
          )}
        </div>

        <AnimatePresence>
          {needsServerPath && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <Field label="Path on the server" hint="As SQL Server sees it, e.g. D:\Backups\Sales.bak or /var/opt/mssql/backup/Sales.bak">
                <div className="flex gap-2">
                  <Input className="flex-1" icon={<Server className="size-3.5" />} value={serverPath} onChange={(e) => setServerPath(e.target.value)} spellCheck={false} />
                  <Button disabled={!serverPath.trim() || !!busy} onClick={() => void read(true)}>
                    Read
                  </Button>
                </div>
              </Field>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {error && (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0, x: [0, -4, 4, -2, 0] }} exit={{ opacity: 0 }} className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100" data-testid="bak-error">
              {error}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {info && (
            <motion.div key={info.token} initial={{ opacity: 0, y: 10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }} transition={spring} className="space-y-4" data-testid="bak-info">
              <div className="glass rounded-xl p-3 text-xs">
                <div className="mb-2 flex items-center gap-2 text-[13px] font-medium">
                  <HardDrive className="size-4 text-amber-300" /> {info.fileName}
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted">
                  <dt>Database in backup</dt>
                  <dd className="text-fg">{info.databaseName || '—'}</dd>
                  <dt>Backed up</dt>
                  <dd className="text-fg">{info.backupDate ?? '—'}</dd>
                  <dt>SQL Server version</dt>
                  <dd className="text-fg">{info.serverVersion || '—'}</dd>
                  <dt>Size</dt>
                  <dd className="text-fg">{mb(info.sizeBytes)}</dd>
                  <dt>Files</dt>
                  <dd className="text-fg">{info.files.map((f) => `${f.logicalName} (${FILE_TYPE[f.type] ?? f.type})`).join(', ')}</dd>
                </dl>
                {info.backupSets > 1 && <p className="mt-2 text-warn">This file holds {info.backupSets} backups; the first one is restored.</p>}
              </div>
              <Field label="New database name" hint={problem ? <span className="text-warn">{problem}</span> : 'Restored as a new database — nothing existing is replaced.'}>
                <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="bak-name" />
              </Field>
            </motion.div>
          )}
        </AnimatePresence>
        {busy === 'restoring' && <p className="text-xs text-muted">Restoring… large backups can take a few minutes.</p>}
      </div>
    </Modal>
  );
}
