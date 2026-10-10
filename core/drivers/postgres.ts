import pg from 'pg';
import type { ActivitySession, ColumnInfo, ForeignKeyInfo, IndexInfo, RawPlan, ResultSet, RoutineInfo, SchemaSnapshot, SecurityInfo, TableInfo, TableRef } from '../../shared/types.ts';
import { Driver, groupBy, tkey, type Exec, type ExecResult } from './base.ts';
import { HttpError, MAX_RESULT_ROWS, serializeRows } from '../util.ts';

// Return dates/timestamps as the server formats them instead of shifting them to JS Dates.
for (const oid of [1082, 1114, 1184, 1083, 1266]) pg.types.setTypeParser(oid, (v: string) => v);
// int8 / numeric come back as strings by default; keep them precise.

const SYS_SCHEMAS = `('pg_catalog','information_schema')`;
const FK_ACTION: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

type Queryable = pg.Pool | pg.PoolClient;

export class PostgresDriver extends Driver {
  readonly kind = 'postgres' as const;
  private pool!: pg.Pool;

  async connect() {
    this.pool = new pg.Pool({
      host: this.cfg.host || 'localhost',
      port: this.cfg.port || 5432,
      user: this.cfg.user,
      password: this.cfg.password,
      database: this.database,
      ssl: this.cfg.ssl ? { rejectUnauthorized: false } : undefined,
      max: 5,
      connectionTimeoutMillis: 10_000,
      application_name: 'SQL Graphic Tool',
      // Enforced by the server: every transaction in a read-only connection is READ ONLY.
      options: this.cfg.readOnly ? '-c default_transaction_read_only=on' : undefined,
    });
    const c = await this.pool.connect();
    c.release();
  }

  async close() {
    await this.pool?.end().catch(() => {});
  }

  async serverVersion() {
    const r = await this.pool.query('SELECT version() AS v');
    return String(r.rows[0].v).split(',')[0];
  }

  async listDatabases() {
    const r = await this.pool.query(
      `SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname`,
    );
    return r.rows.map((x) => String(x.datname));
  }

  param(i: number) {
    return '$' + (i + 1);
  }

  private async run(q: Queryable, sql: string, params: unknown[] = []): Promise<ExecResult> {
    const r = await q.query({ text: sql, values: params, rowMode: 'array' });
    return {
      columns: r.fields?.map((f) => f.name) ?? [],
      rows: serializeRows((r.rows ?? []) as unknown[][]),
      affected: r.rowCount ?? 0,
    };
  }

  exec: Exec = (sql, params = []) => this.run(this.pool, sql, params);

