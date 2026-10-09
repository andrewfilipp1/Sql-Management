import {
  addColumnSql,
  addForeignKeySql,
  alterColumnTypeSql,
  createTableSql,
  dropColumnSql,
  dropTableSql,
  renameColumnSql,
  renameTableSql,
  type ColumnDef,
} from '../../shared/dialect';
import type { ColumnInfo, DbKind, ForeignKeyInfo, IndexInfo, SchemaSnapshot, TableInfo, TableRef } from '../../shared/types';
import { nodeId, uid } from './utils';

/**
 * Visual schema design: every edit on the diagram is an operation appended to a list.
 * The list is replayed over the live schema to get (a) the draft schema the diagram shows and
 * (b) the SQL steps that make it real. Undo = drop the last operation.
 */

export interface ColDraft {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  identity: boolean;
  default?: string;
}

export type DesignOp =
  | { t: 'createTable'; key: string; name: string; schema?: string; position: { x: number; y: number } }
  | { t: 'renameTable'; key: string; name: string }
  | { t: 'dropTable'; key: string }
  | { t: 'addColumn'; key: string; colId: string; col: ColDraft }
  | { t: 'renameColumn'; key: string; colId: string; name: string }
  | { t: 'alterColumn'; key: string; colId: string; type?: string; nullable?: boolean; pk?: boolean }
  | { t: 'dropColumn'; key: string; colId: string }
  | { t: 'addFk'; key: string; colId: string; refKey: string; refColId: string };

export type Mark = 'new' | 'deleted' | 'changed' | 'renamed';

/** Existing columns are identified by their original name; new ones by a generated id. */
export const existingColId = (name: string) => `c:${name}`;
export const newColId = () => `n:${uid()}`;
export const newTableKey = () => `new:${uid()}`;

export interface MCol extends ColDraft {
  id: string;
  orig?: ColumnInfo;
  added: boolean;
  deleted: boolean;
  renamed: boolean;
  changed: boolean;
}

export interface MFk {
  colId: string;
  refKey: string;
  refColId: string;
}

export interface MTable {
  key: string;
  schema?: string;
  name: string;
  orig?: TableInfo;
  created: boolean;
  deleted: boolean;
  renamed: boolean;
  cols: MCol[];
  newFks: MFk[];
  position?: { x: number; y: number };
}

export type Model = Map<string, MTable>;

/** TableInfo plus what the designer changed, for the diagram. */
export interface DesignTable extends TableInfo {
  designKey: string;
  design?: { table?: Mark; columns: Record<string, Mark> };
}

export const DRAFT_FK = 'draft:';

export function buildModel(snapshot: SchemaSnapshot, ops: DesignOp[]): Model {
  const m: Model = new Map();
  for (const t of snapshot.tables) {
    m.set(nodeId(t), {
      key: nodeId(t),
      schema: t.schema,
      name: t.name,
      orig: t,
      created: false,
      deleted: false,
      renamed: false,
      cols: t.columns.map((c) => ({
        id: existingColId(c.name),
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        pk: c.isPrimaryKey,
        identity: c.isIdentity,
        default: c.default ?? undefined,
        orig: c,
        added: false,
        deleted: false,
        renamed: false,
        changed: false,
      })),
      newFks: [],
    });
  }
  for (const op of ops) {
    if (op.t === 'createTable') {
      m.set(op.key, { key: op.key, schema: op.schema, name: op.name, created: true, deleted: false, renamed: false, cols: [], newFks: [], position: op.position });
      continue;
    }
    const t = m.get(op.key);
    if (!t) continue; // stale op (table disappeared): ignored
    const col = 'colId' in op ? t.cols.find((c) => c.id === op.colId) : undefined;
    switch (op.t) {
      case 'renameTable':
        t.name = op.name;
        t.renamed = !t.created && op.name !== t.orig?.name;
        break;
      case 'dropTable':
        t.deleted = true;
        break;
      case 'addColumn':
        t.cols.push({ id: op.colId, ...op.col, added: true, deleted: false, renamed: false, changed: false });
        break;
      case 'renameColumn':
        if (!col) break;
        col.name = op.name;
        col.renamed = !col.added && op.name !== col.orig?.name;
        break;
      case 'alterColumn':
        if (!col) break;
        if (op.type !== undefined) col.type = op.type;
        if (op.nullable !== undefined) col.nullable = op.nullable;
        if (op.pk !== undefined) col.pk = op.pk;
        col.changed = !col.added && (col.type !== col.orig?.type || col.nullable !== col.orig?.nullable || col.pk !== col.orig?.isPrimaryKey);
        break;
      case 'dropColumn':
        if (!col) break;
        if (col.added) {
          // Added and removed in the same draft: it never existed.
          t.cols = t.cols.filter((c) => c !== col);
          t.newFks = t.newFks.filter((f) => f.colId !== col.id);
        } else col.deleted = true;
        break;
      case 'addFk':
        if (col) t.newFks.push({ colId: op.colId, refKey: op.refKey, refColId: op.refColId });
        break;
    }
  }
  return m;
}


