import {
  addColumnSql,
  addForeignKeySql,
  alterColumnTypeSql,
  createIndexSql,
  createTableSql,
  dropColumnSql,
  dropForeignKeySql,
  dropIndexSql,
  dropTableSql,
  type ColumnDef,
} from '../../shared/dialect';
import type { ColumnInfo, DbKind, ForeignKeyInfo, IndexInfo, SchemaSnapshot, TableInfo, TableRef } from '../../shared/types';

export type ChangeKind =
  | 'drop-fk'
  | 'drop-index'
  | 'drop-column'
  | 'drop-table'
  | 'create-table'
  | 'add-column'
  | 'alter-column'
  | 'add-index'
  | 'add-fk';

export interface SchemaChange {
  id: string;
  kind: ChangeKind;
  table: string;
  title: string;
  /** Before → after, for display. */
  detail?: string;
  sql: string;
  /** Loses data or structure; unselected by default. */
  destructive: boolean;
  /** The target engine cannot do it in place. */
  unsupported?: boolean;
}

/** Execution order: remove constraints before what they depend on, create before referencing. */
const ORDER: ChangeKind[] = ['drop-fk', 'drop-index', 'drop-column', 'drop-table', 'create-table', 'add-column', 'alter-column', 'add-index', 'add-fk'];

// ---- cross-engine type mapping ----
export type Family = 'int' | 'bigint' | 'smallint' | 'bool' | 'decimal' | 'float' | 'varchar' | 'char' | 'text' | 'date' | 'datetime' | 'datetimetz' | 'time' | 'uuid' | 'json' | 'binary';

