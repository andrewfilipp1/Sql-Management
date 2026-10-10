import crypto from 'node:crypto';
import fs from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { createTableSql, qualify, quoteIdent, sqlLiteral, type ColumnDef } from '../shared/dialect.ts';
import type { DbKind, SchemaSnapshot, TableInfo, TableRef } from '../shared/types.ts';
import type { CsvPreview, ImportCsvRequest } from '../shared/ipc.ts';
import type { Driver } from './drivers/base.ts';
import { detectDelimiter, inferType, parseCsv, type InferredType } from './csv.ts';
import { schemaFor } from './api.ts';
import { getDriver } from './pool.ts';
import { getConnection } from './store.ts';
import { CodedError, HttpError } from './util.ts';

const MAX_CSV_BYTES = 200 * 1024 * 1024;
/** Bound parameters per statement, below each engine's hard limit. */
const MAX_PARAMS: Record<DbKind, number> = { sqlite: 30_000, postgres: 30_000, mysql: 30_000, mssql: 2_000 };

function assertWritable(connId: string) {
  if (getConnection(connId)?.readOnly) throw new CodedError('READ_ONLY', 'This connection is read-only.');
}

/** Parameterised multi-row INSERT in one transaction; returns the number of rows inserted. */
export async function bulkInsert(d: Driver, table: TableRef & Partial<TableInfo>, columns: string[], rows: unknown[][]): Promise<number> {
  if (!columns.length) throw new HttpError(400, 'No columns to insert');
  if (table.columns) {
    const known = new Set(table.columns.map((c) => c.name));
    const bad = columns.filter((c) => !known.has(c));
    if (bad.length) throw new HttpError(400, `Unknown column(s): ${bad.join(', ')}`);
  }
  // SQL Server also caps a VALUES list at 1000 rows.
  const perBatch = Math.max(1, Math.min(1000, Math.floor(MAX_PARAMS[d.kind] / columns.length)));
  const head = `INSERT INTO ${d.qualify(table)} (${columns.map((c) => d.quote(c)).join(', ')}) VALUES `;
  return d.transaction(async (exec) => {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += perBatch) {
      const batch = rows.slice(i, i + perBatch);
      const params: unknown[] = [];
      const values = batch
        .map((r) => '(' + columns.map((_, c) => d.param(params.push(r[c] ?? null) - 1)).join(', ') + ')')
        .join(', ');
      inserted += (await exec(head + values, params)).affected || batch.length;
    }
    return inserted;
  });
}

// ---------------- CSV import ----------------

interface CsvSession {
  fileName: string;
  headers: string[];
  rows: string[][];
  types: InferredType[];
  at: number;
}
const sessions = new Map<string, CsvSession>();

/** Reads a CSV the user picked in a native dialog; the renderer only ever gets a token, never the path. */
export function loadCsv(filePath: string): CsvPreview {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new HttpError(400, 'Not a file');
  if (stat.size > MAX_CSV_BYTES) throw new HttpError(413, 'File is larger than 200 MB');
  if (!/\.(csv|tsv|txt)$/i.test(filePath)) throw new HttpError(400, 'Choose a .csv, .tsv or .txt file');
  const text = fs.readFileSync(filePath, 'utf8');
  const delimiter = detectDelimiter(text.slice(0, 20_000));
  const all = parseCsv(text, delimiter);
  if (!all.length) throw new HttpError(400, 'The file is empty');
  const [header, ...rows] = all;
  const headers = header.map((h, i) => h.trim() || `column_${i + 1}`);
  const width = headers.length;
  const normalized = rows.map((r) => (r.length === width ? r : [...r, ...new Array(Math.max(0, width - r.length)).fill('')].slice(0, width)));
  const sample = normalized.slice(0, 500);
  const types = headers.map((_, c) => inferType(sample.map((r) => r[c])));
  // Drop sessions older than an hour so abandoned imports do not hold memory.
  for (const [k, s] of sessions) if (Date.now() - s.at > 3_600_000) sessions.delete(k);
  const token = crypto.randomUUID();
  sessions.set(token, { fileName: path.basename(filePath), headers, rows: normalized, types, at: Date.now() });
  return {
    token,
    fileName: path.basename(filePath),
    delimiter,
    headers,
    types,
    rowCount: normalized.length,
    preview: normalized.slice(0, 20),
  };
}

