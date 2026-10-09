import Database from 'better-sqlite3';
import fs from 'node:fs';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, RawPlan, ResultSet, SchemaSnapshot, TableInfo, TableRef } from '../../shared/types.ts';
import { Driver, type Exec, type ExecResult } from './base.ts';
import { HttpError, MAX_RESULT_ROWS, serializeRows, splitStatements } from '../util.ts';

type Row = Record<string, unknown>;

const stripLeadingComments = (s: string) => s.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '');
const isDml = (s: string) => /^(WITH\b[\s\S]*?\b)?(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(stripLeadingComments(s));

export class SqliteDriver extends Driver {
  readonly kind = 'sqlite' as const;
  private db!: Database.Database;

  async connect() {
    const file = this.cfg.file?.trim();
    if (!file) throw new HttpError(400, 'SQLite file path is required');
    if (this.cfg.readOnly && !fs.existsSync(file)) throw new HttpError(400, `File not found: ${file}`);
    this.db = new Database(file, { readonly: !!this.cfg.readOnly, fileMustExist: !!this.cfg.readOnly });
    if (!this.cfg.readOnly) this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  async close() {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
  }

  async serverVersion() {
    return 'SQLite ' + String(this.all('SELECT sqlite_version() AS v')[0].v);
  }

  async listDatabases() {
    return ['main'];
  }

  param() {
    return '?';
  }

  private all(sql: string, params: unknown[] = []): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  /** better-sqlite3 rejects booleans; SQLite stores them as 0/1 anyway. */
  private bind(params: unknown[]) {
    return params.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
  }

  private execSync(sql: string, params: unknown[] = []): ExecResult {
    const stmt = this.db.prepare(sql);
    if (stmt.reader) {
      const rows = stmt.raw(true).all(...this.bind(params)) as unknown[][];
      return { columns: stmt.columns().map((c) => c.name), rows: serializeRows(rows), affected: 0 };
    }
    const r = stmt.run(...this.bind(params));
    return { columns: [], rows: [], affected: Number(r.changes) };
  }

  exec: Exec = async (sql, params = []) => this.execSync(sql, params);

  async transaction<T>(fn: (exec: Exec) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const r = await fn(this.exec);
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      if (this.db.inTransaction) this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async runScript(sql: string) {
    const results: ResultSet[] = [];
    const messages: string[] = [];
    for (const stmtSql of splitStatements(sql)) {
      const stmt = this.db.prepare(stmtSql);
      if (stmt.reader) {
        const rows: unknown[][] = [];
        let truncated = false;
        for (const row of stmt.raw(true).iterate() as Iterable<unknown[]>) {
          if (rows.length >= MAX_RESULT_ROWS) {
            truncated = true;
            break;
          }
          rows.push(row);
        }
        const columns = stmt.columns().map((c) => c.name);
        results.push({ columns, rows: serializeRows(rows), rowCount: rows.length, truncated });
      } else {
        const r = stmt.run();
        // changes is only meaningful for DML; for DDL it still reports the previous statement.
        const dml = isDml(stmtSql);
        const affected = dml ? Number(r.changes) : 0;
        results.push({ columns: [], rows: [], rowCount: 0, affectedRows: affected });
        messages.push(
          dml ? `${affected} row(s) affected` : `${stripLeadingComments(stmtSql).split(/\s+/).slice(0, 2).join(' ').toUpperCase()} — OK`,
        );
      }
    }
    return { results, messages };
  }

  async getSchema(): Promise<SchemaSnapshot> {
    const objects = this.all(
      `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    const tables: TableInfo[] = [];
    for (const o of objects) {
      const name = String(o.name);
      const type = o.type === 'view' ? 'view' : 'table';
      const cols = this.all(`SELECT * FROM pragma_table_info(?)`, [name]);
      const pkCols = cols
        .filter((c) => Number(c.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((c) => String(c.name));
      // A lone INTEGER PRIMARY KEY is an alias of rowid: auto-assigned and never NULL.
      const isRowidAlias = (c: Row) => pkCols.length === 1 && pkCols[0] === c.name && /^integer$/i.test(String(c.type));
      const columns: ColumnInfo[] = cols.map((c) => ({
        name: String(c.name),
        type: String(c.type || ''),
        nullable: !Number(c.notnull) && !isRowidAlias(c),
        default: c.dflt_value == null ? null : String(c.dflt_value),
        isPrimaryKey: Number(c.pk) > 0,
        isIdentity: isRowidAlias(c),
      }));

      const fkRows = type === 'table' ? this.all(`SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq`, [name]) : [];
      const fkMap = new Map<number, ForeignKeyInfo>();
      for (const f of fkRows) {
        const id = Number(f.id);
        let fk = fkMap.get(id);
        if (!fk) {
          fk = {
            name: `fk_${name}_${f.table}_${id}`,
            columns: [],
            refTable: String(f.table),
            refColumns: [],
            onDelete: String(f.on_delete),
            onUpdate: String(f.on_update),
          };
          fkMap.set(id, fk);
        }
        fk.columns.push(String(f.from));
        fk.refColumns.push(f.to == null ? '' : String(f.to));
      }

      const indexes: IndexInfo[] = [];
      if (type === 'table') {
        for (const ix of this.all(`SELECT * FROM pragma_index_list(?)`, [name])) {
          const ixCols = this.all(`SELECT * FROM pragma_index_info(?) ORDER BY seqno`, [String(ix.name)]);
          indexes.push({
            name: String(ix.name),
            columns: ixCols.map((c) => String(c.name ?? '<expr>')),
            unique: !!Number(ix.unique),
            primary: ix.origin === 'pk',
          });
        }
        if (pkCols.length && !indexes.some((i) => i.primary)) {
          indexes.unshift({ name: 'PRIMARY KEY', columns: pkCols, unique: true, primary: true });
        }
      }

      let rowCount: number | null = null;
      if (type === 'table') {
        try {
          rowCount = Number(this.all(`SELECT COUNT(*) AS n FROM ${this.quote(name)}`)[0].n);
        } catch {
          rowCount = null;
        }
      }
      tables.push({ name, type, columns, primaryKey: pkCols, foreignKeys: [...fkMap.values()], indexes, rowCount });
    }

    // A FK without explicit target columns references the parent's primary key.
    for (const t of tables) {
      for (const fk of t.foreignKeys) {
        if (fk.refColumns.some((c) => !c)) {
          const parent = tables.find((x) => x.name.toLowerCase() === fk.refTable.toLowerCase());
          fk.refColumns = fk.refColumns.map((c, i) => c || parent?.primaryKey[i] || 'rowid');
        }
      }
    }

    return { kind: 'sqlite', database: 'main', schemas: [], tables, routines: [], loadedAt: new Date().toISOString() };
  }

  async getDdl(t: TableRef) {
    const r = this.all(`SELECT sql FROM sqlite_master WHERE name = ? AND sql IS NOT NULL`, [t.name]);
    if (!r.length) throw new HttpError(404, `Table ${t.name} not found`);
    const extra = this.all(
      `SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name = ? AND sql IS NOT NULL`,
      [t.name],
    );
    return [r[0].sql, ...extra.map((x) => x.sql)].map((s) => String(s).trim() + ';').join('\n\n');
  }

  async explain(sql: string): Promise<RawPlan> {
    // SQLite has no ANALYZE variant for a single statement; the plan is always the estimated one.
    const rows = this.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).raw(true).all() as unknown[][];
    return { format: 'sqlite-rows', data: rows };
  }

  /** Consistent copy while the database stays in use (SQLite online backup API). */
  async backupTo(file: string) {
    await this.db.backup(file);
  }
}
