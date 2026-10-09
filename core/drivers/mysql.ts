import mysql from 'mysql2/promise';
import type { FieldPacket, ResultSetHeader } from 'mysql2';
import type { ActivitySession, ColumnInfo, ForeignKeyInfo, IndexInfo, Principal, RawPlan, ResultSet, RoutineInfo, SchemaSnapshot, SecurityInfo, TableInfo, TableRef } from '../../shared/types.ts';
import { Driver, groupBy, type Exec, type ExecResult } from './base.ts';
import { HttpError, MAX_RESULT_ROWS, serializeRows } from '../util.ts';

const SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

type Queryable = mysql.Pool | mysql.PoolConnection;

export class MysqlDriver extends Driver {
  readonly kind = 'mysql' as const;
  private pool!: mysql.Pool;

  async connect() {
    this.pool = mysql.createPool({
      host: this.cfg.host || 'localhost',
      port: this.cfg.port || 3306,
      user: this.cfg.user,
      password: this.cfg.password,
      database: this.database || undefined,
      ssl: this.cfg.ssl ? { rejectUnauthorized: false } : undefined,
      connectionLimit: 5,
      connectTimeout: 10_000,
      multipleStatements: true,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      charset: 'utf8mb4',
    });
    if (this.cfg.readOnly) {
      // Enforced by the server for every pooled session.
      this.pool.pool.on('connection', (conn) => conn.query('SET SESSION TRANSACTION READ ONLY'));
    }
    const c = await this.pool.getConnection();
    c.release();
  }

  async close() {
    await this.pool?.end().catch(() => {});
  }

  async serverVersion() {
    const [rows] = await this.pool.query('SELECT VERSION() AS v');
    return 'MySQL ' + (rows as any[])[0].v;
  }

  async listDatabases() {
    const [rows] = await this.pool.query('SHOW DATABASES');
    return (rows as any[]).map((r) => String(Object.values(r)[0]));
  }

  /** First user database, used when the connection has no default database configured. */
  async firstUserDatabase(): Promise<string> {
    const dbs = await this.listDatabases();
    return dbs.find((d) => !SYSTEM_DBS.has(d.toLowerCase())) ?? dbs[0] ?? '';
  }

  param() {
    return '?';
  }

  private async run(q: Queryable, sql: string, params: unknown[] = []): Promise<ExecResult> {
    const [rows, fields] = await q.query({ sql, rowsAsArray: true }, params);
    if (Array.isArray(rows)) {
      return { columns: (fields ?? []).map((f) => f.name), rows: serializeRows(rows as unknown[][]), affected: 0 };
    }
    return { columns: [], rows: [], affected: (rows as ResultSetHeader).affectedRows };
  }

  exec: Exec = (sql, params = []) => this.run(this.pool, sql, params);

