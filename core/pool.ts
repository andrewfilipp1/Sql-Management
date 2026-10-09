import type { ConnectionConfig } from '../shared/types.ts';
import type { Driver } from './drivers/base.ts';
import { SqliteDriver } from './drivers/sqlite.ts';
import { PostgresDriver } from './drivers/postgres.ts';
import { MysqlDriver } from './drivers/mysql.ts';
import { MssqlDriver } from './drivers/mssql.ts';
import { getConnection } from './store.ts';
import { openTunnel } from './tunnel.ts';
import { DEFAULT_PORT } from '../shared/types.ts';
import { HttpError } from './util.ts';

export function createDriver(cfg: ConnectionConfig, database: string): Driver {
  switch (cfg.kind) {
    case 'sqlite':
      return new SqliteDriver(cfg, 'main');
    case 'postgres':
      return new PostgresDriver(cfg, database);
    case 'mysql':
      return new MysqlDriver(cfg, database);
    case 'mssql':
      return new MssqlDriver(cfg, database);
    default:
      throw new HttpError(400, `Unsupported database kind: ${(cfg as ConnectionConfig).kind}`);
  }
}

/**
 * Creates and connects a driver, routing it through an SSH tunnel when the connection asks for one.
 * The tunnel lives exactly as long as the driver.
 */
export async function openDriver(cfg: ConnectionConfig, database: string): Promise<Driver> {
  const tunnel =
    cfg.sshEnabled && cfg.kind !== 'sqlite' ? await openTunnel(cfg, cfg.port || DEFAULT_PORT[cfg.kind] || 0) : null;
  // Through a tunnel a SQL Server named instance cannot be resolved (SQL Browser is UDP), so the port is used.
  const effective = tunnel ? { ...cfg, host: tunnel.host, port: tunnel.port, instance: undefined } : cfg;
  const d = createDriver(effective, database);
  try {
    await d.connect();
  } catch (e) {
    tunnel?.close();
    throw e;
  }
  if (tunnel) {
    const close = d.close.bind(d);
    d.close = async () => {
      await close();
      tunnel.close();
    };
  }
  return d;
}

export function defaultDatabaseName(cfg: ConnectionConfig): string {
  if (cfg.database) return cfg.database;
  switch (cfg.kind) {
    case 'sqlite':
      return 'main';
    case 'postgres':
      return 'postgres';
    case 'mssql':
      return 'master';
    default:
      return '';
  }
}

/** One live driver (and its pool) per connection + database. */
const drivers = new Map<string, Promise<Driver>>();
const key = (id: string, db: string) => `${id}\u0000${db}`;

export async function getDriver(connId: string, database: string): Promise<Driver> {
  const cfg = getConnection(connId);
  if (!cfg) throw new HttpError(404, 'Connection not found');
  const db = cfg.kind === 'sqlite' ? 'main' : database;
  const k = key(connId, db);
  let p = drivers.get(k);
  if (!p) {
    p = openDriver(cfg, db);
    drivers.set(k, p);
    p.catch(() => drivers.delete(k));
  }
  return p;
}

export async function closeConnection(connId: string) {
  const closing: Promise<void>[] = [];
  for (const [k, p] of drivers) {
    if (k.startsWith(connId + '\u0000')) {
      drivers.delete(k);
      closing.push(p.then((d) => d.close()).catch(() => {}));
    }
  }
  await Promise.all(closing);
}

export async function closeAll() {
  await Promise.all([...drivers.values()].map((p) => p.then((d) => d.close()).catch(() => {})));
  drivers.clear();
}
