import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BakInfo } from '../shared/types.ts';
import { databaseNameProblem } from '../shared/localServer.ts';
import { copyIntoContainer, removeFromContainer } from './localServer.ts';
import { defaultDatabaseName, getDriver } from './pool.ts';
import { getConnection } from './store.ts';
import { CodedError, HttpError } from './util.ts';

/**
 * Restore a SQL Server .bak file as a NEW database (never replaces an existing one).
 * The file must be readable by the SQL Server process, so it is placed where the server can see it:
 * copied into the local Docker container, copied to a shared folder for a SQL Server on this Windows PC,
 * or given as a path on the server for remote servers. All values reach SQL Server as parameters.
 */

interface Pending {
  connId: string;
  serverPath: string;
  fileName: string;
  cleanup: () => Promise<void>;
  createdAt: number;
}
const pending = new Map<string, Pending>();
const TTL = 60 * 60_000;

function sweep() {
  for (const [k, p] of pending) {
    if (Date.now() - p.createdAt > TTL) {
      pending.delete(k);
      void p.cleanup().catch(() => undefined);
    }
  }
}

const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '.', '(local)']);
const isLocalHost = (host?: string) => LOCAL_HOSTS.has((host ?? '').trim().toLowerCase()) || /^\(localdb\)/i.test(host ?? '');

function mssqlConfig(connId: string) {
  const cfg = getConnection(connId);
  if (!cfg) throw new HttpError(404, 'Connection not found');
  if (cfg.kind !== 'mssql') throw new HttpError(400, '.bak files are SQL Server backups — choose a SQL Server connection.');
  return cfg;
}

/** Makes a file on this computer readable by the server; returns the path the server should use. */
async function placeForServer(connId: string, localFile: string): Promise<{ serverPath: string; cleanup: () => Promise<void> }> {
  const cfg = mssqlConfig(connId);
  if (!fs.existsSync(localFile)) throw new HttpError(404, 'File not found');
  if (cfg.localServer === 'docker') {
    const target = await copyIntoContainer(localFile);
    return { serverPath: target, cleanup: () => removeFromContainer(target) };
  }
  if (process.platform === 'win32' && isLocalHost(cfg.host) && !cfg.sshEnabled) {
    // The SQL Server service account usually cannot read the user's own folders (Desktop, Downloads).
    const dir = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Documents', 'SQL Graphic Tool', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${crypto.randomUUID()}.bak`);
    await fs.promises.copyFile(localFile, target);
    // Read access for Windows services (NT SERVICE\ALL SERVICES), granted by the file's owner.
    await new Promise((r) => execFile('icacls', [target, '/grant', '*S-1-5-80-0:R'], { windowsHide: true }, r));
    return { serverPath: target, cleanup: () => fs.promises.rm(target, { force: true }) };
  }
  throw new CodedError(
    'BAK_SERVER_PATH',
    'This SQL Server runs on another computer and cannot read files from this one. Copy the .bak to the server and enter its path there.',
  );
}

export async function inspectBak(connId: string, source: { localFile?: string; serverPath?: string }): Promise<BakInfo> {
  sweep();
  const cfg = mssqlConfig(connId);
  let placed: { serverPath: string; cleanup: () => Promise<void> };
  let fileName: string;
  if (source.localFile) {
    placed = await placeForServer(connId, source.localFile);
    fileName = path.basename(source.localFile);
  } else if (source.serverPath?.trim()) {
    placed = { serverPath: source.serverPath.trim(), cleanup: async () => undefined };
    fileName = source.serverPath.trim().split(/[\\/]/).pop() ?? 'backup.bak';
  } else throw new HttpError(400, 'Choose a .bak file');

  try {
    const d = await getDriver(connId, defaultDatabaseName(cfg));
    const header = await d.exec('RESTORE HEADERONLY FROM DISK = @p1', [placed.serverPath]);
    const files = await d.exec('RESTORE FILELISTONLY FROM DISK = @p1', [placed.serverPath]);
    const col = (r: { columns: string[] }, name: string) => r.columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
    const h = header.rows[0] ?? [];
    const v = (n: string) => h[col(header, n)];
    const original = String(v('DatabaseName') ?? '');
    const token = crypto.randomUUID();
    pending.set(token, { connId, serverPath: placed.serverPath, fileName, cleanup: placed.cleanup, createdAt: Date.now() });
    const existing = new Set((await d.listDatabases()).map((x) => x.toLowerCase()));
    let suggested = original.replace(/[^\p{L}\p{N}_-]/gu, '_') || 'Restored';
    if (existing.has(suggested.toLowerCase())) suggested = `${suggested}_restored`;
    return {
      token,
      fileName,
      databaseName: original,
      backupDate: v('BackupFinishDate') != null ? String(v('BackupFinishDate')) : undefined,
      serverVersion: [v('SoftwareVersionMajor'), v('SoftwareVersionMinor'), v('SoftwareVersionBuild')].filter((x) => x != null).join('.'),
      sizeBytes: Number(v('BackupSize') ?? 0) || undefined,
      backupSets: header.rows.length,
      files: files.rows.map((r) => ({
        logicalName: String(r[col(files, 'LogicalName')]),
        type: String(r[col(files, 'Type')]),
        sizeBytes: Number(r[col(files, 'Size')] ?? 0),
      })),
      suggestedName: suggested,
    };
  } catch (e) {
    await placed.cleanup().catch(() => undefined);
    throw friendlyRestoreError(e);
  }
}