  async transaction<T>(fn: (exec: Exec) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const r = await fn((sql, params = []) => this.run(conn, sql, params));
      await conn.commit();
      return r;
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  async runScript(sql: string) {
    if (!this.database) throw new HttpError(400, 'No database selected');
    const [rows, fields] = (await this.pool.query({ sql, rowsAsArray: true })) as unknown as [unknown, unknown];
    // With multipleStatements, several statements yield parallel arrays of results and field lists.
    const multi = Array.isArray(fields) && fields.length > 0 && (Array.isArray(fields[0]) || fields[0] === undefined);
    const pairs: [unknown, FieldPacket[] | undefined][] = multi
      ? (rows as unknown[]).map((r, i) => [r, (fields as (FieldPacket[] | undefined)[])[i]])
      : [[rows, fields as FieldPacket[] | undefined]];
    const messages: string[] = [];
    const results: ResultSet[] = pairs.map(([r, f]) => {
      if (Array.isArray(r) && f) {
        const truncated = r.length > MAX_RESULT_ROWS;
        const data = truncated ? r.slice(0, MAX_RESULT_ROWS) : r;
        return { columns: f.map((x) => x.name), rows: serializeRows(data as unknown[][]), rowCount: data.length, truncated };
      }
      const h = r as ResultSetHeader;
      messages.push(`${h.affectedRows ?? 0} row(s) affected${h.info ? ' — ' + h.info : ''}`);
      return { columns: [], rows: [], rowCount: 0, affectedRows: h.affectedRows ?? 0 };
    });
    return { results, messages };
  }

  async getSchema(): Promise<SchemaSnapshot> {
    const q = async (sql: string) => (await this.pool.query(sql))[0] as Record<string, any>[];
    const [cols, stats, fks, tbls, routines] = await Promise.all([
      q(`SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.COLUMN_TYPE AS column_type,
                c.IS_NULLABLE AS is_nullable, c.COLUMN_DEFAULT AS column_default, c.COLUMN_KEY AS column_key,
                c.EXTRA AS extra, c.COLUMN_COMMENT AS comment
         FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = DATABASE()
         ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`),
      q(`SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, NON_UNIQUE AS non_unique,
                COALESCE(COLUMN_NAME, '<expr>') AS column_name
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
         ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`),
      q(`SELECT k.CONSTRAINT_NAME AS name, k.TABLE_NAME AS table_name, k.COLUMN_NAME AS column_name,
                k.REFERENCED_TABLE_SCHEMA AS ref_schema, k.REFERENCED_TABLE_NAME AS ref_table,
                k.REFERENCED_COLUMN_NAME AS ref_column, r.UPDATE_RULE AS update_rule, r.DELETE_RULE AS delete_rule
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
         WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`),
      q(`SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type, TABLE_ROWS AS table_rows
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`),
      q(`SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES
         WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY ROUTINE_NAME`),
    ]);

    const colsBy = groupBy(cols, (r) => r.table_name);
    const statsBy = groupBy(stats, (r) => r.table_name);
    const fksBy = groupBy(fks, (r) => r.table_name);

    const tables: TableInfo[] = tbls.map((t) => {
      const name = String(t.table_name);
      const ixMap = new Map<string, IndexInfo>();
      for (const s of statsBy.get(name) ?? []) {
        let ix = ixMap.get(s.index_name);
        if (!ix) {
          ix = { name: s.index_name, columns: [], unique: Number(s.non_unique) === 0, primary: s.index_name === 'PRIMARY' };
          ixMap.set(s.index_name, ix);
        }
        ix.columns.push(s.column_name);
      }
      const pk = ixMap.get('PRIMARY')?.columns ?? [];
      const columns: ColumnInfo[] = (colsBy.get(name) ?? []).map((c) => ({
        name: c.column_name,
        type: c.column_type,
        nullable: c.is_nullable === 'YES',
        default: c.column_default == null ? null : String(c.column_default),
        isPrimaryKey: pk.includes(c.column_name),
        isIdentity: String(c.extra).includes('auto_increment'),
        comment: c.comment || null,
      }));
      const fkMap = new Map<string, ForeignKeyInfo>();
      for (const f of fksBy.get(name) ?? []) {
        let fk = fkMap.get(f.name);
        if (!fk) {
          fk = {
            name: f.name,
            columns: [],
            refTable: f.ref_table,
            refSchema: f.ref_schema === this.database ? undefined : f.ref_schema,
            refColumns: [],
            onDelete: f.delete_rule,
            onUpdate: f.update_rule,
          };
          fkMap.set(f.name, fk);
        }
        fk.columns.push(f.column_name);
        fk.refColumns.push(f.ref_column);
      }
      const isView = String(t.table_type).includes('VIEW');
      return {
        name,
        type: isView ? 'view' : 'table',
        columns,
        primaryKey: pk,
        foreignKeys: [...fkMap.values()],
        indexes: [...ixMap.values()],
        rowCount: isView ? null : t.table_rows == null ? null : Number(t.table_rows),
      };
    });

    return {
      kind: 'mysql',
      database: this.database,
      schemas: [],
      tables,
      routines: routines.map((r) => ({ name: r.name, type: r.type === 'PROCEDURE' ? 'procedure' : 'function' })),
      loadedAt: new Date().toISOString(),
    };
  }

  async getDdl(t: TableRef) {
    const [rows] = await this.pool.query({ sql: `SHOW CREATE TABLE ${this.qualify(t)}`, rowsAsArray: true });
    return String((rows as unknown[][])[0][1]) + ';';
  }

  async routineDefinition(r: RoutineInfo) {
    const kw = r.type === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
    const [rows] = await this.pool.query({ sql: `SHOW CREATE ${kw} ${this.quote(r.name)}`, rowsAsArray: true });
    // No DELIMITER needed: the server parses BEGIN…END bodies itself when sent as one statement.
    return String((rows as unknown[][])[0][2]) + ';';
  }

  async activity(): Promise<ActivitySession[]> {
    const [rows] = await this.pool.query(
      `SELECT ID AS id, USER AS user, HOST AS host, DB AS db, COMMAND AS command, TIME AS time, STATE AS state, INFO AS info,
              ID = CONNECTION_ID() AS is_self
       FROM information_schema.PROCESSLIST WHERE COMMAND <> 'Daemon' ORDER BY COMMAND = 'Sleep', TIME DESC`,
    );
    // Lock waits need the sys schema and PROCESS privilege; without them sessions are listed unlinked.
    const blocked = new Map<string, string[]>();
    try {
      const [waits] = await this.pool.query(`SELECT waiting_pid, blocking_pid FROM sys.innodb_lock_waits`);
      for (const w of waits as any[]) {
        const k = String(w.waiting_pid);
        blocked.set(k, [...(blocked.get(k) ?? []), String(w.blocking_pid)]);
      }
    } catch {
      /* not permitted */
    }
    return (rows as any[]).map((x) => ({
      id: String(x.id),
      user: x.user,
      database: x.db,
      client: x.host,
      state: x.command === 'Sleep' ? 'idle' : [x.command, x.state].filter(Boolean).join(' · '),
      durationMs: x.time == null ? null : Number(x.time) * 1000,
      query: x.info,
      wait: null,
      blockedBy: blocked.get(String(x.id)) ?? [],
      isSelf: !!Number(x.is_self),
    }));
  }

  async killSession(id: string, mode: 'cancel' | 'terminate') {
    if (!/^\d+$/.test(id)) throw new HttpError(400, 'Invalid session id');
    // KILL takes no placeholders; the id is validated as an integer above.
    await this.pool.query(`KILL ${mode === 'cancel' ? 'QUERY ' : ''}${Number(id)}`);
  }

  async security(): Promise<SecurityInfo> {
    let principals: Principal[] = [];
    let notes: string | undefined;
    try {
      const [users] = await this.pool.query(`SELECT User AS name, Host AS host, account_locked AS locked, authentication_string = '' AS no_pw FROM mysql.user ORDER BY User, Host`);
      const [edges] = await this.pool.query(`SELECT FROM_USER AS role, FROM_HOST AS role_host, TO_USER AS user, TO_HOST AS host FROM mysql.role_edges`);
      const memberOf = new Map<string, string[]>();
      for (const e of edges as any[]) {
        const k = `${e.user}@${e.host}`;
        memberOf.set(k, [...(memberOf.get(k) ?? []), e.role]);
      }
      const roleNames = new Set((edges as any[]).map((e) => `${e.role}@${e.role_host}`));
      principals = (users as any[])
        .filter((u) => !String(u.name).startsWith('mysql.'))
        .map((u) => {
          const isRole = roleNames.has(`${u.name}@${u.host}`) || (u.locked === 'Y' && !!Number(u.no_pw));
          return {
            name: u.name,
            host: u.host,
            kind: isRole ? 'role' : 'user',
            canLogin: !isRole && u.locked !== 'Y',
            memberOf: memberOf.get(`${u.name}@${u.host}`) ?? [],
          } as Principal;
        });
    } catch {
      notes = 'Listing accounts needs SELECT on mysql.user; showing grants only.';
    }
    const [tp] = await this.pool.query(
      `SELECT GRANTEE AS grantee, CONCAT(TABLE_SCHEMA, '.', TABLE_NAME) AS object, PRIVILEGE_TYPE AS privilege FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA = DATABASE()
       UNION ALL
       SELECT GRANTEE, CONCAT(TABLE_SCHEMA, '.*'), PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA = DATABASE()
       ORDER BY 1, 2, 3`,
    );
    return {
      principals,
      // GRANTEE comes as 'user'@'host'; show it as user@host to match the principal list.
      grants: (tp as any[]).map((g) => ({ principal: String(g.grantee).replace(/'/g, ''), object: g.object, privilege: g.privilege })),
      roles: principals.filter((p) => p.kind === 'role').map((p) => p.name),
      notes,
    };
  }

  async explain(sql: string, analyze: boolean): Promise<RawPlan> {
    if (analyze) {
      const [rows] = await this.pool.query({ sql: `EXPLAIN ANALYZE ${sql}`, rowsAsArray: true });
      return { format: 'mysql-tree', data: String((rows as unknown[][])[0][0]) };
    }
    const [rows] = await this.pool.query({ sql: `EXPLAIN FORMAT=JSON ${sql}`, rowsAsArray: true });
    return { format: 'mysql-json', data: JSON.parse(String((rows as unknown[][])[0][0])) };
  }
}
