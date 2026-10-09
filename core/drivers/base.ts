import type {
  ActivitySession,
  ApplyChangesRequest,
  RawPlan,
  SecurityInfo,
  ConnectionConfig,
  DbKind,
  Filter,
  QueryResponse,
  ResultSet,
  RoutineInfo,
  RowsRequest,
  RowsResponse,
  SchemaSnapshot,
  TableInfo,
  TableRef,
} from '../../shared/types.ts';
import { qualify, quoteIdent, tableInfoToDdl } from '../../shared/dialect.ts';
import { HttpError } from '../util.ts';

export interface ExecResult {
  columns: string[];
  rows: unknown[][];
  affected: number;
}

/** Runs one parameterised statement. Placeholders come from `Driver.param(i)`. */
export type Exec = (sql: string, params?: unknown[]) => Promise<ExecResult>;

export abstract class Driver {
  abstract readonly kind: DbKind;

  constructor(
    protected cfg: ConnectionConfig,
    readonly database: string,
  ) {}

  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;
  abstract serverVersion(): Promise<string>;
  abstract listDatabases(): Promise<string[]>;
  abstract getSchema(): Promise<SchemaSnapshot>;
  /** Run an arbitrary user script, possibly with several statements. */
  abstract runScript(sql: string): Promise<Omit<QueryResponse, 'durationMs'>>;
  abstract exec: Exec;
  abstract transaction<T>(fn: (exec: Exec) => Promise<T>): Promise<T>;
  /** Placeholder for the i-th (0-based) parameter. */
  abstract param(i: number): string;

  quote(id: string): string {
    return quoteIdent(this.kind, id);
  }

  qualify(t: TableRef): string {
    return qualify(this.kind, t);
  }

  async getDdl(t: TableRef): Promise<string> {
    const snap = await this.getSchema();
    const info = snap.tables.find((x) => x.name === t.name && (x.schema ?? '') === (t.schema ?? ''));
    if (!info) throw new HttpError(404, `Table ${t.name} not found`);
    if (info.type === 'view') return (await this.viewDefinition(t)) ?? '-- view definition unavailable';
    return tableInfoToDdl(this.kind, info);
  }

  async viewDefinition(_t: TableRef): Promise<string | null> {
    return null;
  }

  async routineDefinition(_r: RoutineInfo): Promise<string> {
    throw new HttpError(400, 'Routines are not supported for this database');
  }

  // ---- DBA tools; engines override what they support ----

  async activity(): Promise<ActivitySession[]> {
    throw new HttpError(400, 'Activity monitoring is not available for this database');
  }

  async killSession(_id: string, _mode: 'cancel' | 'terminate'): Promise<void> {
    throw new HttpError(400, 'Not available for this database');
  }

  async security(): Promise<SecurityInfo> {
    throw new HttpError(400, 'SQLite has no users or permissions');
  }

  abstract explain(sql: string, analyze: boolean): Promise<RawPlan>;

  protected paginate(base: string, order: string, offset: number, limit: number): string {
    return `${base}${order ? ' ORDER BY ' + order : ''} LIMIT ${limit} OFFSET ${offset}`;
  }

  async getRows(req: RowsRequest, table: TableInfo | undefined): Promise<RowsResponse> {
    const started = performance.now();
    const from = this.qualify(req.table);
    if (table) this.assertColumns(table, [...(req.filters ?? []).map((f) => f.column), ...(req.columns ?? []), ...(req.orderBy ? [req.orderBy] : [])]);
    const params: unknown[] = [];
    const conditions = [req.where?.trim() ? `(${req.where})` : '', this.filtersSql(req.filters ?? [], params)].filter(Boolean);
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const select = req.columns?.length ? req.columns.map((c) => this.quote(c)).join(', ') : '*';
    const limit = Math.max(1, Math.min(5000, Math.floor(req.limit)));
    const offset = Math.max(0, Math.floor(req.offset));
    const pk = table?.primaryKey ?? [];
    let order = '';
    if (req.orderBy) order = `${this.quote(req.orderBy)} ${req.orderDir === 'desc' ? 'DESC' : 'ASC'}`;
    else if (pk.length) order = pk.map((c) => this.quote(c)).join(', ');
    const [data, count] = await Promise.all([
      this.exec(this.paginate(`SELECT ${select} FROM ${from}${where}`, order, offset, limit), params),
      req.noCount ? null : this.exec(`SELECT COUNT(*) AS n FROM ${from}${where}`, params).catch(() => null),
    ]);
    const total = count ? Number(count.rows[0]?.[0]) : null;
    return {
      columns: data.columns,
      rows: data.rows,
      rowCount: data.rows.length,
      total,
      primaryKey: pk,
      durationMs: performance.now() - started,
    };
  }

  protected assertColumns(table: TableInfo, cols: string[]) {
    const known = new Set(table.columns.map((c) => c.name));
    const bad = cols.filter((c) => !known.has(c));
    if (bad.length) throw new HttpError(400, `Unknown column(s) on ${table.name}: ${bad.join(', ')}`);
  }