const NEW_TABLE_TYPE: Record<DbKind, Record<InferredType, string>> = {
  sqlite: { integer: 'INTEGER', decimal: 'REAL', boolean: 'INTEGER', date: 'TEXT', datetime: 'TEXT', text: 'TEXT' },
  postgres: { integer: 'bigint', decimal: 'numeric', boolean: 'boolean', date: 'date', datetime: 'timestamp', text: 'text' },
  mysql: { integer: 'BIGINT', decimal: 'DECIMAL(18,4)', boolean: 'TINYINT(1)', date: 'DATE', datetime: 'DATETIME', text: 'TEXT' },
  mssql: { integer: 'bigint', decimal: 'decimal(18,4)', boolean: 'bit', date: 'date', datetime: 'datetime2', text: 'nvarchar(max)' },
};

export function newTableTypeFor(kind: DbKind, t: InferredType) {
  return NEW_TABLE_TYPE[kind][t];
}

function convert(v: string, t: InferredType, emptyAsNull: boolean): unknown {
  if (v === '') return emptyAsNull ? null : v;
  switch (t) {
    case 'decimal':
      return v.replace(',', '.');
    case 'boolean':
      return /^(true|1|yes)$/i.test(v);
    default:
      return v;
  }
}

export async function importCsv(req: ImportCsvRequest): Promise<{ inserted: number; table: TableRef }> {
  assertWritable(req.connId);
  const s = sessions.get(req.token);
  if (!s) throw new HttpError(410, 'The file is no longer loaded — choose it again');
  const cfg = getConnection(req.connId);
  if (!cfg) throw new HttpError(404, 'Connection not found');
  const d = await getDriver(req.connId, req.database);

  // mapping: target column → CSV column index
  const mapping = Object.entries(req.mapping).filter(([, idx]) => idx !== null && idx !== undefined) as [string, number][];
  if (!mapping.length) throw new HttpError(400, 'Map at least one column');
  if (mapping.some(([, idx]) => idx < 0 || idx >= s.headers.length)) throw new HttpError(400, 'Invalid column mapping');

  let target: TableRef & Partial<TableInfo>;
  if (req.createTable) {
    const name = req.createTable.name.trim();
    if (!name) throw new HttpError(400, 'Table name is required');
    const columns: ColumnDef[] = mapping.map(([col, idx]) => ({
      name: col,
      type: newTableTypeFor(cfg.kind, s.types[idx]),
      nullable: true,
      primaryKey: false,
      identity: false,
    }));
    target = { schema: req.createTable.schema || undefined, name };
    await d.exec(createTableSql(cfg.kind, { table: target, columns, foreignKeys: [] }));
  } else {
    if (!req.table) throw new HttpError(400, 'Choose a table');
    const snap = await schemaFor(req.connId, req.database);
    const t = snap.tables.find((x) => x.name === req.table!.name && (x.schema ?? '') === (req.table!.schema ?? ''));
    if (!t || t.type !== 'table') throw new HttpError(404, 'Table not found');
    target = t;
  }

  const columns = mapping.map(([col]) => col);
  const rows = s.rows.map((r) => mapping.map(([, idx]) => convert(r[idx], s.types[idx], req.emptyAsNull !== false)));
  const inserted = await bulkInsert(d, target, columns, rows);
  sessions.delete(req.token);
  return { inserted, table: { schema: target.schema, name: target.name } };
}

// ---------------- Generate scripts (schema + data) ----------------

