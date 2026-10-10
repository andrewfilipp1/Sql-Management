import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  Eye,
  FileCode,
  Filter,
  Key,
  Link2,
  ListTree,
  Lock,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Rows3,
  Save,
  Table2,
  Trash2,
  Undo2,
  Waypoints,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addColumnSql,
  addForeignKeySql,
  alterColumnTypeSql,
  COMMON_TYPES,
  createIndexSql,
  dropColumnSql,
  dropForeignKeySql,
  dropIndexSql,
  renameColumnSql,
  selectSql,
} from '../../../shared/dialect';
import type { DbKind, RowChange, RowsResponse, SchemaSnapshot, TableInfo } from '../../../shared/types';
import { openDiagram, openTable, refreshSchema, tableMenu } from '../../lib/actions';
import { api } from '../../lib/api';
import { useConnection, useSchema, useStore, type Tab, type TableView } from '../../lib/store';
import { cn, findTable, formatMs, formatNumber, nodeId, relationsOf, sameTable } from '../../lib/utils';
import { DataGrid } from '../DataGrid';
import { SchemaVisualizer } from '../diagram/SchemaVisualizer';
import { SqlEditor } from '../SqlEditor';
import { TypeInput } from '../TypeInput';
import { Badge, Button, Checkbox, EmptyState, IconButton, Input, Segmented, Select, Spinner, spring, useContextMenu } from '../ui';

