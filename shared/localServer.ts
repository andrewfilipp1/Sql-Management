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
  error?: string;
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
