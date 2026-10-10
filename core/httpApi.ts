import http from 'node:http';
import type { ApiKeyInfo, RequestLogEntry } from '../shared/integrations.ts';
import type { Filter, FilterOp, TableInfo } from '../shared/types.ts';
import { coreApi, schemaFor } from './api.ts';
import { getEndpoint, getServerSettings, keyAllows, listEndpoints, verifyKey } from './integrations.ts';
import { handleMcp } from './mcp.ts';
import { getDriver } from './pool.ts';
import { getConnection, listConnections } from './store.ts';
import { HttpError } from './util.ts';
import { MAX_ROWS, runEndpoint, toObjects } from './endpoints.ts';

const MAX_BODY = 1024 * 1024;
const APP_VERSION = '0.2.0';

let server: http.Server | null = null;
let lastError: string | undefined;
const log: RequestLogEntry[] = [];
const buckets = new Map<string, { tokens: number; at: number }>();

export function serverStatus() {
  const s = getServerSettings();
  return { running: !!server?.listening, url: `http://127.0.0.1:${s.port}`, error: lastError };
}

export function requestLog(): RequestLogEntry[] {
  return [...log].reverse();
}

export async function stopServer() {
  const s = server;
  server = null;
  if (s) await new Promise<void>((r) => s.close(() => r()));
}

/** (Re)starts the server according to the saved settings. */
export async function applyServerSettings() {
  await stopServer();
  lastError = undefined;
  const settings = getServerSettings();
  if (!settings.enabled) return;
  const srv = http.createServer((req, res) => void handle(req, res));
  srv.requestTimeout = 120_000;
  srv.headersTimeout = 15_000;
  await new Promise<void>((resolve) => {
    srv.once('error', (e: NodeJS.ErrnoException) => {
      lastError = e.code === 'EADDRINUSE' ? `Port ${settings.port} is already in use` : e.message;
      resolve();
    });
    // Loopback only. Exposing this on the network would need TLS and is deliberately not offered.
    srv.listen(settings.port, '127.0.0.1', () => {
      server = srv;
      resolve();
    });
  });
}

// ---------------- plumbing ----------------

class Res {
  status = 200;
  constructor(public raw: http.ServerResponse) {}
  json(status: number, body: unknown) {
    this.status = status;
    const data = JSON.stringify(body);
    this.raw.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-length': Buffer.byteLength(data),
    });
    this.raw.end(data);
  }
  empty(status: number, headers: Record<string, string> = {}) {
    this.status = status;
    this.raw.writeHead(status, { 'cache-control': 'no-store', ...headers });
    this.raw.end();
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large (max 1 MB)');
    chunks.push(c as Buffer);
  }
  if (!size) return undefined;
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Use Content-Type: application/json');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function rateLimited(key: ApiKeyInfo): number {
  const perMin = getServerSettings().rateLimit;
  const now = Date.now();
  const b = buckets.get(key.id) ?? { tokens: perMin, at: now };
  b.tokens = Math.min(perMin, b.tokens + ((now - b.at) / 60_000) * perMin);
  b.at = now;
  buckets.set(key.id, b);
  if (b.tokens < 1) return Math.ceil(((1 - b.tokens) / perMin) * 60);
  b.tokens -= 1;
  return 0;
}

async function handle(req: http.IncomingMessage, raw: http.ServerResponse) {
  const started = performance.now();
  const res = new Res(raw);
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  let key: ApiKeyInfo | null = null;
  try {
    const port = getServerSettings().port;
    // DNS-rebinding protection: only accept requests addressed to the loopback host.
    const host = String(req.headers.host ?? '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(421, 'Unexpected Host header');
    // Browsers always send Origin on cross-site requests; this API is for local tools, not web pages.
    if (req.headers.origin) throw new HttpError(403, 'Browser requests are not allowed');

    if (url.pathname === '/v1/health') return res.json(200, { ok: true, version: APP_VERSION });

    const auth = String(req.headers.authorization ?? '');
    key = auth.startsWith('Bearer ') ? verifyKey(auth.slice(7).trim()) : null;
    if (!key) return res.json(401, { error: 'Missing or invalid API key' });
    const wait = rateLimited(key);
    if (wait) {
      res.status = 429;
      raw.writeHead(429, { 'retry-after': String(wait), 'content-type': 'application/json' });
      raw.end(JSON.stringify({ error: 'Rate limit exceeded' }));
      return;
    }

    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') return res.empty(405, { allow: 'POST' });
      const reply = await handleMcp(await readBody(req), key);
      return reply === null ? res.empty(202) : res.json(200, reply);
    }

    await route(req, res, url, key);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    const message = (e as { originalError?: { message?: string } }).originalError?.message || (e as Error).message || 'Error';
    if (!raw.headersSent) res.json(status, { error: message });
  } finally {
    log.push({
      at: new Date().toISOString(),
      method: req.method ?? '?',
      path: url.pathname,
      status: res.status,
      ms: Math.round(performance.now() - started),
      key: key?.name,
    });
    if (log.length > 200) log.shift();
  }
}

