export type DbKind = 'sqlite' | 'postgres' | 'mysql' | 'mssql';

export interface ConnectionConfig {
  id: string;
  name: string;
  kind: DbKind;
  color?: string;
  /** SQLite: absolute path to the database file */
  file?: string;
  readOnly?: boolean;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  /** Default / initial database */
  database?: string;
  /** SQL Server named instance, e.g. SQLEXPRESS */
  instance?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  ssl?: boolean;
  /** Production connections are highlighted and ask before destructive statements. */
  environment?: ConnectionEnvironment;
  /** SSH tunnel (server databases only). */
  sshEnabled?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshPassword?: string;
  /** Path to a private key file on this machine. */
  sshKeyFile?: string;
  sshPassphrase?: string;
}

export type ConnectionEnvironment = 'development' | 'staging' | 'production';

/** What the main process sends to the renderer: secrets never leave the main process. */
export type PublicConnection = Omit<ConnectionConfig, 'password' | 'sshPassword' | 'sshPassphrase'> & {
  hasPassword: boolean;
  hasSshPassword: boolean;
  hasSshPassphrase: boolean;
};

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
  isIdentity: boolean;
  comment?: string | null;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface TableInfo {
  schema?: string;
  name: string;
  type: 'table' | 'view';
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
  rowCount?: number | null;
}

export interface RoutineInfo {
  schema?: string;
  name: string;
  type: 'procedure' | 'function';
}

export interface SchemaSnapshot {
  kind: DbKind;
  database: string;
  schemas: string[];
  tables: TableInfo[];
  routines: RoutineInfo[];
  loadedAt: string;
}

export interface TableRef {
  schema?: string;
  name: string;
}

export interface ResultSet {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  affectedRows?: number;
  truncated?: boolean;
}

export interface QueryResponse {
  results: ResultSet[];
  messages: string[];
  durationMs: number;
}

export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'is';

/** Structured filter, always compiled to parameterised SQL (used by the REST API and MCP). */
export interface Filter {
  column: string;
  op: FilterOp;
  value: unknown;
}

export interface RowsRequest {
  table: TableRef;
  offset: number;
  limit: number;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  /** Raw SQL condition typed by the user in the desktop UI. Never accepted from the REST API. */
  where?: string;
  filters?: Filter[];
  /** Subset of columns to return. */
  columns?: string[];
  /** Skip the COUNT(*) (cheaper for API calls). */
  noCount?: boolean;
}

export interface RowsResponse extends ResultSet {
  total: number | null;
  primaryKey: string[];
  durationMs: number;
}

export type RowChange =
  | { type: 'insert'; values: Record<string, unknown> }
  | { type: 'update'; key: Record<string, unknown>; values: Record<string, unknown> }
  | { type: 'delete'; key: Record<string, unknown> };

export interface ApplyChangesRequest {
  table: TableRef;
  changes: RowChange[];
}

export interface ConnectResponse {
  databases: string[];
  defaultDatabase: string;
  serverVersion?: string;
}

export interface FsEntry {
  name: string;
  path: string;
  dir: boolean;
}

export const KIND_LABEL: Record<DbKind, string> = {
  sqlite: 'SQLite',
  postgres: 'PostgreSQL',
  mysql: 'MySQL / MariaDB',
  mssql: 'SQL Server',
};

export const DEFAULT_PORT: Partial<Record<DbKind, number>> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
};

export function tableKey(t: TableRef): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

// ---------------- DBA tools ----------------

export interface ActivitySession {
  id: string;
  user?: string | null;
  database?: string | null;
  client?: string | null;
  state?: string | null;
  durationMs?: number | null;
  query?: string | null;
  wait?: string | null;
  /** Session ids this one is waiting on. */
  blockedBy: string[];
  isSelf?: boolean;
}

export interface Principal {
  name: string;
  kind: 'login' | 'user' | 'role';
  canLogin: boolean;
  superuser?: boolean;
  /** MySQL account host part. */
  host?: string | null;
  memberOf: string[];
}

export interface Grant {
  principal: string;
  object: string;
  privilege: string;
}

export interface SecurityInfo {
  principals: Principal[];
  grants: Grant[];
  /** Roles that can be granted (includes built-in roles such as db_datareader). */
  roles: string[];
  notes?: string;
}

export type PlanFormat = 'pg-json' | 'mysql-json' | 'mysql-tree' | 'mssql-xml' | 'sqlite-rows';
export interface RawPlan {
  format: PlanFormat;
  data: unknown;
}

export type BackupMethod = 'sqlite-file' | 'mssql-native' | 'pg_dump' | 'mysqldump' | 'none';
export interface BackupInfo {
  method: BackupMethod;
  /** Dump tool found on this machine (pg_dump / mysqldump). */
  tool?: string;
  /** SQL Server's default backup folder (on the server). */
  defaultDir?: string;
  note?: string;
}
