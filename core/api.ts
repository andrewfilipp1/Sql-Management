import type { Api } from '../shared/ipc.ts';
import type { SchemaSnapshot } from '../shared/types.ts';
import type { Driver } from './drivers/base.ts';
import { MysqlDriver } from './drivers/mysql.ts';
import { closeConnection, defaultDatabaseName, getDriver, openDriver } from './pool.ts';
import { deleteConnection, getConnection, listConnections, toPublic, upsertConnection, withStoredPassword } from './store.ts';
import { classifyScript, CodedError, HttpError, isReadStatement } from './util.ts';
import * as integrations from './integrations.ts';
import { applyServerSettings, requestLog, serverStatus } from './httpApi.ts';
import { runEndpoint } from './endpoints.ts';
import { bulkInsert, importCsv } from './transfer.ts';
import { backupInfo } from './backup.ts';
import { splitGoBatches, splitStatements } from './util.ts';

/** Methods that need Electron (native dialogs) are supplied by the main process. */
export type CoreApi = Omit<Api, 'pickSqliteFile' | 'saveTextFile' | 'pickCsv' | 'exportScript' | 'backup' | 'restore'>;

// Introspection can be costly on large databases, so keep one snapshot per live driver.
const schemaCache = new WeakMap<Driver, SchemaSnapshot>();
async function schemaOf(d: Driver, refresh = false) {
  let s = refresh ? undefined : schemaCache.get(d);
  if (!s) {
    s = await d.getSchema();
    schemaCache.set(d, s);
  }
  return s;
}

/** Cached schema snapshot for a connection + database (used by the REST API and MCP). */
export async function schemaFor(connId: string, database: string) {
  return schemaOf(await getDriver(connId, database));
}

