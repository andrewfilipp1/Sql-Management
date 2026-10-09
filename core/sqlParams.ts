import type { EndpointParam } from '../shared/integrations.ts';
import type { DbKind } from '../shared/types.ts';
import { HttpError } from './util.ts';

/**
 * Finds `:name` placeholders outside strings, quoted identifiers and comments.
 * `::type` casts (PostgreSQL) are not placeholders.
 */
export function findNamedParams(sql: string): { name: string; start: number; end: number }[] {
  const out: { name: string; start: number; end: number }[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const e = sql.indexOf('\n', i);
      i = e === -1 ? sql.length : e;
      continue;
    }
    if (ch === '/' && next === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e === -1 ? sql.length : e + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < sql.length && !(sql[j] === close && sql[j + 1] !== close)) j += sql[j] === close ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (ch === ':' && next === ':') {
      i += 2;
      continue;
    }
    if (ch === ':' && /[A-Za-z_]/.test(next ?? '') && sql[i - 1] !== ':') {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1))!;
      out.push({ name: m[0], start: i, end: i + 1 + m[0].length });
      i += 1 + m[0].length;
      continue;
    }
    i++;
  }
  return out;
}

export function detectParams(sql: string): string[] {
  return [...new Set(findNamedParams(sql).map((p) => p.name))];
}

/** Rewrites named placeholders into the driver's positional ones; values are always bound, never inlined. */
export function compileNamed(
  sql: string,
  kind: DbKind,
  values: Record<string, unknown>,
  placeholder: (i: number) => string,
): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const pgIndex = new Map<string, number>();
  let text = '';
  let last = 0;
  for (const p of findNamedParams(sql)) {
    if (!(p.name in values)) throw new HttpError(400, `Missing parameter: ${p.name}`);
    let ph: string;
    if (kind === 'postgres' || kind === 'mssql') {
      // Numbered placeholders can be reused for repeated names.
      let idx = pgIndex.get(p.name);
      if (idx === undefined) {
        idx = params.push(values[p.name]) - 1;
        pgIndex.set(p.name, idx);
      }
      ph = placeholder(idx);
    } else {
      ph = placeholder(params.push(values[p.name]) - 1);
    }
    text += sql.slice(last, p.start) + ph;
    last = p.end;
  }
  return { text: text + sql.slice(last), params };
}

/** Coerces raw request values (query string or JSON) to the declared parameter types. */
export function coerceParams(defs: EndpointParam[], raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    let v = raw[d.name];
    if (v === undefined || v === '') v = d.default;
    if (v === undefined || v === '') {
      if (d.required) throw new HttpError(400, `Missing parameter: ${d.name}`);
      out[d.name] = null;
      continue;
    }
    if (d.type === 'number') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) throw new HttpError(400, `Parameter ${d.name} must be a number`);
      out[d.name] = n;
    } else if (d.type === 'boolean') {
      if (typeof v === 'boolean') out[d.name] = v;
      else if (v === 'true' || v === '1') out[d.name] = true;
      else if (v === 'false' || v === '0') out[d.name] = false;
      else throw new HttpError(400, `Parameter ${d.name} must be true or false`);
    } else {
      if (typeof v === 'object') throw new HttpError(400, `Parameter ${d.name} must be a string`);
      const s = String(v);
      if (s.length > 10_000) throw new HttpError(400, `Parameter ${d.name} is too long`);
      out[d.name] = s;
    }
  }
  return out;
}