/** Orders tables so that every table comes after the tables it references. */
export function dependencyOrder(tables: TableInfo[]): TableInfo[] {
  const byName = new Map(tables.map((t) => [`${t.schema ?? ''}.${t.name}`, t]));
  const out: TableInfo[] = [];
  const state = new Map<TableInfo, 'visiting' | 'done'>();
  const visit = (t: TableInfo) => {
    if (state.get(t) === 'done' || state.get(t) === 'visiting') return; // cycles: keep current order
    state.set(t, 'visiting');
    for (const fk of t.foreignKeys) {
      const dep = byName.get(`${fk.refSchema ?? t.schema ?? ''}.${fk.refTable}`) ?? tables.find((x) => x.name === fk.refTable);
      if (dep && dep !== t) visit(dep);
    }
    state.set(t, 'done');
    out.push(t);
  };
  tables.forEach(visit);
  return out;
}

export interface ScriptOptions {
  includeData: boolean;
  /** Restrict to these tables (keys "schema.name" or "name"); all when empty. */
  tables?: string[];
}

export async function writeDatabaseScript(connId: string, database: string, opts: ScriptOptions, file: string): Promise<{ tables: number; rows: number }> {
  const cfg = getConnection(connId);
  if (!cfg) throw new HttpError(404, 'Connection not found');
  const kind = cfg.kind;
  const d = await getDriver(connId, database);
  const snap: SchemaSnapshot = await schemaFor(connId, database);
  const pick = (t: TableInfo) => !opts.tables?.length || opts.tables.includes(t.schema ? `${t.schema}.${t.name}` : t.name) || opts.tables.includes(t.name);
  const tables = dependencyOrder(snap.tables.filter((t) => t.type === 'table' && pick(t)));
  const views = snap.tables.filter((t) => t.type === 'view' && pick(t));

  const out = fs.createWriteStream(file, { encoding: 'utf8' });
  const write = async (s: string) => {
    if (!out.write(s)) await once(out, 'drain');
  };
  const sep = kind === 'mssql' ? '\nGO\n\n' : '\n\n';
  let rowsWritten = 0;
  try {
    await write(`-- SQL Graphic Tool script: ${cfg.name} / ${database} (${kind})\n-- Generated ${new Date().toISOString()}\n-- Tables are ordered so referenced tables are created first.\n\n`);
    for (const t of tables) await write((await d.getDdl(t)).trim() + sep);
    if (opts.includeData) {
      for (const t of tables) {
        const identity = t.columns.some((c) => c.isIdentity);
        if (kind === 'mssql' && identity) await write(`SET IDENTITY_INSERT ${qualify(kind, t)} ON;\n`);
        const cols = t.columns.map((c) => quoteIdent(kind, c.name)).join(', ');
        let offset = 0;
        for (;;) {
          const page = await d.getRows({ table: t, offset, limit: 2000, noCount: true }, t);
          if (!page.rows.length) break;
          for (let i = 0; i < page.rows.length; i += 100) {
            const chunk = page.rows.slice(i, i + 100);
            await write(
              `INSERT INTO ${qualify(kind, t)} (${cols}) VALUES\n` + chunk.map((r) => '  (' + r.map((v) => sqlLiteral(kind, v)).join(', ') + ')').join(',\n') + ';\n',
            );
          }
          rowsWritten += page.rows.length;
          offset += page.rows.length;
          if (page.rows.length < 2000) break;
        }
        if (kind === 'mssql' && identity) await write(`SET IDENTITY_INSERT ${qualify(kind, t)} OFF;\n`);
        // Identity sequences must continue after the copied ids.
        if (kind === 'postgres') {
          for (const c of t.columns.filter((x) => x.isIdentity)) {
            await write(
              `SELECT setval(pg_get_serial_sequence('${qualify(kind, t).replace(/'/g, "''")}', '${c.name.replace(/'/g, "''")}'), COALESCE(MAX(${quoteIdent(kind, c.name)}), 1)) FROM ${qualify(kind, t)};\n`,
            );
          }
        }
        await write(kind === 'mssql' ? 'GO\n\n' : '\n');
      }
    }
    for (const v of views) {
      const def = await d.getDdl(v).catch(() => null);
      if (def) await write(def.trim().replace(/;?\s*$/, ';') + sep);
    }
  } finally {
    out.end();
    await once(out, 'close');
  }
  return { tables: tables.length, rows: rowsWritten };
}
