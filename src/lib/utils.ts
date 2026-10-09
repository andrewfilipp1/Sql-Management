import type { SchemaSnapshot, TableInfo, TableRef } from '../../shared/types';

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export const dbKey = (connId: string, database: string) => `${connId}::${database}`;

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US').format(n);
}

export function compactNumber(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function formatMs(ms: number): string {
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function sameTable(a: TableRef, b: TableRef): boolean {
  return a.name === b.name && (a.schema ?? '') === (b.schema ?? '');
}

export function findTable(s: SchemaSnapshot | undefined, t: TableRef): TableInfo | undefined {
  return s?.tables.find((x) => sameTable(x, t));
}

/** FK target lookup: matches schema when given, otherwise by name. */
export function resolveRef(s: SchemaSnapshot, schema: string | undefined, name: string): TableInfo | undefined {
  return (
    s.tables.find((t) => t.name === name && (schema === undefined || (t.schema ?? '') === schema)) ??
    s.tables.find((t) => t.name.toLowerCase() === name.toLowerCase())
  );
}

export function nodeId(t: TableRef): string {
  return (t.schema ? t.schema + '.' : '') + t.name;
}

/** Diagram node id: stable across renames and for tables that exist only in a design draft. */
export function nodeKey(t: TableRef): string {
  return (t as { designKey?: string }).designKey ?? nodeId(t);
}

export interface Relation {
  id: string;
  from: TableInfo;
  to: TableInfo;
  fromColumns: string[];
  toColumns: string[];
  name: string;
  onDelete?: string;
}

export function relationsOf(s: SchemaSnapshot): Relation[] {
  const out: Relation[] = [];
  for (const t of s.tables) {
    for (const fk of t.foreignKeys) {
      const to = resolveRef(s, fk.refSchema ?? t.schema, fk.refTable);
      if (!to) continue;
      out.push({
        id: `${nodeKey(t)}:${fk.name}`,
        from: t,
        to,
        fromColumns: fk.columns,
        toColumns: fk.refColumns,
        name: fk.name,
        onDelete: fk.onDelete,
      });
    }
  }
  return out;
}

export function download(filename: string, content: string, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [columns.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
}

export function toJson(columns: string[], rows: unknown[][]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))),
    null,
    2,
  );
}

/** Stable hue per string, used to colour tables and connections. */
export function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export const CONNECTION_COLORS = ['#7c7ff7', '#38bdf8', '#34d399', '#f5b83d', '#f472b6', '#f87171', '#a78bfa', '#2dd4bf'];
