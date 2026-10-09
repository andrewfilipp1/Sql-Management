export type KeyAccess = 'read' | 'write';

/** What the UI sees about an API key — the key itself is shown once at creation and stored only as a hash. */
export interface ApiKeyInfo {
  id: string;
  name: string;
  /** First characters of the key, to recognise it in lists. */
  prefix: string;
  access: KeyAccess;
  /** Connection ids this key may use; `'*'` means all. */
  connections: string[] | '*';
  createdAt: string;
  lastUsedAt?: string;
}

export type ParamType = 'string' | 'number' | 'boolean';

export interface EndpointParam {
  name: string;
  type: ParamType;
  required: boolean;
  default?: string;
}

/** A saved, parameterised query published as `GET|POST /v1/endpoints/<slug>`. */
export interface SavedEndpoint {
  id: string;
  slug: string;
  name: string;
  description?: string;
  connId: string;
  database: string;
  sql: string;
  params: EndpointParam[];
  /** Write endpoints run only for write keys on connections that are not read-only. */
  write: boolean;
}

export interface ServerSettings {
  enabled: boolean;
  port: number;
  /** Requests per minute per key. */
  rateLimit: number;
}

export interface RequestLogEntry {
  at: string;
  method: string;
  /** Path only — query strings can carry filter values (personal data), so they are not logged. */
  path: string;
  status: number;
  ms: number;
  key?: string;
}

export interface IntegrationsState {
  server: ServerSettings;
  running: boolean;
  url: string;
  error?: string;
  keys: ApiKeyInfo[];
  endpoints: SavedEndpoint[];
}

export const DEFAULT_SERVER: ServerSettings = { enabled: false, port: 4870, rateLimit: 120 };
