import { AlertTriangle, ArchiveRestore, DatabaseBackup, FileDown, History } from 'lucide-react';
import { useEffect, useState } from 'react';
import { mssqlBackupSql, mssqlRestoreSql } from '../../../shared/dialect';
import type { BackupInfo } from '../../../shared/types';
import { refreshSchema } from '../../lib/actions';
import { api } from '../../lib/api';
import { useConnection, useStore } from '../../lib/store';
import { Button, Field, Input, Modal, Segmented, Spinner } from '../ui';

export function BackupDialog() {
  const d = useStore((s) => s.dbDialog);
  const open = d?.kind === 'backup';
  const close = () => useStore.getState().openDbDialog(null);
  const conn = useConnection(d?.connId ?? '');
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [format, setFormat] = useState<'custom' | 'plain'>('custom');
  const [serverPath, setServerPath] = useState('');
  const [history, setHistory] = useState<unknown[][]>([]);
  const [busy, setBusy] = useState<'backup' | 'restore' | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !d) return;
    setInfo(null);
    setError(null);
    setConfirmRestore(false);
    api
      .backupInfo(d.connId, d.database)
      .then((i) => {
        setInfo(i);
        if (i.method === 'mssql-native') {
          const sep = i.defaultDir?.includes('\\') ? '\\' : '/';
          const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
          setServerPath(`${(i.defaultDir ?? '').replace(/[\\/]$/, '')}${sep}${d.database}-${stamp}.bak`);
          // Recent backups recorded by SQL Server (msdb is readable by most logins).
          api
            .query(
              d.connId,
              d.database,
              `SELECT TOP 8 bs.backup_finish_date, bmf.physical_device_name, CAST(bs.backup_size / 1048576.0 AS decimal(12,1)) AS size_mb
               FROM msdb.dbo.backupset bs JOIN msdb.dbo.backupmediafamily bmf ON bmf.media_set_id = bs.media_set_id
               WHERE bs.database_name = DB_NAME() ORDER BY bs.backup_finish_date DESC`,
            )
            .then((r) => setHistory(r.results[0]?.rows ?? []))
            .catch(() => setHistory([]));
        }
      })
      .catch((e: Error) => setError(e.message));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d) return null;
  const done = () => void refreshSchema(d.connId, d.database);

  const backup = async () => {
    setBusy('backup');
    setError(null);
    try {
      const r = await api.backup(d.connId, d.database, { format });
      if (r) useStore.getState().toast(`Backup saved to ${r.file}`, 'success');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy('restore');
    setError(null);
    try {
      const r = await api.restore(d.connId, d.database);
      if (r) {
        useStore.getState().toast(`Restored from ${r.file}`, 'success');
        // The connection was reset; reconnect and reload the schema.
        await useStore.getState().disconnect(d.connId);
        await useStore.getState().connect(d.connId);
        done();
        close();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      setConfirmRestore(false);
    }
  };

  const mssql = info?.method === 'mssql-native';
  const nativeFile = info?.method === 'sqlite-file' || info?.method === 'pg_dump' || info?.method === 'mysqldump';

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Backup & restore — ${d.database}`}
      icon={<DatabaseBackup className="size-4" />}
      width={620}
      footer={error ? <span className="mr-auto line-clamp-3 font-mono text-xs text-danger">{error}</span> : undefined}
    >
      {!info ? (
        <div className="flex justify-center p-6">{error ? null : <Spinner />}</div>
      ) : (
        <div className="space-y-5">
          {info.note && <p className="text-[13px] text-muted">{info.note}</p>}

          {nativeFile && (
            <>
              <section className="space-y-2">
                <h3 className="text-[13px] font-semibold">Back up to a file on this computer</h3>
                <p className="text-xs text-muted">
                  {info.method === 'sqlite-file' && 'Consistent copy of the database file, safe while it is in use.'}
                  {info.method === 'pg_dump' && `Uses ${info.tool}.`}
                  {info.method === 'mysqldump' && `Uses ${info.tool} with --single-transaction, routines, triggers and events.`}
                </p>
                {info.method === 'pg_dump' && (
                  <Segmented
                    layoutId="pg-format"
                    value={format}
                    onChange={setFormat}
                    options={[
                      { value: 'custom', label: 'Custom (pg_restore)' },
                      { value: 'plain', label: 'Plain SQL' },
                    ]}
                  />
                )}
                <Button variant="primary" icon={<DatabaseBackup className="size-3.5" />} loading={busy === 'backup'} onClick={() => void backup()}>
                  Back up…
                </Button>
              </section>
              <section className="space-y-2 border-t border-line pt-4">
                <h3 className="text-[13px] font-semibold">Restore from a backup file</h3>
                <p className="text-xs text-muted">
                  {info.method === 'sqlite-file'
                    ? 'Replaces the database file. The current file is kept next to it as *.before-restore-<date>.'
                    : 'Objects in the backup replace the existing ones in this database.'}
                </p>
                {confirmRestore ? (
                  <div className="flex items-center gap-2 rounded-lg border border-rose-400/30 bg-rose-500/10 p-2.5 text-[13px] text-rose-100">
                    <AlertTriangle className="size-4 shrink-0" />
                    <span className="flex-1">
                      Replace <b>{d.database}</b>
                      {conn?.environment === 'production' ? ' on a PRODUCTION connection' : ''}?
                    </span>
                    <Button size="sm" onClick={() => setConfirmRestore(false)}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="danger" loading={busy === 'restore'} onClick={() => void restore()}>
                      Choose file and restore
                    </Button>
                  </div>
                ) : (
                  <Button variant="danger" icon={<ArchiveRestore className="size-3.5" />} disabled={!!conn?.readOnly} onClick={() => setConfirmRestore(true)}>
                    Restore…
                  </Button>
                )}
              </section>
            </>
          )}

          {mssql && (
            <>
              <Field label="Backup file path (on the SQL Server machine)">
                <Input value={serverPath} onChange={(e) => setServerPath(e.target.value)} className="font-mono text-xs" />
              </Field>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  icon={<DatabaseBackup className="size-3.5" />}
                  disabled={!serverPath.trim()}
                  onClick={() =>
                    useStore.getState().confirmSql({ connId: d.connId, database: d.database, title: 'Back up database', sql: mssqlBackupSql(d.database, serverPath.trim()) })
                  }
                >
                  Back up…
                </Button>
                <Button
                  variant="danger"
                  icon={<ArchiveRestore className="size-3.5" />}
                  disabled={!serverPath.trim() || !!conn?.readOnly}
                  onClick={() =>
                    useStore.getState().confirmSql({
                      connId: d.connId,
                      database: 'master', // RESTORE cannot run while connected to the database being replaced
                      title: `Restore ${d.database}`,
                      description: `Every other session on ${d.database} is disconnected and the database is replaced with the backup.`,
                      sql: mssqlRestoreSql(d.database, serverPath.trim()),
                      danger: true,
                      onDone: done,
                    })
                  }
                >
                  Restore from this file…
                </Button>
              </div>
              {history.length > 0 && (
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">
                    <History className="size-3.5" /> Recent backups
                  </div>
                  <div className="space-y-1 font-mono text-[11.5px]">
                    {history.map((h, i) => (
                      <button key={i} onClick={() => setServerPath(String(h[1]))} className="flex w-full gap-3 rounded-md px-2 py-1 text-left hover:bg-white/5">
                        <span className="text-faint">{String(h[0]).slice(0, 16)}</span>
                        <span className="min-w-0 flex-1 truncate">{String(h[1])}</span>
                        <span className="text-faint">{String(h[2])} MB</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {info.method === 'none' && (
            <Button
              icon={<FileDown className="size-3.5" />}
              onClick={() => useStore.getState().openDbDialog({ kind: 'export', connId: d.connId, database: d.database })}
            >
              Generate scripts instead…
            </Button>
          )}
        </div>
      )}
    </Modal>
  );
}
