import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ConnectionConfig, PublicConnection } from '../shared/types.ts';

/** Set by the Electron main process to app.getPath('userData'). */
let dataDir = path.resolve('data');
export const getDataDir = () => dataDir;
export function setDataDir(dir: string) {
  dataDir = dir;
  cache = null;
}
const file = () => path.join(dataDir, 'connections.json');

/** OS-backed encryption (Keychain / DPAPI / libsecret), supplied by the Electron main process. */
export interface SecretCodec {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}
let codec: SecretCodec | null = null;
export function setSecretCodec(c: SecretCodec) {
  codec = c;
  cache = null;
}

/** Fields that must never be written to disk in clear text or sent to the renderer. */
export const SECRET_FIELDS = ['password', 'sshPassword', 'sshPassphrase'] as const;
type SecretField = (typeof SECRET_FIELDS)[number];
const ENC_PREFIX = 'enc:v1:';

export function encodeSecret(v: string): string {
  if (!codec?.available()) return v; // no keyring (e.g. headless Linux): file stays 0600, see README
  return ENC_PREFIX + codec.encrypt(v).toString('base64');
}

export function decodeSecret(v: string): { value: string; legacy: boolean } {
  if (!v.startsWith(ENC_PREFIX)) return { value: v, legacy: true };
  if (!codec?.available()) throw new Error('Stored credentials are encrypted but the OS keychain is not available');
  return { value: codec.decrypt(Buffer.from(v.slice(ENC_PREFIX.length), 'base64')), legacy: false };
}

let cache: ConnectionConfig[] | null = null;

function load(): ConnectionConfig[] {
  if (cache) return cache;
  let raw: ConnectionConfig[];
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as ConnectionConfig[];
  } catch {
    raw = [];
  }
  let migrate = false;
  for (const c of raw) {
    for (const f of SECRET_FIELDS) {
      const v = c[f];
      if (!v) continue;
      try {
        const d = decodeSecret(v);
        c[f] = d.value;
        if (d.legacy && codec?.available()) migrate = true;
      } catch {
        // Unreadable (keychain changed / different machine): drop it so the user is asked again.
        delete c[f];
      }
    }
  }
  cache = raw;
  if (migrate) save(); // re-write plaintext secrets from older versions encrypted
  return cache;
}

function save() {
  fs.mkdirSync(dataDir, { recursive: true });
  const onDisk = load().map((c) => {
    const out: ConnectionConfig = { ...c };
    for (const f of SECRET_FIELDS) if (out[f]) out[f] = encodeSecret(out[f]!);
    return out;
  });
  fs.writeFileSync(file(), JSON.stringify(onDisk, null, 2), { mode: 0o600 });
}

export function secretsEncrypted(): boolean {
  return !!codec?.available();
}

export function toPublic(c: ConnectionConfig): PublicConnection {
  const { password, sshPassword, sshPassphrase, ...rest } = c;
  return { ...rest, hasPassword: !!password, hasSshPassword: !!sshPassword, hasSshPassphrase: !!sshPassphrase };
}

export function listConnections(): ConnectionConfig[] {
  return load();
}

export function getConnection(id: string): ConnectionConfig | undefined {
  return load().find((c) => c.id === id);
}

/** Create or update. An empty password on update keeps the stored one. */
export function upsertConnection(input: Partial<ConnectionConfig> & { keepPassword?: boolean }): ConnectionConfig {
  const list = load();
  // Display-only flags from PublicConnection must not be persisted.
  const { keepPassword, hasPassword: _hp, hasSshPassword: _hs, hasSshPassphrase: _hk, ...cfg } = input as typeof input & {
    hasPassword?: boolean;
    hasSshPassword?: boolean;
    hasSshPassphrase?: boolean;
  };
  const existing = cfg.id ? list.find((c) => c.id === cfg.id) : undefined;
  if (existing) {
    const password = keepPassword ? existing.password : cfg.password;
    Object.assign(existing, cfg, { password }, keptSecrets(existing, cfg));
    save();
    return existing;
  }
  const created = { ...cfg, id: crypto.randomUUID() } as ConnectionConfig;
  list.push(created);
  save();
  return created;
}

export function deleteConnection(id: string) {
  cache = load().filter((c) => c.id !== id);
  save();
}

/** SSH secrets left undefined by the client mean "unchanged". */
function keptSecrets(existing: ConnectionConfig, input: Partial<ConnectionConfig>): Partial<Record<SecretField, string | undefined>> {
  const out: Partial<Record<SecretField, string | undefined>> = {};
  for (const f of ['sshPassword', 'sshPassphrase'] as const) if (input[f] === undefined) out[f] = existing[f];
  return out;
}

/** Fill in stored secrets for an unsaved/edited config that asked to keep them. */
export function withStoredPassword(cfg: ConnectionConfig & { keepPassword?: boolean }): ConnectionConfig {
  const existing = cfg.id ? getConnection(cfg.id) : undefined;
  if (!existing) return cfg;
  return { ...cfg, ...(cfg.keepPassword ? { password: existing.password } : {}), ...keptSecrets(existing, cfg) };
}
