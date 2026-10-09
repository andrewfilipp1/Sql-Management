import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SERVER,
  type ApiKeyInfo,
  type KeyAccess,
  type SavedEndpoint,
  type ServerSettings,
} from '../shared/integrations.ts';
import { getDataDir } from './store.ts';
import { HttpError } from './util.ts';

interface StoredKey extends ApiKeyInfo {
  /** sha256 of the full key; the key itself is never stored. */
  hash: string;
}

interface Stored {
  server: ServerSettings;
  keys: StoredKey[];
  endpoints: SavedEndpoint[];
}

const file = () => path.join(getDataDir(), 'integrations.json');
let cache: Stored | null = null;

function load(): Stored {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Stored>;
    cache = { server: { ...DEFAULT_SERVER, ...raw.server }, keys: raw.keys ?? [], endpoints: raw.endpoints ?? [] };
  } catch {
    cache = { server: { ...DEFAULT_SERVER }, keys: [], endpoints: [] };
  }
  return cache;
}

function save() {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(load(), null, 2), { mode: 0o600 });
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const publicKey = ({ hash: _h, ...info }: StoredKey): ApiKeyInfo => info;

// ---- server settings ----

export function getServerSettings(): ServerSettings {
  return load().server;
}

export function setServerSettings(patch: Partial<ServerSettings>): ServerSettings {
  const s = load();
  const next = { ...s.server, ...patch };
  if (!Number.isInteger(next.port) || next.port < 1024 || next.port > 65535) throw new HttpError(400, 'Port must be 1024–65535');
  if (!Number.isInteger(next.rateLimit) || next.rateLimit < 1 || next.rateLimit > 10_000) throw new HttpError(400, 'Rate limit must be 1–10000');
  s.server = next;
  save();
  return next;
}

// ---- API keys ----

export function listKeys(): ApiKeyInfo[] {
  return load().keys.map(publicKey);
}

export function createKey(input: { name: string; access: KeyAccess; connections: string[] | '*' }): { key: string; info: ApiKeyInfo } {
  const name = input.name?.trim();
  if (!name) throw new HttpError(400, 'Key name is required');
  if (input.access !== 'read' && input.access !== 'write') throw new HttpError(400, 'Invalid access level');
  if (input.connections !== '*' && (!Array.isArray(input.connections) || !input.connections.length)) {
    throw new HttpError(400, 'Choose at least one connection');
  }
  const key = 'ssk_' + crypto.randomBytes(32).toString('base64url');
  const stored: StoredKey = {
    id: crypto.randomUUID(),
    name,
    prefix: key.slice(0, 10),
    access: input.access,
    connections: input.connections,
    createdAt: new Date().toISOString(),
    hash: sha256(key),
  };
  load().keys.push(stored);
  save();
  return { key, info: publicKey(stored) };
}

export function revokeKey(id: string) {
  const s = load();
  s.keys = s.keys.filter((k) => k.id !== id);
  save();
}

/** Constant-time lookup of a presented bearer key. */
export function verifyKey(presented: string): ApiKeyInfo | null {
  if (!presented.startsWith('ssk_') || presented.length > 200) return null;
  const h = Buffer.from(sha256(presented), 'hex');
  const match = load().keys.find((k) => crypto.timingSafeEqual(Buffer.from(k.hash, 'hex'), h));
  if (!match) return null;
  // Persist "last used" at most once a minute to avoid a disk write per request.
  const now = Date.now();
  if (!match.lastUsedAt || now - Date.parse(match.lastUsedAt) > 60_000) {
    match.lastUsedAt = new Date(now).toISOString();
    save();
  }
  return publicKey(match);
}

export function keyAllows(key: ApiKeyInfo, connId: string): boolean {
  return key.connections === '*' || key.connections.includes(connId);
}

// ---- saved endpoints ----

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function listEndpoints(): SavedEndpoint[] {
  return load().endpoints;
}

export function getEndpoint(slug: string): SavedEndpoint | undefined {
  return load().endpoints.find((e) => e.slug === slug);
}

export function saveEndpoint(e: SavedEndpoint): SavedEndpoint {
  if (!SLUG.test(e.slug ?? '')) throw new HttpError(400, 'Slug: lowercase letters, digits and dashes (e.g. top-customers)');
  if (!e.sql?.trim()) throw new HttpError(400, 'SQL is required');
  if (!e.connId || !e.database) throw new HttpError(400, 'Choose a connection and database');
  const s = load();
  if (s.endpoints.some((x) => x.slug === e.slug && x.id !== e.id)) throw new HttpError(409, `Slug “${e.slug}” is already used`);
  const saved: SavedEndpoint = { ...e, id: e.id || crypto.randomUUID(), name: e.name?.trim() || e.slug };
  const i = s.endpoints.findIndex((x) => x.id === saved.id);
  if (i >= 0) s.endpoints[i] = saved;
  else s.endpoints.push(saved);
  save();
  return saved;
}

export function deleteEndpoint(id: string) {
  const s = load();
  s.endpoints = s.endpoints.filter((e) => e.id !== id);
  save();
}
