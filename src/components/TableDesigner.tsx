import { AnimatePresence, motion } from 'motion/react';
import { Key, Link2, Plus, TableProperties, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { COMMON_TYPES, createTableSql, type ColumnDef, type ForeignKeyDef } from '../../shared/dialect';
import { openTable, refreshSchema } from '../lib/actions';
import { api } from '../lib/api';
import { useConnection, useSchema, useStore } from '../lib/store';
import { cn, nodeId, resolveRef } from '../lib/utils';
import { SqlEditor } from './SqlEditor';
import { Button, Field, IconButton, Input, Modal, Select, spring } from './ui';

interface FkRow {
  column: string;
  ref: string; // node id
  refColumn: string;
  onDelete: string;
}

export function TableDesigner() {
  const target = useStore((s) => s.designer);
  const close = () => useStore.getState().openDesigner(null);
  const conn = useConnection(target?.connId ?? '');
  const schema = useSchema(target?.connId ?? '', target?.database ?? '')?.data;
  const kind = conn?.kind ?? 'sqlite';
  const types = COMMON_TYPES[kind];

  const defaultSchema = kind === 'postgres' ? 'public' : kind === 'mssql' ? 'dbo' : '';
  const [name, setName] = useState('');
  const [tableSchema, setTableSchema] = useState(defaultSchema);
  const [cols, setCols] = useState<ColumnDef[]>([]);
  const [fks, setFks] = useState<FkRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!target) return;
    setName('');
    setTableSchema(defaultSchema);
    setCols([
      { name: 'id', type: types[0], nullable: false, primaryKey: true, identity: true },
      { name: 'name', type: kind === 'mssql' ? 'nvarchar(255)' : kind === 'sqlite' ? 'TEXT' : kind === 'mysql' ? 'VARCHAR(255)' : 'text', nullable: false, primaryKey: false, identity: false },
    ]);
    setFks([]);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const tablesById = useMemo(() => new Map((schema?.tables ?? []).filter((t) => t.type === 'table').map((t) => [nodeId(t), t])), [schema]);

  const sql = useMemo(() => {
    const foreignKeys: ForeignKeyDef[] = fks
      .filter((f) => f.column && f.ref && f.refColumn)
      .map((f) => {
        const t = tablesById.get(f.ref);
        return { columns: [f.column], refTable: { schema: t?.schema, name: t?.name ?? f.ref }, refColumns: [f.refColumn], onDelete: f.onDelete };
      });
    return createTableSql(kind, {
      table: { schema: tableSchema || undefined, name: name || 'new_table' },
      columns: cols.filter((c) => c.name.trim()),
      foreignKeys,
    });
  }, [kind, name, tableSchema, cols, fks, tablesById]);

  const patchCol = (i: number, p: Partial<ColumnDef>) => setCols((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)));

  const create = async () => {
    if (!target) return;
    setRunning(true);
    setError(null);
    try {
      await api.query(target.connId, target.database, sql);
      const s = await refreshSchema(target.connId, target.database);
      useStore.getState().toast(`Table “${name}” created`, 'success');
      close();
      const created = s && resolveRef(s, tableSchema || undefined, name);
      if (created) openTable(target.connId, target.database, created, 'structure');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open={!!target}
      onClose={close}
      title="Create table"
      icon={<TableProperties className="size-4" />}
      width={900}
      footer={
        <>
          {error && <span className="mr-auto line-clamp-2 font-mono text-xs text-danger">{error}</span>}
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={running} disabled={!name.trim() || !cols.some((c) => c.name.trim())} onClick={() => void create()}>
            Create table
          </Button>
        </>
      }
    >
      <datalist id="designer-types">
        {types.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className="grid grid-cols-[1fr_200px] gap-3">
        <Field label="Table name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="customers" />
        </Field>
        {(kind === 'postgres' || kind === 'mssql') && (
          <Field label="Schema">
            <Select value={tableSchema} onChange={(e) => setTableSchema(e.target.value)}>
              {(schema?.schemas.length ? schema.schemas : [defaultSchema]).map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      <div className="mt-4 mb-1.5 flex items-center">
        <span className="flex-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Columns</span>
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setCols((c) => [...c, { name: '', type: types[1] ?? types[0], nullable: true, primaryKey: false, identity: false }])}>
          Add column
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border border-line">
        <div className="grid grid-cols-[1.3fr_1.2fr_44px_56px_56px_1fr_32px] gap-2 border-b border-line bg-white/[0.03] px-3 py-1.5 text-[10.5px] font-semibold tracking-wide text-muted uppercase">
          <span>Name</span>
          <span>Type</span>
          <span className="text-center">PK</span>
          <span className="text-center">Auto</span>
          <span className="text-center">Null</span>
          <span>Default</span>
          <span />
        </div>
        <AnimatePresence initial={false}>
          {cols.map((c, i) => (
            <motion.div
              key={i}
              layout
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={spring}
              className="grid grid-cols-[1.3fr_1.2fr_44px_56px_56px_1fr_32px] items-center gap-2 border-b border-line/60 px-3 py-1.5 last:border-0"
            >
              <Input value={c.name} onChange={(e) => patchCol(i, { name: e.target.value })} placeholder="column_name" className="h-7 font-mono text-xs" />
              <Input value={c.type} onChange={(e) => patchCol(i, { type: e.target.value })} list="designer-types" className="h-7 font-mono text-xs" />
              <button
                onClick={() => patchCol(i, { primaryKey: !c.primaryKey, nullable: c.primaryKey ? c.nullable : false })}
                className={cn('mx-auto flex size-7 items-center justify-center rounded-md transition-all', c.primaryKey ? 'bg-amber-400/15 text-pk shadow-[0_0_12px_-3px_rgb(251_191_36/0.8)]' : 'text-faint hover:text-muted')}
                title="Primary key"
              >
                <Key className="size-3.5" />
              </button>
              <input type="checkbox" checked={c.identity} onChange={(e) => patchCol(i, { identity: e.target.checked })} className="mx-auto size-3.5 accent-indigo-400" title="Auto-increment / identity" />
              <input type="checkbox" checked={c.nullable} disabled={c.primaryKey} onChange={(e) => patchCol(i, { nullable: e.target.checked })} className="mx-auto size-3.5 accent-indigo-400" />
              <Input value={c.default ?? ''} onChange={(e) => patchCol(i, { default: e.target.value })} placeholder="—" className="h-7 font-mono text-xs" />
              <IconButton label="Remove column" onClick={() => setCols((cs) => cs.filter((_, j) => j !== i))}>
                <Trash2 className="size-3.5" />
              </IconButton>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div className="mt-4 mb-1.5 flex items-center">
        <span className="flex-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Foreign keys</span>
        <Button size="sm" variant="ghost" icon={<Link2 className="size-3.5" />} disabled={!tablesById.size} onClick={() => setFks((f) => [...f, { column: '', ref: '', refColumn: '', onDelete: 'NO ACTION' }])}>
          Add relation
        </Button>
      </div>
      {fks.map((f, i) => {
        const ref = tablesById.get(f.ref);
        const patch = (p: Partial<FkRow>) => setFks((fs) => fs.map((x, j) => (j === i ? { ...x, ...p } : x)));
        return (
          <motion.div key={i} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="mb-1.5 flex items-center gap-2">
            <Select value={f.column} onChange={(e) => patch({ column: e.target.value })} className="h-7 flex-1 text-xs">
              <option value="">column…</option>
              {cols.filter((c) => c.name).map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
            </Select>
            <span className="text-fk">→</span>
            <Select value={f.ref} onChange={(e) => patch({ ref: e.target.value, refColumn: tablesById.get(e.target.value)?.primaryKey[0] ?? '' })} className="h-7 flex-1 text-xs">
              <option value="">table…</option>
              {[...tablesById.keys()].map((id) => (
                <option key={id}>{id}</option>
              ))}
            </Select>
            <Select value={f.refColumn} onChange={(e) => patch({ refColumn: e.target.value })} className="h-7 flex-1 text-xs">
              <option value="">column…</option>
              {ref?.columns.map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
            </Select>
            <Select value={f.onDelete} onChange={(e) => patch({ onDelete: e.target.value })} className="h-7 text-xs">
              {['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT'].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
            <IconButton label="Remove" onClick={() => setFks((fs) => fs.filter((_, j) => j !== i))}>
              <Trash2 className="size-3.5" />
            </IconButton>
          </motion.div>
        );
      })}

      <div className="mt-4 mb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">SQL preview</div>
      <div className="h-44 overflow-hidden rounded-xl border border-line bg-black/30">
        <SqlEditor value={sql} kind={kind} readOnly minimal />
      </div>
    </Modal>
  );
}
