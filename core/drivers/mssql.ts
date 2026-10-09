import sql from 'mssql';
import type { ActivitySession, ColumnInfo, ForeignKeyInfo, IndexInfo, Principal, RawPlan, ResultSet, RoutineInfo, SchemaSnapshot, SecurityInfo, TableInfo, TableRef } from '../../shared/types.ts';
import { Driver, groupBy, tkey, type Exec, type ExecResult } from './base.ts';
import { HttpError, MAX_RESULT_ROWS, serializeRows, splitGoBatches } from '../util.ts';

function formatType(r: Record<string, any>): string {
  const t = String(r.type_name);
  const len = Number(r.max_length);
  switch (t.toLowerCase()) {
    case 'varchar':
    case 'char':
    case 'varbinary':
    case 'binary':
      return `${t}(${len === -1 ? 'max' : len})`;
    case 'nvarchar':
    case 'nchar':
      return `${t}(${len === -1 ? 'max' : len / 2})`;
    case 'decimal':
    case 'numeric':
      return `${t}(${r.precision},${r.scale})`;
    case 'datetime2':
    case 'time':
    case 'datetimeoffset':
      return Number(r.scale) === 7 ? t : `${t}(${r.scale})`;
    default:
      return t;
  }
}

export class MssqlDriver extends Driver {
  readonly kind = 'mssql' as const;
  private pool!: sql.ConnectionPool;

  private config(): sql.config {
    const instance = this.cfg.instance?.trim();
    return {
      server: this.cfg.host || 'localhost',
      // A named instance (e.g. SQLEXPRESS) is resolved through the SQL Browser service unless a port is given.
      port: instance && !this.cfg.port ? undefined : this.cfg.port || 1433,
      user: this.cfg.user,
      password: this.cfg.password,
      database: this.database,
      pool: { max: 5, min: 0, idleTimeoutMillis: 60_000 },
      connectionTimeout: 15_000,
      requestTimeout: 0,
      options: {
        instanceName: instance || undefined,
        encrypt: this.cfg.encrypt ?? false,
        trustServerCertificate: this.cfg.trustServerCertificate ?? true,
        // Read date/time values as stored: tedious then builds Dates in UTC, which serializeValue prints without shifting.
        useUTC: true,
        appName: 'SchemaScope',
      },
    };
  }

  async connect() {
    this.pool = new sql.ConnectionPool(this.config());
    await this.pool.connect();
  }

  async close() {
    await this.pool?.close().catch(() => {});
  }

  async serverVersion() {
    const r = await this.pool.request().query(`SELECT @@VERSION AS v`);
    return String(r.recordset[0].v).split('\n')[0].trim();
  }

  async listDatabases() {
    const r = await this.pool
      .request()
      .query(`SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 AND state = 0 ORDER BY name`);
    return r.recordset.map((x: any) => String(x.name));
  }

  param(i: number) {
    return '@p' + (i + 1);
  }

  private async run(req: sql.Request, text: string, params: unknown[] = []): Promise<ExecResult> {
    params.forEach((v, i) => req.input('p' + (i + 1), v));
    req.arrayRowMode = true;
    const r = (await req.query(text)) as any;
    const cols: any[] = r.columns?.[0] ?? [];
    return {
      columns: cols.map((c) => c.name),
      rows: serializeRows((r.recordset ?? []) as unknown[][]),
      affected: (r.rowsAffected as number[]).reduce((a, b) => a + b, 0),
    };
  }

  exec: Exec = (text, params = []) => this.run(this.pool.request(), text, params);

