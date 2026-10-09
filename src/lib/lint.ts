import { createIndexSql, dropIndexSql } from '../../shared/dialect';
import type { DbKind, SchemaSnapshot, TableInfo } from '../../shared/types';
import { DRAFT_FK, type DesignTable, type Step } from './designer';
import { family } from './schemaDiff';
import { nodeId, relationsOf } from './utils';

export type Severity = 'error' | 'warning' | 'info';

export interface Problem {
  id: string;
  severity: Severity;
  rule: string;
  /** Diagram node of the table. */
  key: string;
  table: string;
  column?: string;
  /** Relationship id when the problem is on a line between tables. */
  relationId?: string;
  title: string;
  detail?: string;
  /** Errors in the draft block Apply. */
  draft?: boolean;
  fix?: { label: string; sql: string };
}

export const SEVERITY_RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 };

const keyOf = (t: TableInfo) => (t as DesignTable).designKey ?? nodeId(t);
const isDeleted = (t: TableInfo) => (t as DesignTable).design?.table === 'deleted';
const colMark = (t: TableInfo, c: string) => (t as DesignTable).design?.columns[c];
const INTEGER = new Set(['int', 'bigint', 'smallint']);

/**
 * Schema checks over the live schema or a draft (effectiveSchema). Draft-only rules catch edits
 * that the database would reject, so they show up before Apply instead of after.
 */