// ---------------- REST routes ----------------

function requireConnection(key: ApiKeyInfo, connId: string) {
  const cfg = getConnection(connId);
  if (!cfg || !keyAllows(key, connId)) throw new HttpError(404, 'Connection not found');
  return cfg;
}

async function requireTable(connId: string, db: string, name: string): Promise<TableInfo> {
  const s = await schemaFor(connId, db);
  const [schema, table] = name.includes('.') ? [name.slice(0, name.indexOf('.')), name.slice(name.indexOf('.') + 1)] : [undefined, name];
  const t =
    s.tables.find((x) => x.name === table && (schema === undefined || x.schema === schema)) ??
    s.tables.find((x) => x.name === name);
  if (!t) throw new HttpError(404, `Table not found: ${name}`);
  return t;
}

const OPS = new Set<FilterOp>(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is']);
const RESERVED = new Set(['limit', 'offset', 'order', 'select']);

/** `?status=eq.paid&total=gte.100&id=in.(1,2,3)` → structured filters (PostgREST-style). */
function parseFilters(q: URLSearchParams): Filter[] {
  const out: Filter[] = [];
  for (const [column, raw] of q) {
    if (RESERVED.has(column)) continue;
    const dot = raw.indexOf('.');
    const op = (dot > 0 ? raw.slice(0, dot) : '') as FilterOp;
    if (!OPS.has(op)) throw new HttpError(400, `Filter ${column}: use <op>.<value>, op one of ${[...OPS].join(', ')}`);
    const v = raw.slice(dot + 1);
    if (op === 'in') {
      const m = /^\((.*)\)$/.exec(v);
      if (!m) throw new HttpError(400, `Filter ${column}: in.(a,b,c)`);
      out.push({ column, op, value: m[1] ? m[1].split(',') : [] });
    } else out.push({ column, op, value: v });
  }
  return out;
}

async function route(req: http.IncomingMessage, res: Res, url: URL, key: ApiKeyInfo) {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const method = req.method ?? 'GET';
  const q = url.searchParams;

  if (parts[0] !== 'v1') throw new HttpError(404, 'Not found');

  // /v1/openapi.json
  if (parts[1] === 'openapi.json' && parts.length === 2) return res.json(200, openApiDoc(key));

  // /v1/connections
  if (parts[1] === 'connections' && parts.length === 2 && method === 'GET') {
    return res.json(
      200,
      listConnections()
        .filter((c) => keyAllows(key, c.id))
        .map((c) => ({ id: c.id, name: c.name, kind: c.kind, environment: c.environment ?? 'development', readOnly: !!c.readOnly })),
    );
  }

  // /v1/connections/:id/databases[/:db/tables[/:table[/rows]]]
  if (parts[1] === 'connections' && parts[2]) {
    const cfg = requireConnection(key, parts[2]);
    if (parts.length === 4 && parts[3] === 'databases' && method === 'GET') {
      return res.json(200, (await coreApi.connect(cfg.id)).databases);
    }
    const db = parts[4];
    if (parts[3] !== 'databases' || !db || parts[5] !== 'tables') throw new HttpError(404, 'Not found');

    if (parts.length === 6 && method === 'GET') {
      const s = await schemaFor(cfg.id, db);
      return res.json(
        200,
        s.tables.map((t) => ({ schema: t.schema, name: t.name, type: t.type, rowCount: t.rowCount ?? null, columns: t.columns.length })),
      );
    }

    const table = await requireTable(cfg.id, db, parts[6]);
    if (parts.length === 7 && method === 'GET') {
      return res.json(200, {
        schema: table.schema,
        name: table.name,
        type: table.type,
        primaryKey: table.primaryKey,
        columns: table.columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable, default: c.default, identity: c.isIdentity })),
        foreignKeys: table.foreignKeys,
        indexes: table.indexes,
      });
    }

    if (parts.length === 8 && parts[7] === 'rows') {
      const d = await getDriver(cfg.id, db);
      const filters = parseFilters(q);
      if (method === 'GET') {
        const limit = Math.min(MAX_ROWS, Math.max(1, Number(q.get('limit') ?? 100) || 100));
        const offset = Math.max(0, Number(q.get('offset') ?? 0) || 0);
        const [orderBy, dir] = (q.get('order') ?? '').split('.');
        const columns = q.get('select')?.split(',').filter(Boolean);
        const r = await d.getRows(
          { table, offset, limit, filters, columns, orderBy: orderBy || undefined, orderDir: dir === 'desc' ? 'desc' : 'asc' },
          table,
        );
        return res.json(200, { rows: toObjects(r.columns, r.rows), total: r.total, limit, offset });
      }

      // Writes
      if (key.access !== 'write') throw new HttpError(403, 'This API key is read-only');
      if (cfg.readOnly) throw new HttpError(403, 'This connection is read-only');
      if (table.type !== 'table') throw new HttpError(400, 'Views cannot be modified');
      const body = await readBody(req);
      if (method === 'POST') {
        const rows = Array.isArray(body) ? body : [body];
        if (!rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) throw new HttpError(400, 'Body must be an object or an array of objects');
        return res.json(201, { inserted: await d.insertRows(table, rows as Record<string, unknown>[]) });
      }
      if (method === 'PATCH') {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be an object of column values');
        return res.json(200, { updated: await d.mutateWhere(table, filters, body as Record<string, unknown>) });
      }
      if (method === 'DELETE') return res.json(200, { deleted: await d.mutateWhere(table, filters, null) });
      throw new HttpError(405, 'Method not allowed');
    }
    throw new HttpError(404, 'Not found');
  }

  // /v1/endpoints[/:slug]
  if (parts[1] === 'endpoints') {
    if (parts.length === 2 && method === 'GET') {
      return res.json(
        200,
        listEndpoints()
          .filter((e) => keyAllows(key, e.connId))
          .map((e) => ({ slug: e.slug, name: e.name, description: e.description, params: e.params, write: e.write })),
      );
    }
    const ep = parts.length === 3 ? getEndpoint(parts[2]) : undefined;
    if (!ep || !keyAllows(key, ep.connId)) throw new HttpError(404, 'Endpoint not found');
    if (method !== 'GET' && method !== 'POST') throw new HttpError(405, 'Use GET or POST');
    const raw: Record<string, unknown> = Object.fromEntries(q);
    if (method === 'POST') Object.assign(raw, ((await readBody(req)) as Record<string, unknown>) ?? {});
    return res.json(200, await runEndpoint(ep, raw, key.access));
  }

  throw new HttpError(404, 'Not found');
}