export const coreApi: CoreApi = {
  async listConnections() {
    return listConnections().map(toPublic);
  },

  async saveConnection(c) {
    const saved = upsertConnection(c);
    await closeConnection(saved.id);
    return toPublic(saved);
  },

  async deleteConnection(id) {
    await closeConnection(id);
    deleteConnection(id);
  },

  async testConnection(input) {
    const cfg = withStoredPassword(input as Parameters<typeof withStoredPassword>[0]);
    const started = performance.now();
    const d = await openDriver(cfg, defaultDatabaseName(cfg));
    try {
      return { version: await d.serverVersion(), durationMs: Math.round(performance.now() - started) };
    } finally {
      await d.close();
    }
  },

  async connect(id) {
    const cfg = getConnection(id);
    if (!cfg) throw new HttpError(404, 'Connection not found');
    let def = defaultDatabaseName(cfg);
    let d = await getDriver(cfg.id, def);
    if (cfg.kind === 'mysql' && !def && d instanceof MysqlDriver) {
      def = await d.firstUserDatabase();
      d = await getDriver(cfg.id, def);
    }
    const [databases, serverVersion] = await Promise.all([d.listDatabases(), d.serverVersion().catch(() => undefined)]);
    return { databases, defaultDatabase: def, serverVersion };
  },

  async disconnect(id) {
    await closeConnection(id);
  },

  async schema(connId, database, refresh) {
    return schemaOf(await getDriver(connId, database), refresh);
  },

  async query(connId, database, sql, opts) {
    if (!sql.trim()) throw new HttpError(400, 'Query is empty');
    guardScript(connId, sql, !!opts?.confirmed);
    const d = await getDriver(connId, database);
    const started = performance.now();
    const r = await d.runScript(sql);
    // Anything other than a pure read may have changed the structure.
    if (!isReadStatement(sql)) schemaCache.delete(d);
    return { ...r, durationMs: performance.now() - started };
  },

  async rows(connId, database, req) {
    const d = await getDriver(connId, database);
    const s = await schemaOf(d);
    const t = s.tables.find((x) => x.name === req.table.name && (x.schema ?? '') === (req.table.schema ?? ''));
    return d.getRows(req, t);
  },

  async apply(connId, database, req) {
    if (getConnection(connId)?.readOnly) throw new CodedError('READ_ONLY', 'This connection is read-only.');
    const d = await getDriver(connId, database);
    const affected = await d.applyChanges(req);
    schemaCache.delete(d); // row counts changed
    return { affected };
  },

  async ddl(connId, database, table) {
    return (await getDriver(connId, database)).getDdl(table);
  },

  async routine(connId, database, r) {
    return (await getDriver(connId, database)).routineDefinition(r);
  },

  async integrations() {
    return integrationsState();
  },

  async setServer(patch) {
    integrations.setServerSettings(patch);
    await applyServerSettings();
    return integrationsState();
  },

  async createApiKey(input) {
    return integrations.createKey(input);
  },

  async revokeApiKey(id) {
    integrations.revokeKey(id);
  },

  async saveEndpoint(e) {
    return integrations.saveEndpoint(e);
  },

  async deleteEndpoint(id) {
    integrations.deleteEndpoint(id);
  },

  async testEndpoint(e, params) {
    // The desktop user owns every connection, so tests run with write access; the endpoint's own flag still applies.
    return runEndpoint(e, params, 'write');
  },

  async requestLog() {
    return requestLog();
  },

  async importCsv(req) {
    const r = await importCsv(req);
    const d = await getDriver(req.connId, req.database);
    schemaCache.delete(d);
    return r;
  },

  async bulkInsert(connId, database, table, columns, rows) {
    if (getConnection(connId)?.readOnly) throw new CodedError('READ_ONLY', 'This connection is read-only.');
    if (!Array.isArray(rows) || rows.length > 10_000) throw new HttpError(400, 'Insert at most 10,000 rows per call');
    const d = await getDriver(connId, database);
    const s = await schemaOf(d);
    const t = s.tables.find((x) => x.name === table.name && (x.schema ?? '') === (table.schema ?? ''));
    if (!t || t.type !== 'table') throw new HttpError(404, 'Table not found');
    const n = await bulkInsert(d, t, columns, rows);
    schemaCache.delete(d);
    return n;
  },

  async backupInfo(connId, database) {
    return backupInfo(connId, database);
  },

  async activity(connId, database) {
    return (await getDriver(connId, database)).activity();
  },

  async killSession(connId, database, id, mode) {
    await (await getDriver(connId, database)).killSession(String(id), mode === 'cancel' ? 'cancel' : 'terminate');
  },

  async security(connId, database) {
    return (await getDriver(connId, database)).security();
  },

  async explain(connId, database, sql, analyze) {
    const cfg = getConnection(connId);
    if (!cfg) throw new HttpError(404, 'Connection not found');
    // Plan the first statement only.
    const batches = cfg.kind === 'mssql' ? splitGoBatches(sql) : [sql];
    const first = batches.flatMap((b) => splitStatements(b))[0]?.replace(/;\s*$/, '');
    if (!first) throw new HttpError(400, 'Nothing to explain');
    // ANALYZE executes the statement, so it is only offered for reads.
    if (analyze && classifyScript(first, cfg.kind === 'mssql').writes > 0) {
      throw new HttpError(400, 'Actual plans execute the statement — only allowed for read queries. Use the estimated plan.');
    }
    return (await getDriver(connId, database)).explain(first, analyze);
  },
};

function integrationsState() {
  return {
    server: integrations.getServerSettings(),
    ...serverStatus(),
    keys: integrations.listKeys(),
    endpoints: integrations.listEndpoints(),
  };
}

/**
 * Safety rails for user scripts: read-only connections reject writes, production connections
 * ask before destructive statements. The UI retries with `confirmed` after the user agrees.
 */
export function guardScript(connId: string, sql: string, confirmed: boolean) {
  const cfg = getConnection(connId);
  if (!cfg) throw new HttpError(404, 'Connection not found');
  const risk = classifyScript(sql, cfg.kind === 'mssql');
  if (cfg.readOnly && risk.writes > 0) {
    throw new CodedError('READ_ONLY', 'This connection is read-only — the script contains statements that modify data or structure.');
  }
  if (cfg.environment === 'production' && risk.dangerous.length && !confirmed) {
    throw new CodedError('CONFIRM_REQUIRED', 'This is a production connection. Confirm the destructive statements below.', risk.dangerous);
  }
}

export function errorMessage(err: unknown): string {
  const e = err as Error & { originalError?: { message?: string } };
  return e?.originalError?.message || e?.message || String(err);
}
