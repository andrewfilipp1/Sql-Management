import type { ApiKeyInfo } from '../shared/integrations.ts';
import { coreApi, guardScript, schemaFor } from './api.ts';
import { keyAllows, listEndpoints } from './integrations.ts';
import { runEndpoint } from './endpoints.ts';
import { listConnections } from './store.ts';
import { classifyScript, CodedError, HttpError } from './util.ts';

/**
 * Minimal MCP server over Streamable HTTP (JSON responses, no streaming), so AI agents
 * (Claude Code, Claude Desktop via mcp-remote, other MCP clients) can explore the databases
 * this API key is allowed to see. Same rules as the UI: read-only keys never write, and
 * destructive statements on production connections are refused (there is no confirm step here).
 */

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_TOOL_ROWS = 200;

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const str = { type: 'string' } as const;
const TOOLS = [
  {
    name: 'list_connections',
    description: 'List the database connections available to this key (id, name, engine, environment).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tables',
    description: 'List tables and views in a database, with row counts and relationship counts.',
    inputSchema: {
      type: 'object',
      properties: { connection: { ...str, description: 'Connection id or name' }, database: { ...str, description: 'Database (optional)' } },
      required: ['connection'],
    },
  },
  {
    name: 'describe_table',
    description: 'Columns, primary key, foreign keys (relationships) and indexes of one table.',
    inputSchema: {
      type: 'object',
      properties: { connection: str, database: str, table: { ...str, description: 'Table name, optionally schema.table' } },
      required: ['connection', 'table'],
    },
  },
  {
    name: 'run_query',
    description: `Run one SQL script and return up to ${MAX_TOOL_ROWS} rows of the first result. Read-only keys can only run SELECT-style statements.`,
    inputSchema: {
      type: 'object',
      properties: { connection: str, database: str, sql: str },
      required: ['connection', 'sql'],
    },
  },
  {
    name: 'run_endpoint',
    description: 'Run a saved, parameterised query endpoint by slug.',
    inputSchema: {
      type: 'object',
      properties: { slug: str, params: { type: 'object', description: 'Parameter values' } },
      required: ['slug'],
    },
  },
];

function resolveConnection(key: ApiKeyInfo, ref: unknown) {
  const r = String(ref ?? '');
  const c = listConnections().find((x) => (x.id === r || x.name.toLowerCase() === r.toLowerCase()) && keyAllows(key, x.id));
  if (!c) throw new HttpError(404, `Unknown connection: ${r}. Call list_connections first.`);
  return c;
}

async function resolveDatabase(connId: string, db: unknown): Promise<string> {
  if (typeof db === 'string' && db) return db;
  return (await coreApi.connect(connId)).defaultDatabase;
}

function text(t: string, structured?: unknown) {
  return { content: [{ type: 'text', text: t }], ...(structured !== undefined ? { structuredContent: structured } : {}) };
}

async function callTool(key: ApiKeyInfo, name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'list_connections': {
      const list = listConnections()
        .filter((c) => keyAllows(key, c.id))
        .map((c) => ({ id: c.id, name: c.name, engine: c.kind, environment: c.environment ?? 'development', readOnly: !!c.readOnly }));
      return text(JSON.stringify(list, null, 2), { connections: list });
    }
    case 'list_tables': {
      const c = resolveConnection(key, args.connection);
      const db = await resolveDatabase(c.id, args.database);
      const s = await schemaFor(c.id, db);
      const list = s.tables.map((t) => ({
        table: t.schema ? `${t.schema}.${t.name}` : t.name,
        type: t.type,
        rows: t.rowCount ?? null,
        references: t.foreignKeys.map((f) => f.refTable),
      }));
      return text(`Database ${db} (${c.kind}):\n` + JSON.stringify(list, null, 2), { database: db, tables: list });
    }
    case 'describe_table': {
      const c = resolveConnection(key, args.connection);
      const db = await resolveDatabase(c.id, args.database);
      const s = await schemaFor(c.id, db);
      const name = String(args.table ?? '');
      const t = s.tables.find((x) => x.name === name || `${x.schema}.${x.name}` === name);
      if (!t) throw new HttpError(404, `Table not found: ${name}`);
      const info = {
        table: t.schema ? `${t.schema}.${t.name}` : t.name,
        type: t.type,
        primaryKey: t.primaryKey,
        columns: t.columns.map((col) => ({ name: col.name, type: col.type, nullable: col.nullable, default: col.default })),
        foreignKeys: t.foreignKeys.map((f) => ({ columns: f.columns, references: `${f.refTable}(${f.refColumns.join(', ')})` })),
        indexes: t.indexes.map((i) => ({ name: i.name, columns: i.columns, unique: i.unique })),
      };
      return text(JSON.stringify(info, null, 2), info);
    }
    case 'run_query': {
      const c = resolveConnection(key, args.connection);
      const db = await resolveDatabase(c.id, args.database);
      const sql = String(args.sql ?? '');
      if (key.access === 'read' && classifyScript(sql, c.kind === 'mssql').writes > 0) {
        throw new HttpError(403, 'This API key is read-only; only SELECT-style statements are allowed.');
      }
      try {
        guardScript(c.id, sql, false); // read-only connections + production destructive statements
      } catch (e) {
        if ((e as CodedError).code !== 'CONFIRM_REQUIRED') throw e;
        const items = ((e as CodedError).details as string[]).join('; ');
        throw new HttpError(403, `Refused: destructive statement on a production connection (${items}). Run it from the SchemaScope app if it is intended.`);
      }
      const r = await coreApi.query(c.id, db, sql);
      const first = r.results.find((x) => x.columns.length);
      if (!first) return text(r.messages.join('\n') || 'OK');
      const rows = first.rows.slice(0, MAX_TOOL_ROWS);
      const objects = rows.map((row) => Object.fromEntries(first.columns.map((col, i) => [col, row[i]])));
      const more = first.rows.length > rows.length || first.truncated ? `\n(${first.rowCount} rows, first ${rows.length} shown)` : '';
      return text(JSON.stringify(objects, null, 2) + more, { columns: first.columns, rows: objects });
    }
    case 'run_endpoint': {
      const ep = listEndpoints().find((e) => e.slug === args.slug && keyAllows(key, e.connId));
      if (!ep) throw new HttpError(404, `Unknown endpoint: ${String(args.slug)}`);
      const r = await runEndpoint(ep, (args.params as Record<string, unknown>) ?? {}, key.access);
      return text(JSON.stringify(r.rows.slice(0, MAX_TOOL_ROWS), null, 2), r);
    }
    default:
      throw new HttpError(404, `Unknown tool: ${name}`);
  }
}

/** Handles one JSON-RPC message; returns null for notifications (HTTP 202). */
export async function handleMcp(body: unknown, key: ApiKeyInfo): Promise<unknown | null> {
  if (Array.isArray(body)) throw new HttpError(400, 'Batch requests are not supported');
  const msg = body as RpcRequest;
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  }
  if (msg.id === undefined || msg.id === null) return null; // notification (e.g. notifications/initialized)
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'schemascope', version: '0.2.0' },
        instructions:
          'SchemaScope gives access to the user’s databases. Call list_connections, then list_tables / describe_table to learn the schema (foreign keys show how tables relate) before writing SQL with run_query.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      try {
        return reply(await callTool(key, name, args));
      } catch (e) {
        // Tool failures are results the model can read and react to, not protocol errors.
        return reply({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
      }
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}