// ---------------- OpenAPI ----------------

function openApiDoc(key: ApiKeyInfo) {
  const settings = getServerSettings();
  const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  const pathParams = ['id', 'db', 'table'].map((n) => ({ name: n, in: 'path', required: true, schema: { type: 'string' } }));
  const paths: Record<string, unknown> = {
    '/v1/connections': { get: { summary: 'List connections this key can use', responses: { 200: { description: 'OK' }, 401: err } } },
    '/v1/connections/{id}/databases': {
      get: { summary: 'List databases', parameters: pathParams.slice(0, 1), responses: { 200: { description: 'OK' }, 404: err } },
    },
    '/v1/connections/{id}/databases/{db}/tables': {
      get: { summary: 'List tables and views', parameters: pathParams.slice(0, 2), responses: { 200: { description: 'OK' } } },
    },
    '/v1/connections/{id}/databases/{db}/tables/{table}': {
      get: { summary: 'Describe a table (columns, keys, indexes)', parameters: pathParams, responses: { 200: { description: 'OK' } } },
    },
    '/v1/connections/{id}/databases/{db}/tables/{table}/rows': {
      get: {
        summary: 'Read rows',
        description: 'Filters: `?column=op.value` with op in eq, neq, gt, gte, lt, lte, like, ilike, in.(a,b), is.null|notnull.',
        parameters: [
          ...pathParams,
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: MAX_ROWS, default: 100 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'order', in: 'query', schema: { type: 'string' }, example: 'created_at.desc' },
          { name: 'select', in: 'query', schema: { type: 'string' }, example: 'id,name' },
        ],
        responses: { 200: { description: 'OK' }, 400: err },
      },
      post: { summary: 'Insert one row (object) or many (array) — write keys only', parameters: pathParams, responses: { 201: { description: 'Created' }, 403: err } },
      patch: { summary: 'Update rows matching the filters — write keys only, filters required', parameters: pathParams, responses: { 200: { description: 'OK' }, 403: err } },
      delete: { summary: 'Delete rows matching the filters — write keys only, filters required', parameters: pathParams, responses: { 200: { description: 'OK' }, 403: err } },
    },
    '/v1/endpoints': { get: { summary: 'List saved query endpoints', responses: { 200: { description: 'OK' } } } },
  };
  for (const ep of listEndpoints().filter((e) => keyAllows(key, e.connId))) {
    const op = {
      summary: ep.name,
      description: ep.description,
      parameters: ep.params.map((p) => ({ name: p.name, in: 'query', required: p.required && p.default === undefined, schema: { type: p.type } })),
      responses: { 200: { description: 'OK' }, 400: err },
    };
    paths[`/v1/endpoints/${ep.slug}`] = ep.write ? { post: op } : { get: op, post: op };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'SQL Graphic Tool local API', version: APP_VERSION },
    servers: [{ url: `http://127.0.0.1:${settings.port}` }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: { Error: { type: 'object', properties: { error: { type: 'string' } } } },
    },
    paths,
  };
}