/** The schema as it will look after the draft, including deleted items (marked) so the diagram can show them. */
export function effectiveSchema(snapshot: SchemaSnapshot, model: Model): SchemaSnapshot & { tables: DesignTable[] } {
  // Lookups for FKs that point at renamed tables/columns.
  const byOrig = new Map<string, MTable>();
  for (const t of model.values()) if (t.orig) byOrig.set(`${t.orig.schema ?? ''}.${t.orig.name}`.toLowerCase(), t);
  const findRef = (schema: string | undefined, name: string, fallbackSchema?: string) =>
    byOrig.get(`${schema ?? fallbackSchema ?? ''}.${name}`.toLowerCase()) ?? [...model.values()].find((x) => x.orig?.name.toLowerCase() === name.toLowerCase());
  const curName = (t: MTable, origCol: string) => t.cols.find((c) => c.orig?.name === origCol);

  const tables: DesignTable[] = [];
  for (const t of model.values()) {
    const marks: Record<string, Mark> = {};
    const columns: ColumnInfo[] = t.cols.map((c) => {
      const mark: Mark | undefined = c.deleted ? 'deleted' : c.added || t.created ? 'new' : c.renamed ? 'renamed' : c.changed ? 'changed' : undefined;
      if (mark) marks[c.name] = mark;
      return { name: c.name, type: c.type, nullable: c.nullable, default: c.default ?? null, isPrimaryKey: c.pk && !c.deleted, isIdentity: c.identity, comment: c.orig?.comment };
    });
    const foreignKeys: ForeignKeyInfo[] = [];
    for (const fk of t.orig?.foreignKeys ?? []) {
      const cols = fk.columns.map((n) => curName(t, n));
      const ref = findRef(fk.refSchema, fk.refTable, t.schema);
      const refCols = fk.refColumns.map((n) => (ref ? curName(ref, n) : undefined));
      if (cols.some((c) => !c || c.deleted)) continue; // dropped with its column
      foreignKeys.push({
        ...fk,
        columns: cols.map((c) => c!.name),
        refTable: ref?.name ?? fk.refTable,
        refSchema: ref ? ref.schema : fk.refSchema,
        refColumns: refCols.map((c, i) => c?.name ?? fk.refColumns[i]),
      });
    }
    for (const fk of t.newFks) {
      const col = t.cols.find((c) => c.id === fk.colId);
      const ref = model.get(fk.refKey);
      const refCol = ref?.cols.find((c) => c.id === fk.refColId);
      if (!col || !ref || !refCol) continue;
      foreignKeys.push({ name: `${DRAFT_FK}${t.name}.${col.name}`, columns: [col.name], refTable: ref.name, refSchema: ref.schema, refColumns: [refCol.name] });
    }
    const indexes: IndexInfo[] = (t.orig?.indexes ?? [])
      .map((ix) => ({ ...ix, columns: ix.columns.map((n) => curName(t, n)?.name ?? n) }))
      .filter((ix) => ix.columns.every((n) => t.cols.some((c) => c.name === n && !c.deleted)));
    tables.push({
      schema: t.schema,
      name: t.name,
      type: t.orig?.type ?? 'table',
      columns,
      primaryKey: t.cols.filter((c) => c.pk && !c.deleted).map((c) => c.name),
      foreignKeys,
      indexes,
      rowCount: t.orig?.rowCount ?? (t.created ? 0 : null),
      designKey: t.key,
      design: { table: t.deleted ? 'deleted' : t.created ? 'new' : t.renamed ? 'renamed' : undefined, columns: marks },
    });
  }
  return { ...snapshot, tables };
}

// ---------------- SQL ----------------

export interface Step {
  /** null: the engine cannot do this in place (reported as a problem). */
  sql: string | null;
  label: string;
  /** Table node the step belongs to (for animations). */
  key: string;
  /** Operations this step realises; removed from the draft once it succeeds. */
  ops: number[];
  /** How ids change once the step has run (for operations that stay in the draft after a failure). */
  rebase?: { key?: [string, string]; cols?: [string, string][] };
}

