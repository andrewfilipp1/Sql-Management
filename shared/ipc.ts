import type {
  ActivitySession,
  ApplyChangesRequest,
  BackupInfo,
  RawPlan,
  SecurityInfo,
  ConnectionConfig,
  ConnectResponse,
  PublicConnection,
  QueryResponse,
  RoutineInfo,
  RowsRequest,
  RowsResponse,
  SchemaSnapshot,
  TableRef,
} from './types.ts';
import type { UpdateState } from './update.ts';
import type { Notebook, NotebookSummary } from './notebook.ts';
import type { AiRequest, AiResponse, AiSettings, AiState } from './ai.ts';
import type { ApiKeyInfo, IntegrationsState, KeyAccess, RequestLogEntry, SavedEndpoint, ServerSettings } from './integrations.ts';

export type ConnectionInput = Partial<ConnectionConfig> & { keepPassword?: boolean };

/**
 * The full contract between the renderer and the main process.
 * To add a feature: add a method here, implement it in core/api.ts — the
 * renderer gets a typed `api.<method>()` automatically.
 */
export interface Api {
  listConnections(): Promise<PublicConnection[]>;
  saveConnection(c: ConnectionInput): Promise<PublicConnection>;
  deleteConnection(id: string): Promise<void>;
  testConnection(c: ConnectionInput): Promise<{ version: string; durationMs: number }>;
  connect(id: string): Promise<ConnectResponse>;
  disconnect(id: string): Promise<void>;

  schema(connId: string, database: string, refresh?: boolean): Promise<SchemaSnapshot>;
  query(connId: string, database: string, sql: string, opts?: { confirmed?: boolean }): Promise<QueryResponse>;
  rows(connId: string, database: string, req: RowsRequest): Promise<RowsResponse>;
  apply(connId: string, database: string, req: ApplyChangesRequest): Promise<{ affected: number }>;
  ddl(connId: string, database: string, table: TableRef): Promise<string>;
  routine(connId: string, database: string, r: RoutineInfo): Promise<string>;

  /** Local REST API / MCP server, API keys and saved endpoints. */
  integrations(): Promise<IntegrationsState>;
  setServer(patch: Partial<ServerSettings>): Promise<IntegrationsState>;
  createApiKey(input: { name: string; access: KeyAccess; connections: string[] | '*' }): Promise<{ key: string; info: ApiKeyInfo }>;
  revokeApiKey(id: string): Promise<void>;
  saveEndpoint(e: SavedEndpoint): Promise<SavedEndpoint>;
  deleteEndpoint(id: string): Promise<void>;
  testEndpoint(e: SavedEndpoint, params: Record<string, unknown>): Promise<{ rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; affected?: number; durationMs: number }>;
  requestLog(): Promise<RequestLogEntry[]>;

  /** Import / export. File paths never come from the renderer: the main process asks the user. */
  pickCsv(): Promise<CsvPreview | null>;
  importCsv(req: ImportCsvRequest): Promise<{ inserted: number; table: TableRef }>;
  bulkInsert(connId: string, database: string, table: TableRef, columns: string[], rows: unknown[][]): Promise<number>;
  exportScript(connId: string, database: string, opts: { includeData: boolean; tables?: string[] }): Promise<{ file: string; tables: number; rows: number } | null>;

  /** Backup & restore. */
  backupInfo(connId: string, database: string): Promise<BackupInfo>;
  backup(connId: string, database: string, opts: { format?: 'custom' | 'plain' }): Promise<{ file: string } | null>;
  restore(connId: string, database: string): Promise<{ file: string } | null>;

  /** Server activity, security and plans. */
  activity(connId: string, database: string): Promise<ActivitySession[]>;
  killSession(connId: string, database: string, id: string, mode: 'cancel' | 'terminate'): Promise<void>;
  security(connId: string, database: string): Promise<SecurityInfo>;
  explain(connId: string, database: string, sql: string, analyze: boolean): Promise<RawPlan>;

  /** AI assistant. The provider key is write-only: it is never returned to the renderer. */
  aiState(): Promise<AiState>;
  saveAiSettings(patch: Partial<AiSettings>, key?: string): Promise<AiState>;
  aiModels(): Promise<string[]>;
  ask(req: AiRequest): Promise<AiResponse>;

  /** SQL notebooks. */
  listNotebooks(): Promise<NotebookSummary[]>;
  getNotebook(id: string): Promise<Notebook>;
  saveNotebook(nb: Notebook): Promise<Notebook>;
  deleteNotebook(id: string): Promise<void>;

  /** App updates (main process). */
  updateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<void>;

  /** Native dialogs (implemented in the Electron main process). */
  pickSqliteFile(mode: 'open' | 'create'): Promise<string | null>;
  saveTextFile(defaultName: string, content: string): Promise<boolean>;
}

export type ApiMethod = keyof Api;

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string; details?: unknown };

/** Shape exposed on `window.schemascope` by the preload script. */
export interface Bridge {
  invoke(method: ApiMethod, ...args: unknown[]): Promise<IpcResult<unknown>>;
  /** Update status pushed by the main process. Returns an unsubscribe function. */
  onUpdate(cb: (state: UpdateState) => void): () => void;
  platform: string;
}

export const IPC_CHANNEL = 'schemascope:api';

export interface CsvPreview {
  /** Opaque handle to the file loaded in the main process. */
  token: string;
  fileName: string;
  delimiter: string;
  headers: string[];
  types: ('integer' | 'decimal' | 'boolean' | 'date' | 'datetime' | 'text')[];
  rowCount: number;
  preview: string[][];
}

export interface ImportCsvRequest {
  token: string;
  connId: string;
  database: string;
  /** Existing table to import into… */
  table?: TableRef;
  /** …or a new table to create from the CSV columns. */
  createTable?: { schema?: string; name: string };
  /** Target column → CSV column index (null = skip). */
  mapping: Record<string, number | null>;
  emptyAsNull?: boolean;
}