export function TableTab({ tab }: { tab: Tab }) {
  const conn = useConnection(tab.connId);
  const schemaState = useSchema(tab.connId, tab.database);
  const ensureSchema = useStore((s) => s.ensureSchema);
  const updateTab = useStore((s) => s.updateTab);
  const openMenu = useContextMenu();
  useEffect(() => ensureSchema(tab.connId, tab.database), [tab.connId, tab.database, ensureSchema]);

  const schema = schemaState?.data;
  const table = findTable(schema, tab.table!);
  const view = tab.view ?? 'data';
  const kind = conn?.kind ?? 'sqlite';

  if (!schema || !conn) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (!table) {
    return (
      <EmptyState icon={<Table2 className="size-6" />} title="Table not found">
        “{tab.table?.name}” no longer exists in {tab.database}.
      </EmptyState>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <motion.span
          initial={{ scale: 0.5, rotate: -20 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={spring}
          className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-accent shadow-[0_0_18px_-4px_rgb(129_140_248/0.8)]"
        >
          {table.type === 'view' ? <Eye className="size-4" /> : <Table2 className="size-4" />}
        </motion.span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold">
              {table.schema && <span className="text-muted">{table.schema}.</span>}
              {table.name}
            </h2>
            {table.type === 'view' && <Badge tone="accent">view</Badge>}
          </div>
          <div className="text-[11px] text-muted">
            {table.columns.length} columns · {table.rowCount != null ? `${formatNumber(table.rowCount)} rows · ` : ''}
            {table.foreignKeys.length} foreign keys · {table.indexes.length} indexes
          </div>
        </div>
        <div className="flex-1" />
        <Segmented<TableView>
          layoutId={`table-view-${tab.id}`}
          value={view}
          onChange={(v) => updateTab(tab.id, { view: v })}
          options={[
            { value: 'data', label: 'Data', icon: <Rows3 className="size-3.5" /> },
            { value: 'structure', label: 'Structure', icon: <Columns3 className="size-3.5" /> },
            { value: 'relations', label: 'Relations', icon: <ArrowLeftRight className="size-3.5" /> },
            { value: 'ddl', label: 'DDL', icon: <FileCode className="size-3.5" /> },
          ]}
        />
        <IconButton label="Query this table" onClick={() => useStore.getState().newQuery(tab.connId, tab.database, selectSql(kind, table))}>
          <Play className="size-4" />
        </IconButton>
        <IconButton label="Show in diagram" onClick={() => openDiagram(tab.connId, tab.database, nodeId(table))}>
          <Waypoints className="size-4" />
        </IconButton>
        <IconButton label="More actions" onClick={(e) => openMenu(e, tableMenu(tab.connId, tab.database, kind, table))}>
          <MoreHorizontal className="size-4" />
        </IconButton>
      </div>

      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16 }}
            className="h-full"
          >
            {view === 'data' && <DataView tab={tab} table={table} kind={kind} />}
            {view === 'structure' && <StructureView tab={tab} table={table} kind={kind} schema={schema} />}
            {view === 'relations' && (
              <SchemaVisualizer
                connId={tab.connId}
                database={tab.database}
                schema={schema}
                initialFocus={nodeId(table)}
                compact
                onOpenTable={(t) => openTable(tab.connId, tab.database, t, 'relations')}
              />
            )}
            {view === 'ddl' && <DdlView tab={tab} table={table} kind={kind} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------------- Data ----------------

function DataView({ tab, table, kind }: { tab: Tab; table: TableInfo; kind: DbKind }) {
  const toast = useStore((s) => s.toast);
  const [pageSize, setPageSize] = useState(100);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ column: string; dir: 'asc' | 'desc' } | null>(null);
  const [whereInput, setWhereInput] = useState('');
  const [where, setWhere] = useState('');
  const [data, setData] = useState<RowsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [edits, setEdits] = useState<Map<number, Map<number, unknown>>>(new Map());
  const [inserted, setInserted] = useState<unknown[][]>([]);
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const ref = useMemo(() => ({ schema: table.schema, name: table.name }), [table.schema, table.name]);
  const pk = table.primaryKey;
  const editable = table.type === 'table' && pk.length > 0;
  const fks = useMemo(() => new Set(table.foreignKeys.flatMap((f) => f.columns)), [table]);

  const reset = () => {
    setEdits(new Map());
    setInserted([]);
    setDeleted(new Set());
    setSelected(new Set());
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.rows(tab.connId, tab.database, {
        table: ref,
        offset: page * pageSize,
        limit: pageSize,
        orderBy: sort?.column,
        orderDir: sort?.dir,
        where: where || undefined,
      });
      setData(r);
      reset();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [tab.connId, tab.database, ref, page, pageSize, sort, where]);

  useEffect(() => {
    void load();
  }, [load]);

  const n = data?.rows.length ?? 0;
  const cols = data?.columns ?? [];
  const dirty = edits.size + inserted.length + deleted.size;

  const getValue = (r: number, c: number) => {
    if (r >= n) return inserted[r - n][c];
    const e = edits.get(r);
    return e?.has(c) ? e.get(c) : data!.rows[r][c];
  };

  const onEdit = (r: number, c: number, value: unknown) => {
    if (r >= n) {
      setInserted((rows) => rows.map((row, i) => (i === r - n ? row.map((v, j) => (j === c ? value : v)) : row)));
      return;
    }
    setEdits((prev) => {
      const next = new Map(prev);
      const rowEdits = new Map(next.get(r));
      const original = data!.rows[r][c];
      if (value === original || (value !== null && original !== null && String(value) === String(original))) rowEdits.delete(c);
      else rowEdits.set(c, value);
      if (rowEdits.size) next.set(r, rowEdits);
      else next.delete(r);
      return next;
    });
  };

  const onDeleteRows = (rows: number[]) => {
    const ins = rows.filter((r) => r >= n).map((r) => r - n);
    if (ins.length) setInserted((list) => list.filter((_, i) => !ins.includes(i)));
    setDeleted((d) => {
      const next = new Set(d);
      for (const r of rows) if (r < n) (next.has(r) ? next.delete(r) : next.add(r));
      return next;
    });
    setSelected(new Set());
  };

  const keyOf = (r: number) => Object.fromEntries(pk.map((col) => [col, data!.rows[r][cols.indexOf(col)]]));

  const save = async () => {
    const changes: RowChange[] = [];
    for (const r of deleted) changes.push({ type: 'delete', key: keyOf(r) });
    for (const [r, e] of edits) {
      if (deleted.has(r)) continue;
      changes.push({ type: 'update', key: keyOf(r), values: Object.fromEntries([...e].map(([c, v]) => [cols[c], v])) });
    }
    for (const row of inserted) {
      changes.push({ type: 'insert', values: Object.fromEntries(row.map((v, c) => [cols[c], v]).filter(([, v]) => v !== undefined)) });
    }
    setSaving(true);
    try {
      const r = await api.apply(tab.connId, tab.database, { table: ref, changes });
      toast(`Saved — ${r.affected} row(s) affected`, 'success');
      await load();
      void refreshSchema(tab.connId, tab.database);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const total = data?.total ?? null;
  const pages = total != null ? Math.max(1, Math.ceil(total / pageSize)) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(0);
            setWhere(whereInput.trim());
          }}
        >
          <Input
            icon={<Filter className="size-3.5" />}
            value={whereInput}
            onChange={(e) => setWhereInput(e.target.value)}
            placeholder="WHERE …   e.g.  status = 'paid' AND total > 100"
            className="h-7 font-mono text-xs"
          />
        </form>
        <AnimatePresence>
          {dirty > 0 && (
            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={spring} className="flex items-center gap-2">
              <Badge tone="warn">{dirty} pending</Badge>
              <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={reset}>
                Discard
              </Button>
              <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} loading={saving} onClick={() => void save()}>
                Save
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
        {editable ? (
          <>
            <IconButton label="Add row" onClick={() => setInserted((rows) => [...rows, cols.map(() => undefined)])}>
              <Plus className="size-4" />
            </IconButton>
            <IconButton label="Delete selected rows" disabled={!selected.size} onClick={() => onDeleteRows([...selected])}>
              <Trash2 className="size-4" />
            </IconButton>
          </>
        ) : (
          <span className="flex items-center gap-1 text-[11px] text-faint" title={table.type === 'view' ? 'Views are read-only' : 'Editing requires a primary key'}>
            <Lock className="size-3" /> read-only
          </span>
        )}
        <IconButton label="Reload" onClick={() => void load()}>
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
        </IconButton>
      </div>

      <div className="relative min-h-0 flex-1">
        {error ? (
          <div className="m-4 rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 font-mono text-xs text-rose-100">{error}</div>
        ) : data ? (
          <DataGrid
            columns={cols}
            rowCount={n + inserted.length}
            getValue={getValue}
            meta={(c) => {
              const col = table.columns.find((x) => x.name === cols[c]);
              return { pk: col?.isPrimaryKey, fk: fks.has(cols[c]), type: col?.type.toLowerCase() };
            }}
            rowState={(r) => (r >= n ? 'new' : deleted.has(r) ? 'deleted' : undefined)}
            isEdited={(r, c) => r < n && !!edits.get(r)?.has(c)}
            editable={editable}
            onEdit={onEdit}
            onDeleteRows={onDeleteRows}
            sort={sort}
            onSort={(column) => {
              setPage(0);
              setSort((s) => (s?.column !== column ? { column, dir: 'asc' } : s.dir === 'asc' ? { column, dir: 'desc' } : null));
            }}
            selected={selected}
            onSelectedChange={setSelected}
            rowOffset={page * pageSize}
          />
        ) : null}
        {loading && !data && (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="skeleton h-6" style={{ opacity: 1 - i * 0.1 }} />
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-xs text-muted">
        <span>
          {n ? `${formatNumber(page * pageSize + 1)}–${formatNumber(page * pageSize + n)}` : '0'} of {formatNumber(total)}
          {where && <span className="text-accent"> (filtered)</span>}
        </span>
        {data && <span className="text-faint">· {formatMs(data.durationMs)}</span>}
        <div className="flex-1" />
        <Select value={pageSize} onChange={(e) => (setPage(0), setPageSize(Number(e.target.value)))} className="h-6 text-xs">
          {[50, 100, 250, 500, 1000].map((s) => (
            <option key={s} value={s}>
              {s} / page
            </option>
          ))}
        </Select>
        <IconButton label="Previous page" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          <ChevronLeft className="size-4" />
        </IconButton>
        <span className="tabular-nums">
          {page + 1} / {pages ?? '?'}
        </span>
        <IconButton label="Next page" disabled={pages != null && page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
          <ChevronRight className="size-4" />
        </IconButton>
      </div>
    </div>
  );
}

// ---------------- Structure ----------------

function Section({ title, icon, action, children }: { title: string; icon: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="glass overflow-hidden rounded-2xl">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="text-accent">{icon}</span>
        <h3 className="flex-1 text-[13px] font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </motion.section>
  );
}

function StructureView({ tab, table, kind, schema }: { tab: Tab; table: TableInfo; kind: DbKind; schema: SchemaSnapshot }) {
  const { confirmSql, prompt } = useStore.getState();
  const ref = { schema: table.schema, name: table.name };
  const done = () => void refreshSchema(tab.connId, tab.database);
  const ask = (title: string, sql: string | null, danger = false, description?: string) => {
    if (!sql) return useStore.getState().toast('Not supported by this database', 'error');
    confirmSql({ connId: tab.connId, database: tab.database, title, sql, danger, description, onDone: done });
  };
  const isTable = table.type === 'table';
  const fkCols = new Set(table.foreignKeys.flatMap((f) => f.columns));
  const incoming = relationsOf(schema).filter((r) => sameTable(r.to, table) && !sameTable(r.from, table));

  const [newCol, setNewCol] = useState({ name: '', type: COMMON_TYPES[kind][1], nullable: true, default: '' });
  const [newIx, setNewIx] = useState<{ cols: string[]; unique: boolean }>({ cols: [], unique: false });
  const [newFk, setNewFk] = useState({ column: '', ref: '', refColumn: '' });
  const refTables = schema.tables.filter((t) => t.type === 'table');

  return (
    <div className="h-full space-y-4 overflow-auto p-4">
      <Section title="Columns" icon={<Columns3 className="size-4" />}>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[10.5px] tracking-wide text-muted uppercase">
              <th className="w-8 px-4 py-2" />
              <th className="py-2">Name</th>
              <th>Type</th>
              <th>Nullable</th>
              <th>Default</th>
              <th className="w-28" />
            </tr>
          </thead>
          <tbody>
            {table.columns.map((c, i) => (
              <motion.tr
                key={c.name}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ ...spring, delay: Math.min(i * 0.02, 0.4) }}
                className="group border-t border-line/60 hover:bg-white/[0.025]"
              >
                <td className="px-4 py-1.5">
                  {c.isPrimaryKey ? <Key className="size-3.5 text-pk" /> : fkCols.has(c.name) ? <Link2 className="size-3.5 text-fk" /> : null}
                </td>
                <td className="font-mono text-[12.5px]">
                  {c.name}
                  {c.isIdentity && <Badge className="ml-2">auto</Badge>}
                  {c.comment && <div className="font-sans text-[11px] text-faint">{c.comment}</div>}
                </td>
                <td className="font-mono text-[12px] text-accent">{c.type}</td>
                <td className="text-xs text-muted">{c.nullable ? 'yes' : <span className="text-fg">NOT NULL</span>}</td>
                <td className="max-w-[220px] truncate font-mono text-[11.5px] text-muted" title={c.default ?? ''}>
                  {c.default ?? '—'}
                </td>
                <td className="pr-3">
                  {isTable && (
                    <span className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100">
                      <IconButton
                        label="Rename column"
                        onClick={async () => {
                          const to = await prompt(`Rename column ${c.name}`, 'New name', c.name);
                          if (to && to !== c.name) ask('Rename column', renameColumnSql(kind, ref, c.name, to));
                        }}
                      >
                        <Pencil className="size-3.5" />
                      </IconButton>
                      <IconButton
                        label="Change type"
                        onClick={async () => {
                          const type = await prompt(`Change type of ${c.name}`, 'New type', c.type);
                          if (type && type !== c.type)
                            ask('Change column type', alterColumnTypeSql(kind, ref, { name: c.name, type, nullable: c.nullable, primaryKey: false, identity: false }));
                        }}
                      >
                        <ListTree className="size-3.5" />
                      </IconButton>
                      <IconButton
                        label="Drop column"
                        onClick={() => ask(`Drop column ${c.name}`, dropColumnSql(kind, ref, c.name), true, 'The column and its data will be permanently removed.')}
                      >
                        <Trash2 className="size-3.5" />
                      </IconButton>
                    </span>
                  )}
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
        {isTable && (
          <form
            className="flex items-center gap-2 border-t border-line bg-white/[0.02] px-4 py-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newCol.name.trim()) return;
              ask('Add column', addColumnSql(kind, ref, { ...newCol, primaryKey: false, identity: false }));
              setNewCol((c) => ({ ...c, name: '', default: '' }));
            }}
          >
            <Plus className="size-4 text-faint" />
            <Input value={newCol.name} onChange={(e) => setNewCol({ ...newCol, name: e.target.value })} placeholder="new_column" className="h-7 w-44 font-mono text-xs" />
            <div className="w-40">
              <TypeInput value={newCol.type} onChange={(type) => setNewCol({ ...newCol, type })} types={COMMON_TYPES[kind]} className="h-7 font-mono text-xs" />
            </div>
            <Input value={newCol.default} onChange={(e) => setNewCol({ ...newCol, default: e.target.value })} placeholder="default" className="h-7 w-32 font-mono text-xs" />
            <Checkbox checked={newCol.nullable} onChange={(v) => setNewCol({ ...newCol, nullable: v })} label="nullable" />
            <div className="flex-1" />
            <Button size="sm" type="submit" disabled={!newCol.name.trim()}>
              Add column
            </Button>
          </form>
        )}
      </Section>

      <Section title="Indexes" icon={<ListTree className="size-4" />}>
        {table.indexes.length ? (
          table.indexes.map((ix) => (
            <div key={ix.name} className="group flex items-center gap-3 border-t border-line/60 px-4 py-2 first:border-0">
              <span className="font-mono text-[12.5px]">{ix.name}</span>
              {ix.primary && <Badge tone="pk">primary</Badge>}
              {ix.unique && !ix.primary && <Badge tone="accent">unique</Badge>}
              <span className="flex-1 truncate font-mono text-[11.5px] text-muted">({ix.columns.join(', ')})</span>
              {!ix.primary && isTable && !ix.name.startsWith('sqlite_autoindex') && (
                <IconButton label="Drop index" className="opacity-0 group-hover:opacity-100" onClick={() => ask(`Drop index ${ix.name}`, dropIndexSql(kind, ref, ix.name), true)}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              )}
            </div>
          ))
        ) : (
          <div className="px-4 py-3 text-xs text-faint">No indexes.</div>
        )}
        {isTable && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line bg-white/[0.02] px-4 py-2.5">
            <Plus className="size-4 text-faint" />
            {table.columns.map((c) => (
              <button
                key={c.name}
                onClick={() =>
                  setNewIx((ix) => ({ ...ix, cols: ix.cols.includes(c.name) ? ix.cols.filter((x) => x !== c.name) : [...ix.cols, c.name] }))
                }
                className={cn(
                  'rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-all',
                  newIx.cols.includes(c.name) ? 'border-accent/50 bg-accent-soft text-fg shadow-[0_0_10px_-3px_rgb(129_140_248/0.8)]' : 'border-line text-muted hover:text-fg',
                )}
              >
                {newIx.cols.includes(c.name) && <span className="mr-1 text-accent">{newIx.cols.indexOf(c.name) + 1}</span>}
                {c.name}
              </button>
            ))}
            <Checkbox checked={newIx.unique} onChange={(v) => setNewIx({ ...newIx, unique: v })} label="unique" />
            <div className="flex-1" />
            <Button
              size="sm"
              disabled={!newIx.cols.length}
              onClick={() => {
                ask('Create index', createIndexSql(kind, ref, `ix_${table.name}_${newIx.cols.join('_')}`, newIx.cols, newIx.unique));
                setNewIx({ cols: [], unique: false });
              }}
            >
              Create index
            </Button>
          </div>
        )}
      </Section>

      <Section title="Relationships" icon={<Link2 className="size-4" />}>
        <div className="px-4 pt-2 pb-1 text-[10.5px] tracking-wide text-muted uppercase">References</div>
        {table.foreignKeys.length ? (
          table.foreignKeys.map((fk) => (
            <div key={fk.name} className="group flex items-center gap-3 px-4 py-1.5">
              <Link2 className="size-3.5 text-fk" />
              <span className="font-mono text-[12.5px]">{fk.columns.join(', ')}</span>
              <span className="text-faint">→</span>
              <button className="font-mono text-[12.5px] text-accent hover:underline" onClick={() => openTable(tab.connId, tab.database, { schema: fk.refSchema, name: fk.refTable }, 'structure')}>
                {fk.refTable}({fk.refColumns.join(', ')})
              </button>
              {fk.onDelete && fk.onDelete !== 'NO ACTION' && <Badge tone="warn">ON DELETE {fk.onDelete}</Badge>}
              <span className="flex-1 truncate text-[11px] text-faint">{fk.name}</span>
              {kind !== 'sqlite' && (
                <IconButton label="Drop foreign key" className="opacity-0 group-hover:opacity-100" onClick={() => ask(`Drop ${fk.name}`, dropForeignKeySql(kind, ref, fk.name), true)}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              )}
            </div>
          ))
        ) : (
          <div className="px-4 py-1.5 text-xs text-faint">None.</div>
        )}
        <div className="px-4 pt-3 pb-1 text-[10.5px] tracking-wide text-muted uppercase">Referenced by</div>
        {incoming.length ? (
          incoming.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-1.5">
              <Link2 className="size-3.5 rotate-180 text-fk" />
              <button className="font-mono text-[12.5px] text-accent hover:underline" onClick={() => openTable(tab.connId, tab.database, r.from, 'structure')}>
                {r.from.name}({r.fromColumns.join(', ')})
              </button>
              <span className="text-faint">→</span>
              <span className="font-mono text-[12.5px]">{r.toColumns.join(', ')}</span>
            </div>
          ))
        ) : (
          <div className="px-4 py-1.5 text-xs text-faint">None.</div>
        )}
        {isTable && kind !== 'sqlite' && (
          <div className="mt-2 flex items-center gap-2 border-t border-line bg-white/[0.02] px-4 py-2.5">
            <Plus className="size-4 text-faint" />
            <Select value={newFk.column} onChange={(e) => setNewFk({ ...newFk, column: e.target.value })} className="h-7 text-xs">
              <option value="">column…</option>
              {table.columns.map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
            </Select>
            <span className="text-fk">→</span>
            <Select
              value={newFk.ref}
              onChange={(e) => setNewFk({ ...newFk, ref: e.target.value, refColumn: refTables.find((t) => nodeId(t) === e.target.value)?.primaryKey[0] ?? '' })}
              className="h-7 text-xs"
            >
              <option value="">table…</option>
              {refTables.map((t) => (
                <option key={nodeId(t)}>{nodeId(t)}</option>
              ))}
            </Select>
            <Select value={newFk.refColumn} onChange={(e) => setNewFk({ ...newFk, refColumn: e.target.value })} className="h-7 text-xs">
              <option value="">column…</option>
              {refTables.find((t) => nodeId(t) === newFk.ref)?.columns.map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
            </Select>
            <div className="flex-1" />
            <Button
              size="sm"
              disabled={!newFk.column || !newFk.ref || !newFk.refColumn}
              onClick={() => {
                const target = refTables.find((t) => nodeId(t) === newFk.ref)!;
                ask(
                  'Add foreign key',
                  addForeignKeySql(kind, ref, { columns: [newFk.column], refTable: { schema: target.schema, name: target.name }, refColumns: [newFk.refColumn] }),
                );
              }}
            >
              Add relation
            </Button>
          </div>
        )}
        {isTable && kind === 'sqlite' && (
          <div className="mt-2 border-t border-line px-4 py-2 text-[11px] text-faint">SQLite cannot add foreign keys to an existing table — define them when creating the table.</div>
        )}
      </Section>
    </div>
  );
}

// ---------------- DDL ----------------

function DdlView({ tab, table, kind }: { tab: Tab; table: TableInfo; kind: DbKind }) {
  const [ddl, setDdl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDdl(null);
    api
      .ddl(tab.connId, tab.database, { schema: table.schema, name: table.name })
      .then(setDdl)
      .catch((e: Error) => setError(e.message));
  }, [tab.connId, tab.database, table]);

  if (error) return <div className="m-4 font-mono text-xs text-danger">{error}</div>;
  if (ddl == null) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-2 border-b border-line px-3 py-2">
        <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => void navigator.clipboard.writeText(ddl).then(() => useStore.getState().toast('Copied', 'success'))}>
          Copy
        </Button>
        <Button size="sm" icon={<Play className="size-3.5" />} onClick={() => useStore.getState().newQuery(tab.connId, tab.database, ddl)}>
          Open in query
        </Button>
      </div>
      <div className="min-h-0 flex-1 bg-black/15">
        <SqlEditor value={ddl} kind={kind} readOnly />
      </div>
    </div>
  );
}