const def = (c: MCol): ColumnDef => ({ name: c.name, type: c.type, nullable: c.nullable, primaryKey: c.pk, identity: c.identity, default: c.default });

export function compile(kind: DbKind, model: Model, ops: DesignOp[]): Step[] {
  const steps: Step[] = [];
  const deferredFks: Step[] = [];
  const runTable = new Map<string, TableRef>();
  const runCol = new Map<string, string>();
  for (const t of model.values()) if (t.orig) runTable.set(t.key, { schema: t.orig.schema, name: t.orig.name });
  const ck = (key: string, colId: string) => `${key}\u0000${colId}`;
  const colName = (t: MTable, colId: string) => runCol.get(ck(t.key, colId)) ?? t.cols.find((c) => c.id === colId)?.orig?.name ?? '';
  const lastAlter = new Map<string, number>();
  ops.forEach((op, i) => op.t === 'alterColumn' && lastAlter.set(ck(op.key, op.colId), i));
  const opsOf = (key: string) => ops.flatMap((o, i) => (o.key === key ? [i] : []));
  const defaultSchema = (t: MTable) => t.schema;

  const fkStep = (t: MTable, fk: MFk, opIdx: number): Step | null => {
    const col = t.cols.find((c) => c.id === fk.colId);
    const ref = model.get(fk.refKey);
    const refCol = ref?.cols.find((c) => c.id === fk.refColId);
    if (!col || !ref || !refCol || ref.deleted || col.deleted) return null;
    const sql = addForeignKeySql(kind, { schema: defaultSchema(t), name: t.name }, {
      name: `fk_${t.name}_${col.name}`.slice(0, 60),
      columns: [col.name],
      refTable: { schema: ref.schema, name: ref.name },
      refColumns: [refCol.name],
    });
    return { sql, label: `Relationship ${t.name}.${col.name} → ${ref.name}.${refCol.name}`, key: t.key, ops: [opIdx] };
  };

  ops.forEach((op, i) => {
    const t = model.get(op.key);
    if (!t) return;
    if (op.t === 'createTable') {
      if (t.deleted) return;
      const cols = t.cols.filter((c) => !c.deleted);
      const inlineFks = kind === 'sqlite' ? t.newFks : [];
      const sql = createTableSql(kind, {
        table: { schema: t.schema, name: t.name },
        columns: cols.map(def),
        foreignKeys: inlineFks.flatMap((fk) => {
          const ref = model.get(fk.refKey);
          const c = t.cols.find((x) => x.id === fk.colId);
          const rc = ref?.cols.find((x) => x.id === fk.refColId);
          return ref && c && rc ? [{ columns: [c.name], refTable: { schema: ref.schema, name: ref.name }, refColumns: [rc.name] }] : [];
        }),
      });
      // Every edit of a new table is folded into its CREATE (except FKs added later on other engines).
      const folded = opsOf(t.key).filter((j) => !(ops[j].t === 'addFk' && kind !== 'sqlite'));
      steps.push({
        sql,
        label: `Create table ${t.name}`,
        key: t.key,
        ops: folded,
        rebase: { key: [t.key, nodeId({ schema: t.schema, name: t.name })], cols: cols.map((c) => [c.id, existingColId(c.name)]) },
      });
      return;
    }
    if (t.created) {
      if (op.t === 'addFk' && kind !== 'sqlite') {
        const s = fkStep(t, op, i);
        if (s) deferredFks.push(s);
      }
      return;
    }
    // Existing tables that end up dropped only need the DROP itself.
    if (t.deleted && op.t !== 'dropTable') return;
    const ref = runTable.get(t.key)!;
    const col = 'colId' in op ? t.cols.find((c) => c.id === op.colId) : undefined;
    switch (op.t) {
      case 'renameTable':
        steps.push({ sql: renameTableSql(kind, ref, op.name), label: `Rename table ${ref.name} → ${op.name}`, key: t.key, ops: [i], rebase: { key: [t.key, nodeId({ schema: ref.schema, name: op.name })] } });
        runTable.set(t.key, { ...ref, name: op.name });
        break;
      case 'dropTable':
        steps.push({ sql: dropTableSql(kind, ref), label: `Drop table ${ref.name}`, key: t.key, ops: opsOf(t.key) });
        break;
      case 'addColumn': {
        if (!col || col.deleted) return; // added then removed
        // Later renames/alters of a new column are already in its final definition.
        const folded = opsOf(t.key).filter((j) => 'colId' in ops[j] && (ops[j] as { colId: string }).colId === col.id && ops[j].t !== 'addFk');
        steps.push({
          sql: addColumnSql(kind, ref, { ...def(col), primaryKey: false }),
          label: `Add column ${ref.name}.${col.name}`,
          key: t.key,
          ops: folded,
          rebase: { cols: [[col.id, existingColId(col.name)]] },
        });
        runCol.set(ck(t.key, col.id), col.name);
        break;
      }
      case 'renameColumn': {
        if (!col || col.added || col.deleted) return;
        const from = colName(t, col.id);
        steps.push({ sql: renameColumnSql(kind, ref, from, op.name), label: `Rename column ${ref.name}.${from} → ${op.name}`, key: t.key, ops: [i], rebase: { cols: [[col.id, existingColId(op.name)]] } });
        runCol.set(ck(t.key, col.id), op.name);
        break;
      }
      case 'alterColumn': {
        if (!col || col.added || col.deleted || lastAlter.get(ck(t.key, col.id)) !== i) return;
        const alterOps = ops.flatMap((o, j) => (o.t === 'alterColumn' && o.key === t.key && o.colId === col.id ? [j] : []));
        // Primary keys of existing tables are not changed here (constraint names differ per engine).
        const pkChanged = col.pk !== !!col.orig?.isPrimaryKey;
        steps.push({
          sql: pkChanged ? null : alterColumnTypeSql(kind, ref, { name: colName(t, col.id), type: col.type, nullable: col.nullable, primaryKey: false, identity: false }),
          label: `Change column ${ref.name}.${colName(t, col.id)} → ${col.type}${col.nullable ? '' : ' NOT NULL'}`,
          key: t.key,
          ops: alterOps,
        });
        break;
      }
      case 'dropColumn':
        if (!col || col.added) return;
        steps.push({ sql: dropColumnSql(kind, ref, colName(t, col.id)), label: `Drop column ${ref.name}.${colName(t, col.id)}`, key: t.key, ops: [i] });
        break;
      case 'addFk': {
        const s = fkStep(t, op, i);
        if (s) deferredFks.push(s);
        break;
      }
    }
  });
  // Relationships last, when every table and column they point at exists.
  return [...steps, ...deferredFks];
}

