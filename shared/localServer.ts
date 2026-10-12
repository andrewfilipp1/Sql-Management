/** One-click local SQL Server: Docker on macOS, SQL Server Express (winget) on Windows. */

export type SetupStatus = 'pending' | 'checking' | 'ok' | 'missing' | 'working' | 'done' | 'failed' | 'skipped';

export interface SetupStep {
  id: string;
  label: string;
  status: SetupStatus;
  /** Short progress / result text. */
  detail?: string;
  /** 0–100 while downloading. */
  percent?: number;
}

export type LocalEdition = 'Express' | 'Developer';

export interface LocalServerState {
  platform: string;
  /** Can this computer run a local SQL Server through the app? */
  supported: boolean;
  unsupportedReason?: string;
  steps: SetupStep[];
  busy: boolean;
  /** Everything is installed and running. */
  ready: boolean;
  /** Saved connection to the local server. */
  connId?: string;
  /** Database created by the last install, opened when it finishes. */
  database?: string;
  /** Settings of a server that already exists (fixed until it is recreated). */
  server?: LocalServerInfo;
  /** A free port to suggest for a new server. */
  suggestedPort?: number;
  error?: string;
}

export interface LocalServerInfo {
  host: string;
  port?: number;
  user?: string;
  edition?: LocalEdition;
  collation?: string;
}

/** What the user chose before pressing Install. Server settings apply when the server is first created. */
export interface LocalServerOptions {
  acceptLicenses: boolean;
  /** Connection name in the sidebar. */
  name?: string;
  edition?: LocalEdition;
  port?: number;
  /** Own sa password; empty = generate a strong one. */
  password?: string;
  serverCollation?: string;
  /** Create this database once the server is up. */
  database?: { name: string; collation?: string };
}

export const LOCAL_SERVER_NAME = 'Local SQL Server';
export const DEFAULT_LOCAL_DATABASE = 'MyDatabase';
export const DEFAULT_SERVER_COLLATION = 'SQL_Latin1_General_CP1_CI_AS';
/** Server collations offered for a new local server (first is SQL Server's own default). */
export const SERVER_COLLATIONS = [DEFAULT_SERVER_COLLATION, 'Greek_CI_AS', 'Latin1_General_CI_AS', 'Latin1_General_100_CI_AS_SC_UTF8'];

/** SQL Server's password policy for sa: 8–128 characters from at least three of upper, lower, digits, symbols. */
export function saPasswordProblem(p: string): string | null {
  if (p.length < 8) return 'At least 8 characters';
  if (p.length > 128) return 'At most 128 characters';
  const kinds = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  if (kinds < 3) return 'Use at least three of: uppercase, lowercase, digits, symbols';
  return null;
}

export function portProblem(port: number): string | null {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return 'Use a port between 1024 and 65535';
  return null;
}

export const LOCAL_SERVER_EVENT = 'schemascope:local-server';

export const LICENSES = {
  docker: 'https://www.docker.com/legal/docker-subscription-service-agreement/',
  sqlServer: 'https://www.microsoft.com/en-us/legal/terms-of-use',
  sqlExpress: 'https://www.microsoft.com/en-us/sql-server/sql-server-downloads',
};

export interface CreateDatabaseOptions {
  /** SQL Server / MySQL collation. */
  collation?: string;
  /** PostgreSQL encoding (UTF8). */
  encoding?: string;
  /** MySQL character set. */
  charset?: string;
}

export const MSSQL_COLLATIONS = ['', 'Greek_CI_AS', 'Latin1_General_CI_AS', 'SQL_Latin1_General_CP1_CI_AS', 'Latin1_General_100_CI_AS_SC_UTF8'];
export const MYSQL_COLLATIONS = ['utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci', 'utf8mb4_general_ci', 'utf8mb4_el_0900_ai_ci'];

/** Safe for an identifier we create: letters (any alphabet), digits, _ and -, starting with a letter or _. */
export function databaseNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Enter a name';
  if (n.length > 63) return 'At most 63 characters';
  if (!/^[\p{L}_][\p{L}\p{N}_-]*$/u.test(n)) return 'Use letters, digits, _ or -, starting with a letter';
  return null;
}