export function lintSchema(s: SchemaSnapshot, kind: DbKind, steps: Step[] = []): Problem[] {
  const out: Problem[] = [];
  const add = (p: Omit<Problem, 'id'>) => out.push({ ...p, id: `${p.rule}:${p.key}:${p.column ?? ''}:${p.relationId ?? ''}` });
  const tables = s.tables.filter((t) => !isDeleted(t));
  const real = tables.filter((t) => t.type === 'table');
  const rels = relationsOf({ ...s, tables });

  // ---- draft validity (what the database would refuse) ----
  const seen = new Map<string, TableInfo>();
  for (const t of real) {
    const k = keyOf(t);
    const isNew = (t as DesignTable).design?.table === 'new';
    if (!t.name.trim()) add({ severity: 'error', rule: 'name-empty', key: k, table: t.name, title: 'Table needs a name', draft: true });
    const id = `${t.schema ?? ''}.${t.name}`.toLowerCase();
    if (seen.has(id)) add({ severity: 'error', rule: 'dup-table', key: k, table: t.name, title: `Another table is already called “${t.name}”`, draft: true });
    seen.set(id, t);
    const cols = t.columns.filter((c) => colMark(t, c.name) !== 'deleted');
    if (isNew && !cols.length) add({ severity: 'error', rule: 'no-columns', key: k, table: t.name, title: 'A new table needs at least one column', draft: true });
    const names = new Set<string>();
    for (const c of cols) {
      const lower = c.name.toLowerCase();
      if (!c.name.trim()) add({ severity: 'error', rule: 'col-name-empty', key: k, table: t.name, column: c.name, title: 'Column needs a name', draft: true });
      else if (names.has(lower)) add({ severity: 'error', rule: 'dup-column', key: k, table: t.name, column: c.name, title: `Duplicate column “${c.name}”`, draft: true });
      names.add(lower);
      if (!c.type.trim()) add({ severity: 'error', rule: 'col-type-empty', key: k, table: t.name, column: c.name, title: `Column ${c.name} needs a type`, draft: true });
      const mark = colMark(t, c.name);
      if (c.isIdentity && mark === 'new' && !INTEGER.has(family(c.type).f) && !/decimal|numeric/i.test(c.type)) {
        add({ severity: 'error', rule: 'identity-type', key: k, table: t.name, column: c.name, title: `Auto-increment ${c.name} must be an integer type`, draft: true });
      }
      // Adding NOT NULL without a default to a table that already has rows fails on most engines.
      if (mark === 'new' && !isNew && !c.nullable && !c.isIdentity && !c.default && (t.rowCount ?? 0) > 0) {
        add({
          severity: 'error',
          rule: 'notnull-no-default',
          key: k,
          table: t.name,
          column: c.name,
          title: `${c.name}: NOT NULL needs a default`,
          detail: `${t.name} already has ${t.rowCount} rows; give the column a default or allow NULL.`,
          draft: true,
        });
      }
    }
  }

  // Steps the engine cannot perform in place.
  for (const st of steps) {
    if (st.sql === null) {
      add({
        severity: 'error',
        rule: 'unsupported',
        key: st.key,
        table: st.label,
        title: kind === 'sqlite' ? `SQLite cannot do this in place: ${st.label}` : `Not supported here: ${st.label}`,
        detail: kind === 'sqlite' ? 'SQLite only supports new columns, renames and drops on existing tables. Recreate the table instead.' : 'Changing the primary key of an existing table is done from the Structure tab with SQL.',
        draft: true,
      });
    }
  }

  // Deleting something another table still points at.
  for (const t of s.tables) {
    const k = keyOf(t);
    if (isDeleted(t)) {
      for (const r of rels.filter((x) => x.to.name === t.name && x.to.schema === t.schema && !isDeleted(x.from))) {
        add({ severity: 'error', rule: 'drop-referenced', key: k, table: t.name, title: `${t.name} is still referenced by ${r.from.name}`, detail: 'Drop or change that relationship first.', draft: true });
      }
    }
    for (const c of t.columns.filter((x) => colMark(t, x.name) === 'deleted')) {
      for (const other of tables) {
        for (const fk of other.foreignKeys) {
          if (fk.refTable === t.name && fk.refColumns.includes(c.name) && other !== t) {
            add({ severity: 'error', rule: 'drop-referenced', key: k, table: t.name, column: c.name, title: `${c.name} is referenced by ${other.name}`, draft: true });
          }
        }
      }
    }
  }

  // ---- relationships ----
  for (const r of rels) {
    const draft = r.name.startsWith(DRAFT_FK);
    const fromCol = r.from.columns.find((c) => c.name === r.fromColumns[0]);
    const toCol = r.to.columns.find((c) => c.name === r.toColumns[0]);
    if (!fromCol || !toCol) continue;
    const fa = family(fromCol.type).f;
    const fb = family(toCol.type).f;
    if (fa !== fb) {
      const close = INTEGER.has(fa) && INTEGER.has(fb);
      add({
        severity: close ? 'warning' : 'error',
        rule: 'fk-type-mismatch',
        key: keyOf(r.from),
        table: r.from.name,
        column: fromCol.name,
        relationId: r.id,
        title: `${r.from.name}.${fromCol.name} (${fromCol.type}) ≠ ${r.to.name}.${toCol.name} (${toCol.type})`,
        detail: close ? 'Different integer sizes: values above the smaller range will fail.' : 'Values cannot match across these types; most databases refuse this relationship.',
        draft,
      });
    }
    // The referenced side must be unique (primary key or unique index).
    const unique = (r.to.primaryKey.length === r.toColumns.length && r.toColumns.every((c) => r.to.primaryKey.includes(c))) ||
      r.to.indexes.some((i) => i.unique && i.columns.length === r.toColumns.length && r.toColumns.every((c) => i.columns.includes(c)));
    if (!unique) {
      add({
        severity: draft ? 'error' : 'warning',
        rule: 'fk-target-not-unique',
        key: keyOf(r.from),
        table: r.from.name,
        relationId: r.id,
        title: `${r.to.name}.${r.toColumns.join(', ')} is not a key`,
        detail: 'A foreign key must point at a primary key or a unique column.',
        draft,
      });
    }
  }

  // ---- design quality (live schema) ----
  for (const t of real) {
    const k = keyOf(t);
    const isNew = (t as DesignTable).design?.table === 'new';
    if (!t.primaryKey.length) {
      add({ severity: 'warning', rule: 'no-pk', key: k, table: t.name, title: `${t.name} has no primary key`, detail: 'Rows cannot be identified reliably — editing, replication and relationships suffer.', draft: isNew });
    }
    for (const fk of t.foreignKeys.filter((f) => !f.name.startsWith(DRAFT_FK))) {
      const indexed = t.indexes.some((i) => i.columns[0] === fk.columns[0]) || t.primaryKey[0] === fk.columns[0];
      if (!indexed) {
        add({
          severity: 'warning',
          rule: 'fk-no-index',
          key: k,
          table: t.name,
          column: fk.columns[0],
          title: `${t.name}.${fk.columns.join(', ')} has no index`,
          detail: `Joins and deletes on ${fk.refTable} scan the whole of ${t.name}.`,
          fix: { label: 'Create index', sql: createIndexSql(kind, { schema: t.schema, name: t.name }, `ix_${t.name}_${fk.columns.join('_')}`.slice(0, 60), fk.columns, false) },
        });
      }
    }
    const sigs = new Map<string, string>();
    for (const ix of t.indexes) {
      const sig = ix.columns.join(',').toLowerCase();
      const prev = sigs.get(sig);
      if (prev !== undefined && !ix.primary) {
        add({
          severity: 'warning',
          rule: 'dup-index',
          key: k,
          table: t.name,
          title: `Index ${ix.name} duplicates ${prev}`,
          detail: 'Every duplicate index slows down writes and takes space.',
          fix: { label: `Drop ${ix.name}`, sql: dropIndexSql(kind, { schema: t.schema, name: t.name }, ix.name) },
        });
      } else sigs.set(sig, ix.name);
    }
    if (t.columns.length > 30) add({ severity: 'info', rule: 'wide', key: k, table: t.name, title: `${t.name} has ${t.columns.length} columns`, detail: 'Very wide tables are often worth splitting.' });
    if (real.length > 1 && !rels.some((r) => r.from === t || r.to === t) && !isNew) {
      add({ severity: 'info', rule: 'isolated', key: k, table: t.name, title: `${t.name} has no relationships` });
    }
  }
  return out.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/** Highest severity per table node and per relationship, for the diagram. */
export function problemIndex(problems: Problem[]) {
  const byKey = new Map<string, Problem[]>();
  const byRelation = new Map<string, Severity>();
  for (const p of problems) {
    byKey.set(p.key, [...(byKey.get(p.key) ?? []), p]);
    if (p.relationId) {
      const cur = byRelation.get(p.relationId);
      if (!cur || SEVERITY_RANK[p.severity] > SEVERITY_RANK[cur]) byRelation.set(p.relationId, p.severity);
    }
  }
  return { byKey, byRelation };
}