export async function restoreBak(token: string, newName: string): Promise<{ database: string }> {
  const p = pending.get(token);
  if (!p) throw new HttpError(410, 'The backup was not inspected or has expired — choose the file again.');
  const cfg = mssqlConfig(p.connId);
  if (cfg.readOnly) throw new CodedError('READ_ONLY', 'This connection is read-only.');
  const name = newName.trim();
  const problem = databaseNameProblem(name);
  if (problem) throw new HttpError(400, problem);
  const d = await getDriver(p.connId, defaultDatabaseName(cfg));
  const exists = await d.exec('SELECT DB_ID(@p1)', [name]);
  if (exists.rows[0]?.[0] != null) throw new HttpError(409, `A database named “${name}” already exists — choose another name.`);

  const files = await d.exec('RESTORE FILELISTONLY FROM DISK = @p1', [p.serverPath]);
  const paths = await d.exec("SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(4000)), CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(4000))");
  const [dataDir, logDir] = (paths.rows[0] ?? []).map((x) => String(x ?? ''));
  if (!dataDir) throw new HttpError(500, 'Could not read the server’s data folder');
  const sep = dataDir.includes('/') ? '/' : '\\';
  const join = (dir: string, f: string) => (dir.endsWith(sep) ? dir : dir + sep) + f;
  const ci = (n: string) => files.columns.findIndex((c) => c.toLowerCase() === n.toLowerCase());
  const counts: Record<string, number> = {};
  const moves: [string, string][] = files.rows.map((r) => {
    const logical = String(r[ci('LogicalName')]);
    const type = String(r[ci('Type')]).toUpperCase();
    const n = (counts[type] = (counts[type] ?? 0) + 1);
    const file =
      type === 'L'
        ? join(logDir || dataDir, `${name}_log${n > 1 ? n : ''}.ldf`)
        : type === 'D'
          ? join(dataDir, n === 1 ? `${name}.mdf` : `${name}_${n}.ndf`)
          : join(dataDir, `${name}_${type.toLowerCase()}${n}`);
    return [logical, file];
  });

  // RESTORE accepts variables for the database name, the file and every MOVE target.
  const params: unknown[] = [name, p.serverPath];
  const moveSql = moves.map(([l, f]) => {
    params.push(l, f);
    return `MOVE @p${params.length - 1} TO @p${params.length}`;
  });
  try {
    await d.exec(`RESTORE DATABASE @p1 FROM DISK = @p2 WITH ${[...moveSql, 'RECOVERY', 'STATS = 10'].join(', ')}`, params);
  } catch (e) {
    throw friendlyRestoreError(e);
  }
  pending.delete(token);
  await p.cleanup().catch(() => undefined);
  return { database: name };
}

export async function discardBak(token: string) {
  const p = pending.get(token);
  if (!p) return;
  pending.delete(token);
  await p.cleanup().catch(() => undefined);
}

function friendlyRestoreError(e: unknown): Error {
  // SQL Server reports the cause first ("Cannot open backup device…") and then "RESTORE … is terminating abnormally".
  const err = e as Error & { precedingErrors?: { message?: string }[] };
  const causes = (err?.precedingErrors ?? []).map((x) => x.message ?? '').filter(Boolean);
  const m = [...causes, err?.message ?? String(e)].join(' ');
  const detail = causes[0] ?? err?.message ?? String(e);
  if (/is incompatible with this server|backed up on a server running version/i.test(m)) {
    return new HttpError(400, `This backup comes from a newer SQL Server version than this server. ${detail}`);
  }
  if (/Operating system error 5|Access is denied/i.test(m)) return new HttpError(400, `SQL Server cannot read the file (permissions). ${detail}`);
  if (/Operating system error (2|3)\b|Cannot open backup device/i.test(m)) return new HttpError(400, `SQL Server cannot find the file at that path. ${detail}`);
  if (/10240 MB|license limit/i.test(m)) return new HttpError(400, `The database is larger than SQL Server Express allows (10 GB). ${detail}`);
  if (/not a valid|media family|is not formatted correctly|terminating abnormally/i.test(m)) return new HttpError(400, `This is not a readable SQL Server backup. ${detail}`);
  return e instanceof Error ? e : new Error(m);
}
