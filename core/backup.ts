import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BackupInfo, ConnectionConfig } from '../shared/types.ts';
import { getConnection } from './store.ts';
import { openTunnel, type Tunnel } from './tunnel.ts';
import { SqliteDriver } from './drivers/sqlite.ts';
import { closeConnection, getDriver } from './pool.ts';
import { CodedError, HttpError } from './util.ts';

const isWin = process.platform === 'win32';

/** Common install locations, besides PATH, for the PostgreSQL and MySQL client tools. */
function candidateDirs(): string[] {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const globDir = (base: string, sub: string) => {
    try {
      return fs
        .readdirSync(base)
        .sort()
        .reverse()
        .map((d) => path.join(base, d, sub));
    } catch {
      return [];
    }
  };
  if (isWin) {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    dirs.push(...globDir(path.join(pf, 'PostgreSQL'), 'bin'), ...globDir(path.join(pf, 'MySQL'), 'bin'));
  } else {
    dirs.push(
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/opt/homebrew/opt/libpq/bin',
      '/usr/local/opt/libpq/bin',
      '/opt/homebrew/opt/mysql-client/bin',
      '/usr/local/opt/mysql-client/bin',
      '/Applications/Postgres.app/Contents/Versions/latest/bin',
      '/usr/local/mysql/bin',
    );
  }
  return dirs;
}

export function findTool(name: string): string | undefined {
  const exe = isWin ? `${name}.exe` : name;
  for (const dir of candidateDirs()) {
    const p = path.join(dir, exe);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

function requireCfg(connId: string): ConnectionConfig {
  const cfg = getConnection(connId);
  if (!cfg) throw new HttpError(404, 'Connection not found');
  return cfg;
}

export async function backupInfo(connId: string, database: string): Promise<BackupInfo> {
  const cfg = requireCfg(connId);
  switch (cfg.kind) {
    case 'sqlite':
      return { method: 'sqlite-file' };
    case 'mssql': {
      const d = await getDriver(connId, database);
      const r = await d.exec(`SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(4000))`).catch(() => null);
      return {
        method: 'mssql-native',
        defaultDir: (r?.rows[0]?.[0] as string) || undefined,
        note: 'BACKUP writes on the database server’s disk, not on this computer.',
      };
    }
    case 'postgres': {
      const tool = findTool('pg_dump');
      return tool ? { method: 'pg_dump', tool } : { method: 'none', note: 'Install the PostgreSQL client tools (pg_dump, pg_restore, psql) to back up from here. You can still use Generate scripts.' };
    }
    case 'mysql': {
      const tool = findTool('mysqldump');
      return tool ? { method: 'mysqldump', tool } : { method: 'none', note: 'Install the MySQL client tools (mysqldump, mysql) to back up from here. You can still use Generate scripts.' };
    }
  }
}

/** Runs a client tool against the connection (through an SSH tunnel when configured). */
async function runTool(
  cfg: ConnectionConfig,
  tool: string,
  args: (host: string, port: number) => string[],
  opts: { stdinFile?: string } = {},
): Promise<void> {
  let tunnel: Tunnel | null = null;
  const defaultPort = cfg.kind === 'postgres' ? 5432 : 3306;
  if (cfg.sshEnabled) tunnel = await openTunnel(cfg, cfg.port || defaultPort);
  const host = tunnel?.host ?? (cfg.host || 'localhost');
  const port = tunnel?.port ?? (cfg.port || defaultPort);
  // Passwords go through the environment, never the command line (visible to other processes).
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (cfg.kind === 'postgres') {
    env.PGPASSWORD = cfg.password ?? '';
    env.PGSSLMODE = cfg.ssl ? 'require' : 'prefer';
    env.PGCONNECT_TIMEOUT = '15';
  } else {
    env.MYSQL_PWD = cfg.password ?? '';
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(tool, args(host, port), { env, stdio: [opts.stdinFile ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr!.on('data', (c) => {
        if (stderr.length < 8000) stderr += String(c);
      });
      if (opts.stdinFile) fs.createReadStream(opts.stdinFile).pipe(child.stdin!);
      child.on('error', (e) => reject(new HttpError(400, `${path.basename(tool)}: ${e.message}`)));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new HttpError(400, `${path.basename(tool)} failed (exit ${code}): ${stderr.trim().split('\n').slice(-3).join(' ')}`));
      });
    });
  } finally {
    tunnel?.close();
  }
}

export async function backupToFile(connId: string, database: string, file: string, format: 'custom' | 'plain' = 'custom') {
  const cfg = requireCfg(connId);
  if (cfg.kind === 'sqlite') {
    const d = await getDriver(connId, database);
    if (!(d instanceof SqliteDriver)) throw new HttpError(500, 'Unexpected driver');
    await d.backupTo(file);
    return;
  }
  if (cfg.kind === 'postgres') {
    const tool = findTool('pg_dump');
    if (!tool) throw new HttpError(400, 'pg_dump was not found on this computer');
    await runTool(cfg, tool, (host, port) => [
      '-h', host, '-p', String(port), '-U', cfg.user ?? 'postgres', '-d', database,
      '-F', format === 'custom' ? 'c' : 'p', '--no-password', '-f', file,
    ]);
    return;
  }
  if (cfg.kind === 'mysql') {
    const tool = findTool('mysqldump');
    if (!tool) throw new HttpError(400, 'mysqldump was not found on this computer');
    await runTool(cfg, tool, (host, port) => [
      '-h', host, '-P', String(port), '-u', cfg.user ?? 'root',
      '--single-transaction', '--routines', '--triggers', '--events', `--result-file=${file}`, database,
    ]);
    return;
  }
  throw new HttpError(400, 'SQL Server backups run on the server with BACKUP DATABASE');
}

export async function restoreFromFile(connId: string, database: string, file: string) {
  const cfg = requireCfg(connId);
  if (cfg.readOnly) throw new CodedError('READ_ONLY', 'This connection is read-only.');
  if (cfg.kind === 'sqlite') {
    const target = cfg.file!;
    if (path.resolve(file) === path.resolve(target)) throw new HttpError(400, 'Choose a backup file, not the database itself');
    await closeConnection(connId);
    // Keep the current file next to it, so a mistaken restore can be undone.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.before-restore-${stamp}`);
    for (const ext of ['-wal', '-shm']) fs.rmSync(target + ext, { force: true });
    fs.copyFileSync(file, target);
    return;
  }
  if (cfg.kind === 'postgres') {
    const head = Buffer.alloc(5);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 5, 0);
    fs.closeSync(fd);
    const custom = head.toString('latin1') === 'PGDMP'; // pg_dump custom-format signature
    const tool = findTool(custom ? 'pg_restore' : 'psql');
    if (!tool) throw new HttpError(400, `${custom ? 'pg_restore' : 'psql'} was not found on this computer`);
    await runTool(cfg, tool, (host, port) =>
      custom
        ? ['-h', host, '-p', String(port), '-U', cfg.user ?? 'postgres', '-d', database, '--clean', '--if-exists', '--no-owner', '--no-password', file]
        : ['-h', host, '-p', String(port), '-U', cfg.user ?? 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '--no-password', '-f', file],
    );
    return;
  }
  if (cfg.kind === 'mysql') {
    const tool = findTool('mysql');
    if (!tool) throw new HttpError(400, 'The mysql client was not found on this computer');
    await runTool(cfg, tool, (host, port) => ['-h', host, '-P', String(port), '-u', cfg.user ?? 'root', database], { stdinFile: file });
    return;
  }
  throw new HttpError(400, 'SQL Server restores run on the server with RESTORE DATABASE');
}