/** After some steps ran, rewrite the remaining operations to the new ids (renamed/created tables and columns). */
export function rebaseOps(ops: DesignOp[], applied: Step[]): DesignOp[] {
  const done = new Set(applied.flatMap((s) => s.ops));
  const keyMap = new Map<string, string>();
  const colMap = new Map<string, string>();
  for (const s of applied) {
    if (s.rebase?.key) keyMap.set(s.rebase.key[0], s.rebase.key[1]);
    for (const [a, b] of s.rebase?.cols ?? []) colMap.set(`${s.key}\u0000${a}`, b);
  }
  const k = (key: string) => keyMap.get(key) ?? key;
  const c = (key: string, colId: string) => colMap.get(`${key}\u0000${colId}`) ?? colId;
  return ops.flatMap((op, i) => {
    if (done.has(i)) return [];
    const next = { ...op, key: k(op.key) } as DesignOp;
    if ('colId' in op) (next as { colId: string }).colId = c(op.key, op.colId);
    if (op.t === 'addFk') Object.assign(next, { refKey: k(op.refKey), refColId: c(op.refKey, op.refColId) });
    return [next];
  });
}

/** One-line description of an operation, for the changes list. */
export function describeOp(op: DesignOp, model: Model): string {
  const t = model.get(op.key);
  const tn = t?.name ?? '?';
  const col = 'colId' in op ? t?.cols.find((c) => c.id === op.colId) : undefined;
  switch (op.t) {
    case 'createTable':
      return `New table ${op.name}`;
    case 'renameTable':
      return `Rename table → ${op.name}`;
    case 'dropTable':
      return `Drop table ${tn}`;
    case 'addColumn':
      return `Add ${tn}.${col?.name ?? op.col.name} ${col?.type ?? op.col.type}`;
    case 'renameColumn':
      return `Rename ${tn}.${col?.orig?.name ?? '?'} → ${op.name}`;
    case 'alterColumn':
      return `Change ${tn}.${col?.name ?? '?'}${op.type ? ' → ' + op.type : ''}${op.nullable !== undefined ? (op.nullable ? ' NULL' : ' NOT NULL') : ''}${op.pk !== undefined ? (op.pk ? ' +PK' : ' −PK') : ''}`;
    case 'dropColumn':
      return `Drop ${tn}.${col?.name ?? '?'}`;
    case 'addFk': {
      const ref = model.get(op.refKey);
      return `Relationship ${tn}.${col?.name ?? '?'} → ${ref?.name ?? '?'}`;
    }
  }
}