  async transaction<T>(fn: (exec: Exec) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn((sql, params = []) => this.run(client, sql, params));
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async runScript(sql: string) {
    const client = await this.pool.connect();
    const messages: string[] = [];
    const onNotice = (n: { severity?: string; message?: string }) => void messages.push(`${n.severity ?? 'NOTICE'}: ${n.message}`);
    client.on('notice', onNotice);
    try {
      const raw = (await client.query({ text: sql, rowMode: 'array' })) as unknown as pg.QueryArrayResult | pg.QueryArrayResult[];
      const list = Array.isArray(raw) ? raw : [raw];
      const results: ResultSet[] = list.map((r) => {
        if (r.fields?.length) {
          const truncated = r.rows.length > MAX_RESULT_ROWS;
          const rows = truncated ? r.rows.slice(0, MAX_RESULT_ROWS) : r.rows;
          return { columns: r.fields.map((f) => f.name), rows: serializeRows(rows), rowCount: rows.length, truncated };
        }
        if (r.command && r.rowCount != null) messages.push(`${r.command}: ${r.rowCount} row(s) affected`);
        else if (r.command) messages.push(`${r.command} completed`);
        return { columns: [], rows: [], rowCount: 0, affectedRows: r.rowCount ?? 0 };
      });
      return { results, messages };
    } finally {
      client.off('notice', onNotice);
      client.release();
    }
  }

  async getSchema(): Promise<SchemaSnapshot> {
    const q = async (sql: string) => (await this.pool.query(sql)).rows as Record<string, any>[];
    const [cols, cons, idx, counts, routines, schemas] = await Promise.all([
      q(`SELECT n.nspname AS schema, c.relname AS table, c.relkind, a.attname AS column,
                format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS default, (a.attidentity <> '' OR coalesce(pg_get_expr(d.adbin, d.adrelid), '') LIKE 'nextval(%') AS is_identity,
                col_description(c.oid, a.attnum) AS comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
         WHERE c.relkind IN ('r','v','m','p','f') AND NOT c.relispartition
           AND n.nspname NOT IN ${SYS_SCHEMAS} AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
         ORDER BY n.nspname, c.relname, a.attnum`),
      q(`SELECT con.conname AS name, con.contype, n.nspname AS schema, c.relname AS table,
                ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
                fn.nspname AS ref_schema, fc.relname AS ref_table,
                ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS ref_columns,
                con.confdeltype, con.confupdtype
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_class fc ON fc.oid = con.confrelid
         LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
         WHERE con.contype IN ('p','f') AND n.nspname NOT IN ${SYS_SCHEMAS}`),
      q(`SELECT n.nspname AS schema, t.relname AS table, i.relname AS name, ix.indisunique AS unique, ix.indisprimary AS primary,
                ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k, true) FROM generate_series(1, ix.indnkeyatts) k ORDER BY k)::text[] AS columns
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname NOT IN ${SYS_SCHEMAS} AND n.nspname NOT LIKE 'pg_toast%'
         ORDER BY n.nspname, t.relname, i.relname`),
      q(`SELECT n.nspname AS schema, c.relname AS table,
                COALESCE(s.n_live_tup, GREATEST(c.reltuples, 0))::bigint AS n
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
         WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ${SYS_SCHEMAS}`),
      q(`SELECT n.nspname AS schema, p.proname AS name, p.prokind AS kind
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         LEFT JOIN pg_depend dep ON dep.objid = p.oid AND dep.deptype = 'e'
         WHERE n.nspname NOT IN ${SYS_SCHEMAS} AND n.nspname NOT LIKE 'pg_%' AND p.prokind IN ('f','p') AND dep.objid IS NULL
         ORDER BY n.nspname, p.proname`),
      q(`SELECT nspname AS name FROM pg_namespace
         WHERE nspname NOT IN ${SYS_SCHEMAS} AND nspname NOT LIKE 'pg_%' ORDER BY nspname`),
    ]);

    const k = (r: Record<string, any>) => tkey(r.schema, r.table);
    const consBy = groupBy(cons, k);
    const idxBy = groupBy(idx, k);
    const countBy = new Map(counts.map((r) => [k(r), Number(r.n)]));

    const tables: TableInfo[] = [];
    for (const [key, rows] of groupBy(cols, k)) {
      const first = rows[0];
      const tc = consBy.get(key) ?? [];
      const pk: string[] = tc.find((c) => c.contype === 'p')?.columns ?? [];
      const columns: ColumnInfo[] = rows.map((r) => ({
        name: r.column,
        type: r.type,
        nullable: r.nullable,
        default: r.default,
        isPrimaryKey: pk.includes(r.column),
        isIdentity: !!r.is_identity,
        comment: r.comment,
      }));
      const foreignKeys: ForeignKeyInfo[] = tc
        .filter((c) => c.contype === 'f')
        .map((c) => ({
          name: c.name,
          columns: c.columns,
          refSchema: c.ref_schema,
          refTable: c.ref_table,
          refColumns: c.ref_columns,
          onDelete: FK_ACTION[c.confdeltype],
          onUpdate: FK_ACTION[c.confupdtype],
        }));
      const indexes: IndexInfo[] = (idxBy.get(key) ?? []).map((r) => ({
        name: r.name,
        columns: r.columns,
        unique: r.unique,
        primary: r.primary,
      }));
      const isTable = first.relkind === 'r' || first.relkind === 'p' || first.relkind === 'f';
      tables.push({
        schema: first.schema,
        name: first.table,
        type: isTable ? 'table' : 'view',
        columns,
        primaryKey: pk,
        foreignKeys,
        indexes,
        rowCount: isTable ? (countBy.get(key) ?? null) : null,
      });
    }

    return {
      kind: 'postgres',
      database: this.database,
      schemas: schemas.map((s) => s.name),
      tables,
      routines: routines.map((r) => ({ schema: r.schema, name: r.name, type: r.kind === 'p' ? 'procedure' : 'function' })),
      loadedAt: new Date().toISOString(),
    };
  }

  async viewDefinition(t: TableRef) {
    const r = await this.pool.query(`SELECT pg_get_viewdef($1::regclass, true) AS def`, [this.qualify(t)]);
    return `CREATE OR REPLACE VIEW ${this.qualify(t)} AS\n${r.rows[0].def}`;
  }

  async routineDefinition(r: RoutineInfo) {
    const res = await this.pool.query(
      `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = $2`,
      [r.schema ?? 'public', r.name],
    );
    return res.rows.map((x) => String(x.def).trim() + ';').join('\n\n');
  }

  async activity(): Promise<ActivitySession[]> {
    const r = await this.pool.query(`
      SELECT pid::text AS id, usename AS user, datname AS database,
             COALESCE(application_name || ' @ ', '') || COALESCE(client_addr::text, 'local') AS client,
             state, EXTRACT(EPOCH FROM (now() - query_start)) * 1000 AS duration_ms, query,
             NULLIF(CONCAT_WS(':', wait_event_type, wait_event), '') AS wait,
             pg_blocking_pids(pid)::text[] AS blocked_by, pid = pg_backend_pid() AS is_self
      FROM pg_stat_activity
      WHERE backend_type = 'client backend'
      ORDER BY (state = 'active') DESC, query_start`);
    return r.rows.map((x) => ({
      id: x.id,
      user: x.user,
      database: x.database,
      client: x.client,
      state: x.state,
      durationMs: x.duration_ms == null ? null : Math.round(Number(x.duration_ms)),
      query: x.query,
      wait: x.wait,
      blockedBy: x.blocked_by ?? [],
      isSelf: x.is_self,
    }));
  }

  async killSession(id: string, mode: 'cancel' | 'terminate') {
    if (!/^\d+$/.test(id)) throw new HttpError(400, 'Invalid session id');
    const fn = mode === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend';
    const r = await this.pool.query(`SELECT ${fn}($1::int) AS ok`, [Number(id)]);
    if (!r.rows[0]?.ok) throw new HttpError(400, 'The session could not be signalled (finished already, or not permitted).');
  }

  async security(): Promise<SecurityInfo> {
    const [roles, grants] = await Promise.all([
      this.pool.query(`
        SELECT r.rolname AS name, r.rolcanlogin AS can_login, r.rolsuper AS superuser,
               ARRAY(SELECT b.rolname FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid ORDER BY 1)::text[] AS member_of
        FROM pg_roles r WHERE r.rolname NOT LIKE 'pg\\_%' ORDER BY r.rolname`),
      this.pool.query(`
        SELECT grantee, table_schema || '.' || table_name AS object, privilege_type
        FROM information_schema.role_table_grants
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY grantee, object, privilege_type`),
    ]);
    const principals = roles.rows.map((x) => ({
      name: x.name,
      kind: (x.can_login ? 'user' : 'role') as 'user' | 'role',
      canLogin: x.can_login,
      superuser: x.superuser,
      memberOf: x.member_of,
    }));
    return {
      principals,
      grants: grants.rows.map((g) => ({ principal: g.grantee, object: g.object, privilege: g.privilege_type })),
      roles: principals.filter((p) => !p.canLogin).map((p) => p.name),
      notes: 'Grants are listed for objects your login can see.',
    };
  }

  async explain(sql: string, analyze: boolean): Promise<RawPlan> {
    const opts = analyze ? 'FORMAT JSON, ANALYZE, BUFFERS' : 'FORMAT JSON';
    const r = await this.pool.query(`EXPLAIN (${opts}) ${sql}`);
    return { format: 'pg-json', data: r.rows[0]['QUERY PLAN'] };
  }
}