  async transaction<T>(fn: (exec: Exec) => Promise<T>): Promise<T> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      const r = await fn((text, params = []) => this.run(new sql.Request(tx), text, params));
      await tx.commit();
      return r;
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }
  }

  protected paginate(base: string, order: string, offset: number, limit: number): string {
    return `${base} ORDER BY ${order || '(SELECT NULL)'} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }

  async runScript(text: string) {
    const results: ResultSet[] = [];
    const messages: string[] = [];
    for (const batch of splitGoBatches(text)) {
      const req = this.pool.request();
      req.arrayRowMode = true;
      req.on('info', (m: { message: string }) => messages.push(m.message));
      const r = (await req.query(batch)) as any;
      const sets: unknown[][][] = r.recordsets ?? [];
      sets.forEach((rows, i) => {
        const cols: any[] = r.columns?.[i] ?? [];
        const truncated = rows.length > MAX_RESULT_ROWS;
        const data = truncated ? rows.slice(0, MAX_RESULT_ROWS) : rows;
        results.push({ columns: cols.map((c) => c.name || `(No column name)`), rows: serializeRows(data), rowCount: data.length, truncated });
      });
      for (const n of r.rowsAffected as number[]) messages.push(`(${n} row(s) affected)`);
      if (!sets.length) {
        const affected = (r.rowsAffected as number[]).reduce((a, b) => a + b, 0);
        results.push({ columns: [], rows: [], rowCount: 0, affectedRows: affected });
      }
    }
    return { results, messages };
  }

  async getSchema(): Promise<SchemaSnapshot> {
    const q = async (text: string) => (await this.pool.request().query(text)).recordset as Record<string, any>[];
    const [cols, idx, fks, counts, routines, schemas] = await Promise.all([
      q(`SELECT s.name AS [schema], o.name AS [table], o.type AS otype, c.name AS [column],
                TYPE_NAME(c.user_type_id) AS type_name, c.max_length, c.precision, c.scale,
                c.is_nullable, c.is_identity, OBJECT_DEFINITION(c.default_object_id) AS default_value,
                CAST(ep.value AS nvarchar(4000)) AS comment
         FROM sys.objects o
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         JOIN sys.columns c ON c.object_id = o.object_id
         LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
         WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0
         ORDER BY s.name, o.name, c.column_id`),
      q(`SELECT s.name AS [schema], t.name AS [table], i.name AS [index], i.is_unique, i.is_primary_key, c.name AS [column]
         FROM sys.indexes i
         JOIN sys.objects t ON t.object_id = i.object_id
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE t.is_ms_shipped = 0 AND i.name IS NOT NULL AND ic.is_included_column = 0 AND t.type IN ('U','V')
         ORDER BY s.name, t.name, i.name, ic.key_ordinal`),
      q(`SELECT fk.name, s.name AS [schema], t.name AS [table], c.name AS [column],
                rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_column,
                fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update
         FROM sys.foreign_keys fk
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN sys.tables t ON t.object_id = fk.parent_object_id
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
         JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
         JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
         JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
         ORDER BY s.name, t.name, fk.name, fkc.constraint_column_id`),
      q(`SELECT s.name AS [schema], t.name AS [table], SUM(p.rows) AS n
         FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
         JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
         GROUP BY s.name, t.name`),
      q(`SELECT s.name AS [schema], o.name, o.type FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
         WHERE o.type IN ('P','FN','IF','TF') AND o.is_ms_shipped = 0 ORDER BY s.name, o.name`),
      q(`SELECT s.name FROM sys.schemas s
         WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA','guest') AND s.name NOT LIKE 'db[_]%' ORDER BY s.name`),
    ]);

    const k = (r: Record<string, any>) => tkey(r.schema, r.table);
    const idxBy = groupBy(idx, k);
    const fkBy = groupBy(fks, k);
    const countBy = new Map(counts.map((r) => [k(r), Number(r.n)]));

    const tables: TableInfo[] = [];
    for (const [key, rows] of groupBy(cols, k)) {
      const first = rows[0];
      const ixMap = new Map<string, IndexInfo>();
      for (const r of idxBy.get(key) ?? []) {
        let ix = ixMap.get(r.index);
        if (!ix) ixMap.set(r.index, (ix = { name: r.index, columns: [], unique: !!r.is_unique, primary: !!r.is_primary_key }));
        ix.columns.push(r.column);
      }
      const pk = [...ixMap.values()].find((i) => i.primary)?.columns ?? [];
      const fkMap = new Map<string, ForeignKeyInfo>();
      for (const r of fkBy.get(key) ?? []) {
        let fk = fkMap.get(r.name);
        if (!fk) {
          fk = {
            name: r.name,
            columns: [],
            refSchema: r.ref_schema,
            refTable: r.ref_table,
            refColumns: [],
            onDelete: String(r.on_delete).replace(/_/g, ' '),
            onUpdate: String(r.on_update).replace(/_/g, ' '),
          };
          fkMap.set(r.name, fk);
        }
        fk.columns.push(r.column);
        fk.refColumns.push(r.ref_column);
      }
      const columns: ColumnInfo[] = rows.map((r) => ({
        name: r.column,
        type: formatType(r),
        nullable: !!r.is_nullable,
        default: r.default_value ?? null,
        isPrimaryKey: pk.includes(r.column),
        isIdentity: !!r.is_identity,
        comment: r.comment,
      }));
      const isTable = String(first.otype).trim() === 'U';
      tables.push({
        schema: first.schema,
        name: first.table,
        type: isTable ? 'table' : 'view',
        columns,
        primaryKey: pk,
        foreignKeys: [...fkMap.values()],
        indexes: [...ixMap.values()],
        rowCount: isTable ? (countBy.get(key) ?? null) : null,
      });
    }

    return {
      kind: 'mssql',
      database: this.database,
      schemas: schemas.map((s) => s.name),
      tables,
      routines: routines.map((r) => ({
        schema: r.schema,
        name: r.name,
        type: String(r.type).trim() === 'P' ? 'procedure' : 'function',
      })),
      loadedAt: new Date().toISOString(),
    };
  }

  private async definition(schema: string | undefined, name: string): Promise<string | null> {
    const r = await this.pool
      .request()
      .input('s', schema ?? 'dbo')
      .input('n', name)
      .query(`SELECT OBJECT_DEFINITION(OBJECT_ID(QUOTENAME(@s) + '.' + QUOTENAME(@n))) AS def`);
    return r.recordset[0]?.def ?? null;
  }

  async viewDefinition(t: TableRef) {
    return this.definition(t.schema, t.name);
  }

  async routineDefinition(r: RoutineInfo) {
    return (await this.definition(r.schema, r.name)) ?? '-- definition unavailable (encrypted?)';
  }

  async activity(): Promise<ActivitySession[]> {
    const r = await this.pool.request().query(`
      SELECT CAST(s.session_id AS varchar(10)) AS id, s.login_name AS [user],
             DB_NAME(COALESCE(r.database_id, s.database_id)) AS [database],
             s.host_name + ISNULL(' / ' + s.program_name, '') AS client,
             COALESCE(r.status, s.status) AS state,
             DATEDIFF_BIG(ms, COALESCE(r.start_time, s.last_request_start_time), SYSDATETIME()) AS duration_ms,
             t.text AS query, r.wait_type AS wait,
             CAST(NULLIF(r.blocking_session_id, 0) AS varchar(10)) AS blocked_by,
             CASE WHEN s.session_id = @@SPID THEN 1 ELSE 0 END AS is_self
      FROM sys.dm_exec_sessions s
      LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
      OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
      WHERE s.is_user_process = 1
      ORDER BY CASE WHEN r.session_id IS NULL THEN 1 ELSE 0 END, duration_ms DESC`);
    return r.recordset.map((x: any) => ({
      id: x.id,
      user: x.user,
      database: x.database,
      client: x.client,
      state: x.state,
      durationMs: x.duration_ms == null ? null : Number(x.duration_ms),
      query: x.query,
      wait: x.wait,
      blockedBy: x.blocked_by ? [x.blocked_by] : [],
      isSelf: !!x.is_self,
    }));
  }

  async killSession(id: string) {
    if (!/^\d+$/.test(id)) throw new HttpError(400, 'Invalid session id');
    // KILL takes no parameters; the id is validated as an integer above. SQL Server has no "cancel only".
    await this.pool.request().query(`KILL ${Number(id)}`);
  }

  async security(): Promise<SecurityInfo> {
    const q = async (text: string) => (await this.pool.request().query(text)).recordset as Record<string, any>[];
    const [dbp, members, perms, logins] = await Promise.all([
      q(`SELECT dp.name, dp.type, dp.is_fixed_role, sp.name AS login_name
         FROM sys.database_principals dp LEFT JOIN sys.server_principals sp ON sp.sid = dp.sid
         WHERE dp.type IN ('S','U','G','R','E','X') AND dp.name NOT IN ('sys','INFORMATION_SCHEMA','guest','public')
         ORDER BY dp.name`),
      q(`SELECT m.name AS member, r.name AS role FROM sys.database_role_members rm
         JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
         JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id`),
      q(`SELECT pr.name AS principal,
                CASE WHEN p.class = 0 THEN 'DATABASE' ELSE SCHEMA_NAME(o.schema_id) + '.' + o.name END AS object,
                p.state_desc + ' ' + p.permission_name AS privilege
         FROM sys.database_permissions p
         JOIN sys.database_principals pr ON pr.principal_id = p.grantee_principal_id
         LEFT JOIN sys.objects o ON p.class = 1 AND o.object_id = p.major_id
         WHERE pr.name NOT IN ('public','guest') AND (p.class = 0 OR o.object_id IS NOT NULL) AND p.permission_name <> 'CONNECT'
         ORDER BY 1, 2`),
      q(`SELECT name FROM sys.server_principals WHERE type IN ('S','U','G') AND name NOT LIKE '##%' AND name NOT LIKE 'NT %' ORDER BY name`).catch(() => []),
    ]);
    const memberOf = new Map<string, string[]>();
    for (const m of members) memberOf.set(m.member, [...(memberOf.get(m.member) ?? []), m.role]);
    const users = dbp.filter((p) => String(p.type).trim() !== 'R');
    const roles = dbp.filter((p) => String(p.type).trim() === 'R');
    const mapped = new Set(users.map((u) => u.login_name).filter(Boolean));
    const principals: Principal[] = [
      ...users.map((u) => ({ name: u.name, kind: 'user' as const, canLogin: !!u.login_name, memberOf: memberOf.get(u.name) ?? [] })),
      ...roles.filter((r) => !r.is_fixed_role).map((r) => ({ name: r.name, kind: 'role' as const, canLogin: false, memberOf: memberOf.get(r.name) ?? [] })),
      ...logins.filter((l) => !mapped.has(l.name)).map((l) => ({ name: l.name, kind: 'login' as const, canLogin: true, memberOf: [] })),
    ];
    return {
      principals,
      grants: perms.map((p) => ({ principal: p.principal, object: p.object, privilege: p.privilege })),
      roles: roles.map((r) => r.name),
      notes: 'Logins without a user in this database are listed as “login”.',
    };
  }

  /** SHOWPLAN must be alone in its batch and on the same session as the query, so use a one-connection pool. */
  async explain(text: string, analyze: boolean): Promise<RawPlan> {
    const single = new sql.ConnectionPool({ ...this.config(), pool: { max: 1, min: 0 } });
    await single.connect();
    try {
      const flag = analyze ? 'STATISTICS XML' : 'SHOWPLAN_XML';
      await single.request().batch(`SET ${flag} ON`);
      try {
        const r = (await single.request().batch(text)) as any;
        const sets: any[][] = r.recordsets ?? [];
        // The plan is the last recordset with a single XML column.
        for (let i = sets.length - 1; i >= 0; i--) {
          const row = sets[i]?.[0];
          const v = row && Object.values(row)[0];
          if (typeof v === 'string' && v.includes('<ShowPlanXML')) return { format: 'mssql-xml', data: v };
        }
        throw new HttpError(400, 'SQL Server returned no plan for this statement');
      } finally {
        await single.request().batch(`SET ${flag} OFF`).catch(() => {});
      }
    } finally {
      await single.close().catch(() => {});
    }
  }
}
