import type { SavedEndpoint } from '../shared/integrations.ts';
import { getDriver } from './pool.ts';
import { coerceParams, compileNamed } from './sqlParams.ts';
import { getConnection } from './store.ts';
import { classifyScript, HttpError, splitGoBatches, splitStatements } from './util.ts';

export const MAX_ROWS = 1000;

export function toObjects(columns: string[], rows: unknown[][]) {
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

/** Runs a saved endpoint with bound parameters. Shared by the REST API, MCP and the "Test" button. */
export async function runEndpoint(ep: SavedEndpoint, raw: Record<string, unknown>, access: 'read' | 'write') {
  const cfg = getConnection(ep.connId);
  if (!cfg) throw new HttpError(404, 'Endpoint connection no longer exists');
  const sql = ep.sql.trim().replace(/;\s*$/, '');
  const statements = cfg.kind === 'mssql' ? splitGoBatches(sql).flatMap((b) => splitStatements(b)) : splitStatements(sql);
  if (statements.length !== 1) throw new HttpError(400, 'An endpoint must contain exactly one SQL statement');
  const writes = classifyScript(sql, cfg.kind === 'mssql').writes > 0;
  if (writes && !ep.write) throw new HttpError(400, 'This endpoint modifies data but is not marked as a write endpoint');
  if (ep.write && access !== 'write') throw new HttpError(403, 'This API key is read-only');
  if (writes && cfg.readOnly) throw new HttpError(403, 'This connection is read-only');

  const values = coerceParams(ep.params, raw);
  const d = await getDriver(ep.connId, ep.database);
  let { text, params } = compileNamed(sql, cfg.kind, values, (i) => d.param(i));
  // Bound the result for plain SELECTs where wrapping keeps the inner ORDER BY (MySQL drops it in derived
  // tables, SQL Server rejects it); everything else is capped after execution.
  if (!writes && (cfg.kind === 'postgres' || cfg.kind === 'sqlite') && /^\s*SELECT\b/i.test(text)) {
    text = `SELECT * FROM (${text}) _ss_q LIMIT ${MAX_ROWS + 1}`;
  }
  const started = performance.now();
  const r = await d.exec(text, params);
  const truncated = r.rows.length > MAX_ROWS;
  const rows = truncated ? r.rows.slice(0, MAX_ROWS) : r.rows;
  return {
    rows: toObjects(r.columns, rows),
    rowCount: rows.length,
    truncated,
    affected: writes ? r.affected : undefined,
    durationMs: Math.round(performance.now() - started),
  };
}