export function family(type: string): { f: Family; args?: string } {
  const t = type.toLowerCase().trim();
  const args = /\(([^)]*)\)/.exec(t)?.[1];
  if (/^(tinyint\(1\)|bit|bool|boolean)$/.test(t)) return { f: 'bool' };
  if (/bigint|int8|bigserial/.test(t)) return { f: 'bigint' };
  if (/smallint|tinyint|int2/.test(t)) return { f: 'smallint' };
  if (/^(int|integer|int4|mediumint|serial)/.test(t)) return { f: 'int' };
  if (/decimal|numeric|money/.test(t)) return { f: 'decimal', args };
  if (/float|double|real/.test(t)) return { f: 'float' };
  if (/uuid|uniqueidentifier/.test(t)) return { f: 'uuid' };
  if (/json/.test(t)) return { f: 'json' };
  if (/blob|bytea|binary|image/.test(t)) return { f: 'binary' };
  if (/timestamptz|with time zone|datetimeoffset/.test(t)) return { f: 'datetimetz' };
  if (/timestamp|datetime/.test(t)) return { f: 'datetime' };
  if (/^date$/.test(t)) return { f: 'date' };
  if (/^time/.test(t)) return { f: 'time' };
  if (/char\(|character\(/.test(t) && !/var/.test(t)) return { f: 'char', args };
  if (/varchar|character varying/.test(t) && args && args !== 'max') return { f: 'varchar', args };
  return { f: 'text' };
}

const VOCAB: Record<DbKind, Record<Family, (args?: string) => string>> = {
  postgres: {
    int: () => 'integer', bigint: () => 'bigint', smallint: () => 'smallint', bool: () => 'boolean',
    decimal: (a) => (a ? `numeric(${a})` : 'numeric'), float: () => 'double precision', varchar: (a) => `varchar(${a})`,
    char: (a) => `char(${a ?? 1})`, text: () => 'text', date: () => 'date', datetime: () => 'timestamp',
    datetimetz: () => 'timestamptz', time: () => 'time', uuid: () => 'uuid', json: () => 'jsonb', binary: () => 'bytea',
  },
  mysql: {
    int: () => 'INT', bigint: () => 'BIGINT', smallint: () => 'SMALLINT', bool: () => 'TINYINT(1)',
    decimal: (a) => `DECIMAL(${a ?? '18,4'})`, float: () => 'DOUBLE', varchar: (a) => `VARCHAR(${a})`, char: (a) => `CHAR(${a ?? 1})`,
    text: () => 'TEXT', date: () => 'DATE', datetime: () => 'DATETIME', datetimetz: () => 'DATETIME', time: () => 'TIME',
    uuid: () => 'CHAR(36)', json: () => 'JSON', binary: () => 'BLOB',
  },
  mssql: {
    int: () => 'int', bigint: () => 'bigint', smallint: () => 'smallint', bool: () => 'bit', decimal: (a) => `decimal(${a ?? '18,4'})`,
    float: () => 'float', varchar: (a) => `nvarchar(${a})`, char: (a) => `nchar(${a ?? 1})`, text: () => 'nvarchar(max)', date: () => 'date',
    datetime: () => 'datetime2', datetimetz: () => 'datetimeoffset', time: () => 'time', uuid: () => 'uniqueidentifier',
    json: () => 'nvarchar(max)', binary: () => 'varbinary(max)',
  },
  sqlite: {
    int: () => 'INTEGER', bigint: () => 'INTEGER', smallint: () => 'INTEGER', bool: () => 'BOOLEAN', decimal: () => 'NUMERIC',
    float: () => 'REAL', varchar: (a) => `VARCHAR(${a})`, char: (a) => `CHAR(${a ?? 1})`, text: () => 'TEXT', date: () => 'DATE',
    datetime: () => 'DATETIME', datetimetz: () => 'DATETIME', time: () => 'TIME', uuid: () => 'TEXT', json: () => 'TEXT', binary: () => 'BLOB',
  },
};

/** Native type for a family in an engine, e.g. typeFor('mssql', 'varchar', '255') → nvarchar(255). */
export function typeFor(kind: DbKind, f: Family, args?: string): string {
  return VOCAB[kind][f](args);
}

export function mapType(type: string, from: DbKind, to: DbKind): string {
  if (from === to) return type;
  const { f, args } = family(type);
  return VOCAB[to][f](args);
}

const normType = (t: string) => t.toLowerCase().replace(/\s+/g, '');

function sameType(a: string, aKind: DbKind, b: string, bKind: DbKind): boolean {
  if (aKind === bKind) return normType(a) === normType(b);
  return normType(mapType(a, aKind, bKind)) === normType(b);
}

const tkey = (t: { schema?: string; name: string }, useSchema: boolean) => (useSchema ? `${t.schema ?? ''}.` : '') + t.name.toLowerCase();

function toDef(c: ColumnInfo, from: DbKind, to: DbKind, inPk: boolean): ColumnDef {
  return {
    name: c.name,
    type: mapType(c.type, from, to),
    nullable: c.nullable,
    primaryKey: inPk,
    identity: c.isIdentity,
    // Defaults are engine-specific expressions; only copy them between the same engine.
    default: from === to && !c.isIdentity ? (c.default ?? undefined) : undefined,
  };
}

const fkSig = (f: ForeignKeyInfo) => `${f.columns.join(',')}>${f.refTable.toLowerCase()}(${f.refColumns.join(',')})`.toLowerCase();
const ixSig = (i: IndexInfo) => `${i.unique ? 'u' : ''}:${i.columns.join(',')}`.toLowerCase();

/** Changes that make `target` look like `source`. */
export function diffSchemas(source: SchemaSnapshot, target: SchemaSnapshot): SchemaChange[] {
  const sk = source.kind;
  const tk = target.kind;
  const useSchema = sk === tk && source.schemas.length > 0;
  const out: SchemaChange[] = [];
  let n = 0;
  const push = (c: Omit<SchemaChange, 'id'>) => out.push({ ...c, id: `c${n++}` });
  const targetDefaultSchema = tk === 'postgres' ? 'public' : tk === 'mssql' ? 'dbo' : undefined;
  const ref = (t: TableInfo): TableRef => ({ schema: useSchema ? t.schema : targetDefaultSchema, name: t.name });

  const srcTables = source.tables.filter((t) => t.type === 'table');
  const tgtTables = target.tables.filter((t) => t.type === 'table');
  const tgtBy = new Map(tgtTables.map((t) => [tkey(t, useSchema), t]));
  const srcBy = new Map(srcTables.map((t) => [tkey(t, useSchema), t]));

  for (const s of srcTables) {
    const t = tgtBy.get(tkey(s, useSchema));
    const label = useSchema && s.schema ? `${s.schema}.${s.name}` : s.name;
    if (!t) {
      push({
        kind: 'create-table',
        table: label,
        title: `Create table ${label}`,
        detail: `${s.columns.length} columns`,
        sql: createTableSql(tk, {
          table: ref(s),
          columns: s.columns.map((c) => toDef(c, sk, tk, s.primaryKey.includes(c.name))),
          foreignKeys: [], // added as separate steps so creation order does not matter
        }),
        destructive: false,
      });
      for (const ix of s.indexes.filter((i) => !i.primary)) {
        push({ kind: 'add-index', table: label, title: `Index ${ix.name}`, detail: ix.columns.join(', '), sql: createIndexSql(tk, ref(s), ix.name, ix.columns, ix.unique), destructive: false });
      }
      for (const fk of s.foreignKeys) {
        const sql = addForeignKeySql(tk, ref(s), { name: fk.name, columns: fk.columns, refTable: { schema: useSchema ? fk.refSchema : targetDefaultSchema, name: fk.refTable }, refColumns: fk.refColumns, onDelete: fk.onDelete, onUpdate: fk.onUpdate });
        push({
          kind: 'add-fk',
          table: label,
          title: `Foreign key ${fk.columns.join(', ')} → ${fk.refTable}`,
          sql: sql ?? `-- SQLite: foreign keys must be declared in CREATE TABLE`,
          destructive: false,
          unsupported: !sql,
        });
      }
      continue;
    }

    // Columns
    const tCols = new Map(t.columns.map((c) => [c.name.toLowerCase(), c]));
    const sCols = new Map(s.columns.map((c) => [c.name.toLowerCase(), c]));
    for (const c of s.columns) {
      const tc = tCols.get(c.name.toLowerCase());
      if (!tc) {
        const def = toDef(c, sk, tk, false);
        // A NOT NULL column without a default cannot be added to a table that has rows.
        const safeDef = !def.nullable && !def.default ? { ...def, nullable: true } : def;
        push({
          kind: 'add-column',
          table: label,
          title: `Add column ${c.name}`,
          detail: `${def.type}${safeDef !== def ? ' (added as NULL — no default)' : ''}`,
          sql: addColumnSql(tk, ref(t), safeDef),
          destructive: false,
        });
      } else if (!sameType(c.type, sk, tc.type, tk) || c.nullable !== tc.nullable) {
        const def = toDef(c, sk, tk, false);
        const sql = alterColumnTypeSql(tk, ref(t), def);
        push({
          kind: 'alter-column',
          table: label,
          title: `Change column ${c.name}`,
          detail: `${tc.type}${tc.nullable ? '' : ' NOT NULL'} → ${def.type}${def.nullable ? '' : ' NOT NULL'}`,
          sql: sql ?? `-- SQLite cannot change a column type in place (requires rebuilding ${t.name})`,
          destructive: false,
          unsupported: !sql,
        });
      }
    }
    for (const tc of t.columns) {
      if (!sCols.has(tc.name.toLowerCase())) {
        push({ kind: 'drop-column', table: label, title: `Drop column ${tc.name}`, detail: tc.type, sql: dropColumnSql(tk, ref(t), tc.name), destructive: true });
      }
    }

    // Indexes (primary keys are compared through columns)
    const tIx = new Set(t.indexes.filter((i) => !i.primary).map(ixSig));
    const sIx = new Set(s.indexes.filter((i) => !i.primary).map(ixSig));
    for (const ix of s.indexes.filter((i) => !i.primary && !tIx.has(ixSig(i)))) {
      push({ kind: 'add-index', table: label, title: `Add index ${ix.name}`, detail: `${ix.unique ? 'unique ' : ''}(${ix.columns.join(', ')})`, sql: createIndexSql(tk, ref(t), ix.name, ix.columns, ix.unique), destructive: false });
    }
    for (const ix of t.indexes.filter((i) => !i.primary && !sIx.has(ixSig(i)) && !/^sqlite_autoindex/.test(i.name))) {
      push({ kind: 'drop-index', table: label, title: `Drop index ${ix.name}`, detail: `(${ix.columns.join(', ')})`, sql: dropIndexSql(tk, ref(t), ix.name), destructive: true });
    }

    // Foreign keys
    const tFk = new Set(t.foreignKeys.map(fkSig));
    const sFk = new Set(s.foreignKeys.map(fkSig));
    for (const fk of s.foreignKeys.filter((f) => !tFk.has(fkSig(f)))) {
      const sql = addForeignKeySql(tk, ref(t), { name: fk.name, columns: fk.columns, refTable: { schema: useSchema ? fk.refSchema : targetDefaultSchema, name: fk.refTable }, refColumns: fk.refColumns, onDelete: fk.onDelete });
      push({ kind: 'add-fk', table: label, title: `Add foreign key → ${fk.refTable}`, detail: fk.columns.join(', '), sql: sql ?? '-- SQLite: requires rebuilding the table', destructive: false, unsupported: !sql });
    }
    for (const fk of t.foreignKeys.filter((f) => !sFk.has(fkSig(f)))) {
      const sql = dropForeignKeySql(tk, ref(t), fk.name);
      push({ kind: 'drop-fk', table: label, title: `Drop foreign key ${fk.name}`, detail: `→ ${fk.refTable}`, sql: sql ?? '-- SQLite: requires rebuilding the table', destructive: true, unsupported: !sql });
    }
  }

  for (const t of tgtTables) {
    if (!srcBy.has(tkey(t, useSchema))) {
      const label = useSchema && t.schema ? `${t.schema}.${t.name}` : t.name;
      push({ kind: 'drop-table', table: label, title: `Drop table ${label}`, detail: t.rowCount != null ? `${t.rowCount} rows` : undefined, sql: dropTableSql(tk, ref(t)), destructive: true });
    }
  }

  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

export function migrationScript(kind: DbKind, changes: SchemaChange[], header: string): string {
  const sep = kind === 'mssql' ? '\nGO\n' : '\n';
  return `-- ${header}\n-- ${changes.length} change(s), generated by SchemaScope\n\n` + changes.map((c) => `-- ${c.title}\n${c.sql}`).join(sep + '\n') + '\n';
}