  /** Compiles structured filters to a parameterised condition; values go into `params`. */
  filtersSql(filters: Filter[], params: unknown[]): string {
    const p = (v: unknown) => this.param(params.push(v) - 1);
    return filters
      .map((f) => {
        const col = this.quote(f.column);
        switch (f.op) {
          case 'eq':
            return `${col} = ${p(f.value)}`;
          case 'neq':
            return `${col} <> ${p(f.value)}`;
          case 'gt':
            return `${col} > ${p(f.value)}`;
          case 'gte':
            return `${col} >= ${p(f.value)}`;
          case 'lt':
            return `${col} < ${p(f.value)}`;
          case 'lte':
            return `${col} <= ${p(f.value)}`;
          case 'like':
            return `${col} LIKE ${p(f.value)}`;
          case 'ilike':
            return `LOWER(${col}) LIKE LOWER(${p(f.value)})`;
          case 'in': {
            const list = Array.isArray(f.value) ? f.value : [];
            if (!list.length || list.length > 1000) throw new HttpError(400, `in: needs 1–1000 values for ${f.column}`);
            return `${col} IN (${list.map((v) => p(v)).join(', ')})`;
          }
          case 'is':
            if (f.value === null || f.value === 'null') return `${col} IS NULL`;
            if (f.value === 'notnull') return `${col} IS NOT NULL`;
            throw new HttpError(400, `is: expects null or notnull for ${f.column}`);
          default:
            throw new HttpError(400, `Unknown filter operator: ${String((f as Filter).op)}`);
        }
      })
      .join(' AND ');
  }

  /** Parameterised INSERT of several rows in one transaction. */
  async insertRows(table: TableInfo, rows: Record<string, unknown>[]): Promise<number> {
    if (!rows.length || rows.length > 1000) throw new HttpError(400, 'Insert 1–1000 rows per request');
    rows.forEach((r) => this.assertColumns(table, Object.keys(r)));
    return this.applyChanges({ table, changes: rows.map((values) => ({ type: 'insert', values })) });
  }

  /** UPDATE/DELETE scoped by structured filters; refuses to run without any filter. */
  async mutateWhere(table: TableInfo, filters: Filter[], values: Record<string, unknown> | null): Promise<number> {
    if (!filters.length) throw new HttpError(400, 'Refusing to update or delete without a filter');
    this.assertColumns(table, [...filters.map((f) => f.column), ...Object.keys(values ?? {})]);
    const params: unknown[] = [];
    let sql: string;
    if (values) {
      const entries = Object.entries(values);
      if (!entries.length) throw new HttpError(400, 'Nothing to update');
      const set = entries.map(([k, v]) => `${this.quote(k)} = ${this.param(params.push(v) - 1)}`).join(', ');
      sql = `UPDATE ${this.qualify(table)} SET ${set} WHERE ${this.filtersSql(filters, params)}`;
    } else {
      sql = `DELETE FROM ${this.qualify(table)} WHERE ${this.filtersSql(filters, params)}`;
    }
    return this.transaction(async (exec) => (await exec(sql, params)).affected);
  }

  async applyChanges(req: ApplyChangesRequest): Promise<number> {
    const t = this.qualify(req.table);
    return this.transaction(async (exec) => {
      let affected = 0;
      for (const ch of req.changes) {
        const params: unknown[] = [];
        const p = (v: unknown) => {
          params.push(v);
          return this.param(params.length - 1);
        };
        const whereKey = (key: Record<string, unknown>) =>
          Object.entries(key)
            .map(([k, v]) => (v === null ? `${this.quote(k)} IS NULL` : `${this.quote(k)} = ${p(v)}`))
            .join(' AND ');
        let sql: string;
        if (ch.type === 'insert') {
          const cols = Object.keys(ch.values);
          sql = cols.length
            ? `INSERT INTO ${t} (${cols.map((c) => this.quote(c)).join(', ')}) VALUES (${cols.map((c) => p(ch.values[c])).join(', ')})`
            : this.kind === 'mysql'
              ? `INSERT INTO ${t} () VALUES ()`
              : `INSERT INTO ${t} DEFAULT VALUES`;
        } else if (ch.type === 'update') {
          const set = Object.entries(ch.values)
            .map(([k, v]) => `${this.quote(k)} = ${p(v)}`)
            .join(', ');
          if (!set) continue;
          sql = `UPDATE ${t} SET ${set} WHERE ${whereKey(ch.key)}`;
        } else {
          sql = `DELETE FROM ${t} WHERE ${whereKey(ch.key)}`;
        }
        if (ch.type !== 'insert' && !Object.keys(ch.key).length) throw new HttpError(400, 'Row key is empty');
        const r = await exec(sql, params);
        if (ch.type !== 'insert' && r.affected > 1) {
          throw new HttpError(409, `Change would affect ${r.affected} rows — aborted (key is not unique).`);
        }
        affected += r.affected;
      }
      return affected;
    });
  }

  protected toResultSet(r: ExecResult, isQuery: boolean): ResultSet {
    if (!isQuery) return { columns: [], rows: [], rowCount: 0, affectedRows: r.affected };
    return { columns: r.columns, rows: r.rows, rowCount: r.rows.length };
  }
}

/** Group a flat list of rows by table key, keeping insertion order. */
export function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    let arr = m.get(k);
    if (!arr) m.set(k, (arr = []));
    arr.push(r);
  }
  return m;
}

export function tkey(schema: string | undefined | null, name: string): string {
  return (schema ?? '') + '\u0000' + name;
}
