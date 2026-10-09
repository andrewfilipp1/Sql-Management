import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { AlertTriangle, CheckCircle2, Eye, Fingerprint, Info, Key, Link2, Plus, RotateCcw, Table2, Trash2, XCircle } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { memo, useEffect, useRef, useState } from 'react';
import type { TableInfo } from '../../../shared/types';
import type { Mark } from '../../lib/designer';
import type { Problem, Severity } from '../../lib/lint';
import { SEVERITY_RANK } from '../../lib/lint';
import { cn, compactNumber } from '../../lib/utils';
import { spring } from '../ui';
import { useDesign } from './designContext';
import { fkColumnSet, HEADER_H, nodeHeight, ROW_H, visibleColumns } from './layout';

export type ApplyState = 'pending' | 'running' | 'done' | 'failed';

export interface TableNodeData extends Record<string, unknown> {
  table: TableInfo;
  hue: number;
  keysOnly: boolean;
  index: number;
  /** Columns taking part in the currently highlighted relations. */
  activeColumns?: Set<string>;
  highlighted?: boolean;
  selected?: boolean;
  matched?: boolean;
  /** Drag from a column onto another table's column to create a foreign key. */
  connectable?: boolean;
  /** Edit mode. */
  editing?: boolean;
  design?: { table?: Mark; columns: Record<string, Mark> };
  problems?: Problem[];
  apply?: { state: ApplyState; error?: string; tick: number };
  /** A palette item is being dragged over this table. */
  dropTarget?: boolean;
  /** Large diagram: no backdrop blur or hover scaling (they dominate render cost with hundreds of nodes). */
  lite?: boolean;
  /** Zoomed far out on a large diagram: draw a simple block (name + problems) instead of every column. */
  far?: boolean;
}

export type TableNodeType = Node<TableNodeData, 'table'>;

export const HEADER_HANDLE = '__header';

/** Four invisible handles per row so edges can attach on whichever side faces their peer. */
function Handles({ id, top, connectable }: { id: string; top: number; connectable?: boolean }) {
  const style = { top };
  return (
    <>
      {/* Targets first so the overlapping source handles sit on top: a drag must start as "from this column". */}
      <Handle type="target" position={Position.Left} id={`${id}:L:t`} style={style} isConnectable={connectable} isConnectableStart={false} />
      <Handle type="target" position={Position.Right} id={`${id}:R:t`} style={style} isConnectable={connectable} isConnectableStart={false} />
      <Handle type="source" position={Position.Left} id={`${id}:L:s`} style={style} isConnectable={connectable} />
      <Handle type="source" position={Position.Right} id={`${id}:R:s`} style={style} isConnectable={connectable} />
    </>
  );
}

const SEV_COLOR: Record<Severity, string> = { error: '#fb7185', warning: '#fbbf24', info: '#38bdf8' };
const SevIcon = ({ s, className }: { s: Severity; className?: string }) =>
  s === 'error' ? <XCircle className={className} /> : s === 'warning' ? <AlertTriangle className={className} /> : <Info className={className} />;

const MARK_STYLE: Record<Mark, string> = {
  new: 'bg-emerald-400/10 shadow-[inset_2px_0_0_#34d399]',
  changed: 'bg-amber-400/10 shadow-[inset_2px_0_0_#fbbf24]',
  renamed: 'bg-amber-400/10 shadow-[inset_2px_0_0_#fbbf24]',
  deleted: 'bg-rose-500/10 shadow-[inset_2px_0_0_#fb7185] opacity-60',
};

/** Small inline editor used for table and column names / types. */
function InlineInput({ value, onCommit, onCancel, list, className }: { value: string; onCommit: (v: string) => void; onCancel: () => void; list?: string; className?: string }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const mountedAt = useRef(Date.now());
  // Focus after the current event finishes: right after a palette drop the browser hands focus back
  // when the drag ends, which would otherwise blur (and close) the editor immediately.
  // Retry briefly until focus sticks (the node can re-render right after a drop).
  const grab = () => {
    let tries = 0;
    let stable = 0;
    const attempt = () => {
      const el = ref.current;
      if (!el || !el.isConnected) return;
      if (document.activeElement === el) {
        if (++stable >= 2) return; // focus held for ~100 ms: done, never fight the user afterwards
      } else {
        stable = 0;
        el.focus();
        el.select();
      }
      if (++tries < 20) timer = window.setTimeout(attempt, 50);
    };
    let timer = window.setTimeout(attempt, 30);
    return timer;
  };
  useEffect(() => {
    const t = grab();
    // The drag source (palette chip) takes focus when the drag ends, after this editor opened.
    const onDragEnd = () => {
      if (Date.now() - mountedAt.current < 2000) grab();
    };
    window.addEventListener('dragend', onDragEnd, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('dragend', onDragEnd, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => (v.trim() && v !== value ? onCommit(v.trim()) : onCancel());
  return (
    <input
      ref={ref}
      value={v}
      list={list}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (Date.now() - mountedAt.current < 400) grab();
        else commit();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onCancel();
      }}
      className={cn(
        'nodrag nopan min-w-0 rounded bg-[#0b1024] px-1 text-white shadow-[0_0_0_1.5px_rgb(34_211_238/0.8),0_0_14px_rgb(34_211_238/0.5)] outline-none',
        className,
      )}
    />
  );
}

/** Level-of-detail block: same footprint as the full node, readable name, no per-column DOM. */
function FarNode({ data }: { data: TableNodeData }) {
  const { table, hue, keysOnly, design, problems, highlighted, selected, matched } = data;
  const worst = problems?.reduce<Severity | null>((w, p) => (!w || SEVERITY_RANK[p.severity] > SEVERITY_RANK[w] ? p.severity : w), null) ?? null;
  const lit = highlighted || selected || matched;
  return (
    <div
      className="relative w-[264px] overflow-hidden rounded-xl border"
      style={{
        height: nodeHeight(table, keysOnly),
        background: design?.table === 'new' ? 'rgb(16 60 50)' : `hsl(${hue} 45% 18%)`,
        borderColor: worst === 'error' ? SEV_COLOR.error : lit ? `hsl(${hue} 85% 66%)` : `hsl(${hue} 60% 40%)`,
        borderWidth: worst === 'error' || lit ? 6 : 2,
      }}
    >
      <Handles id={HEADER_HANDLE} top={HEADER_H / 2} />
      <div className="px-4 pt-3 text-[34px] leading-tight font-bold break-all text-white">{table.name}</div>
      <div className="px-4 text-[22px] text-white/50">{table.columns.length} cols</div>
      {worst && (
        <div className="absolute right-3 bottom-3 rounded-full px-3 text-[24px] font-bold text-[#0b0e1a]" style={{ background: SEV_COLOR[worst] }}>
          {problems!.length}
        </div>
      )}
    </div>
  );
}

function TableNodeImpl({ id, data }: NodeProps<TableNodeType>) {
  if (data.far) return <FarNode data={data} />;
  return <FullNode id={id} data={data} />;
}

function FullNode({ id, data }: { id: string; data: TableNodeData }) {
  const { table, hue, keysOnly, index, activeColumns, highlighted, selected, matched, connectable, editing, design, problems, apply, dropTarget, lite } = data;
  const d = useDesign();
  const fks = fkColumnSet(table);
  const { columns, hidden } = visibleColumns(table, keysOnly, !!editing);
  const accent = `hsl(${hue} 85% 66%)`;
  const lit = highlighted || selected;
  const tableMark = design?.table;
  const isNew = tableMark === 'new';
  const isDeleted = tableMark === 'deleted';
  const editable = !!editing && table.type === 'table' && !isDeleted;
  const [edit, setEdit] = useState<{ col?: string; field: 'name' | 'type' } | null>(null);

  // Open a freshly added column straight in rename mode.
  useEffect(() => {
    if (d.autoEdit && d.autoEdit.key === id) setEdit(d.autoEdit.column ? { col: d.autoEdit.column, field: 'name' } : { field: 'name' });
  }, [d.autoEdit, id]);

  const worst = problems?.reduce<Severity | null>((w, p) => (!w || SEVERITY_RANK[p.severity] > SEVERITY_RANK[w] ? p.severity : w), null) ?? null;
  const colProblems = (c: string) => problems?.filter((p) => p.column === c) ?? [];
  const failed = apply?.state === 'failed';

  const ring = failed
    ? '0 0 0 2px #fb7185, 0 0 40px -2px rgb(251 113 133 / 0.8)'
    : lit
      ? `0 0 0 1.5px ${accent}, 0 0 32px -4px hsl(${hue} 85% 60% / 0.55), 0 18px 40px -18px rgb(0 0 0 / 0.8)`
      : matched
        ? `0 0 0 2px #22d3ee, 0 0 30px -4px rgb(34 211 238 / 0.6)`
        : '0 14px 34px -16px rgb(0 0 0 / 0.85)';

  return (
    <div className={cn('relative', !lite && 'node-in')} style={lite ? undefined : { animationDelay: `${Math.min(index * 28, 900)}ms` }}>
      {/* Problem badge */}
      <AnimatePresence>
        {worst && !isDeleted && (
          <motion.div
            key={`${worst}-${problems!.length}`}
            initial={{ scale: 0, rotate: -30 }}
            animate={{ scale: 1, rotate: 0 }}
            exit={{ scale: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 15 }}
            title={problems!.map((p) => `• ${p.title}`).join('\n')}
            className="absolute -top-2.5 -right-2.5 z-10 flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-full px-1.5 text-[11px] font-bold text-[#0b0e1a]"
            style={{ background: SEV_COLOR[worst], boxShadow: lite ? undefined : `0 0 16px ${SEV_COLOR[worst]}` }}
          >
            <SevIcon s={worst} className="size-3.5" />
            {problems!.length > 1 && problems!.length}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        key={failed ? `fail-${apply?.tick}` : 'node'}
        whileHover={editable || lite ? undefined : { scale: 1.03 }}
        transition={spring}
        className={cn(
          'relative w-[264px] overflow-hidden rounded-xl border transition-[border-color,box-shadow,opacity,filter] duration-300',
          lite ? 'bg-[linear-gradient(180deg,#161b32,#0c0f1e)]' : 'bg-[linear-gradient(180deg,rgb(22_27_50/0.92),rgb(12_15_30/0.92))] backdrop-blur-xl',
          lit ? 'border-transparent' : 'border-white/10 hover:border-white/20',
          worst === 'error' && !isDeleted && 'problem-error',
          // The badge already marks warnings; the outline costs a repaint per node in large diagrams.
          worst === 'warning' && !isDeleted && !lite && 'problem-warning',
          isNew && 'draft-new',
          isDeleted && 'draft-deleted',
          failed && 'shake',
          apply?.state === 'done' && 'applied-flash',
          dropTarget && 'palette-drag-over',
        )}
        style={{ boxShadow: ring }}
      >
        {/* Header */}
        <div
          className="group/header relative flex items-center gap-2.5 px-3"
          style={{
            height: HEADER_H,
            background: isNew
              ? 'linear-gradient(120deg, rgb(52 211 153 / 0.28), rgb(34 211 238 / 0.06) 70%)'
              : `linear-gradient(120deg, hsl(${hue} 80% 58% / 0.30), hsl(${hue} 80% 50% / 0.06) 70%)`,
            borderBottom: `1px solid hsl(${hue} 80% 65% / 0.25)`,
          }}
        >
          <Handles id={HEADER_HANDLE} top={HEADER_H / 2} />
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-md"
            style={{ background: `hsl(${hue} 80% 60% / 0.18)`, color: accent, boxShadow: `0 0 12px -2px hsl(${hue} 85% 60% / 0.6)` }}
          >
            {table.type === 'view' ? <Eye className="size-3.5" /> : <Table2 className="size-3.5" />}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            {table.schema && <div className="truncate text-[10px] text-white/45">{table.schema}</div>}
            {edit?.field === 'name' && !edit.col ? (
              <InlineInput value={table.name} onCommit={(v) => (d.renameTable(id, v), setEdit(null))} onCancel={() => setEdit(null)} className="w-full text-[13px] font-semibold" />
            ) : (
              <div
                className={cn('truncate text-[13px] font-semibold text-white', isDeleted && 'line-through', editable && 'cursor-text')}
                onDoubleClick={(e) => {
                  if (!editable) return;
                  e.stopPropagation();
                  setEdit({ field: 'name' });
                }}
                title={editable ? 'Double-click to rename' : undefined}
              >
                {table.name}
                {tableMark === 'renamed' && <span className="ml-1.5 text-[9.5px] font-medium text-amber-300">RENAMED</span>}
              </div>
            )}
          </div>
          {isNew && <span className="rounded-md bg-emerald-400/20 px-1.5 py-0.5 text-[9.5px] font-bold tracking-wide text-emerald-200">NEW</span>}
          {!isNew && table.rowCount != null && (
            <span className="rounded-md bg-black/30 px-1.5 py-0.5 font-mono text-[10px] text-white/70">{compactNumber(table.rowCount)}</span>
          )}
          {editing && table.type === 'table' && (
            <button
              className="nodrag hidden size-6 items-center justify-center rounded-md text-white/60 group-hover/header:flex hover:bg-white/10 hover:text-white"
              title={isDeleted ? 'Keep this table' : 'Drop this table'}
              aria-label={isDeleted ? 'Keep this table' : 'Drop this table'}
              onClick={(e) => {
                e.stopPropagation();
                if (isDeleted) d.restoreTable(id);
                else d.dropTable(id);
              }}
            >
              {isDeleted ? <RotateCcw className="size-3.5" /> : <Trash2 className="size-3.5" />}
            </button>
          )}
        </div>

        {/* Columns */}
        <div className="py-1">
          <AnimatePresence initial={false}>
            {columns.map((c, i) => {
              const isFk = fks.has(c.name);
              const active = activeColumns?.has(c.name);
              const mark = design?.columns[c.name];
              const cp = colProblems(c.name);
              const colWorst = cp.reduce<Severity | null>((w, p) => (!w || SEVERITY_RANK[p.severity] > SEVERITY_RANK[w] ? p.severity : w), null);
              const colDeleted = mark === 'deleted';
              return (
                <motion.div
                  key={c.name}
                  data-column={c.name}
                  // Row animations (and their layout measuring) only while editing; outside edit mode a
                  // large diagram would pay for them on every render.
                  {...(editing && !lite
                    ? {
                        layout: 'position' as const,
                        initial: { opacity: 0, x: -14 },
                        animate: { opacity: 1, x: 0 },
                        exit: { opacity: 0, height: 0 },
                        transition: { duration: 0.35 },
                      }
                    : {})}
                  className={cn(
                    'group/col relative flex items-center gap-2 px-3 font-mono text-[11.5px] transition-colors duration-200',
                    active && 'bg-cyan-400/10',
                    mark && MARK_STYLE[mark],
                  )}
                  style={{ height: ROW_H }}
                >
                  <Handles id={c.name} top={ROW_H / 2} connectable={connectable && table.type === 'table' && !colDeleted} />
                  <button
                    className={cn('nodrag flex w-4 shrink-0 justify-center', editable && isNew && !colDeleted ? 'cursor-pointer' : 'cursor-default')}
                    title={editable && isNew ? 'Toggle primary key' : undefined}
                    onClick={(e) => {
                      if (!(editable && isNew && !colDeleted)) return;
                      e.stopPropagation();
                      d.togglePk(id, c.name);
                    }}
                  >
                    {c.isPrimaryKey ? (
                      <Key className={cn('size-3 text-pk', !lite && 'drop-shadow-[0_0_6px_rgb(251_191_36/0.7)]')} />
                    ) : isFk ? (
                      <Link2 className={cn('size-3 text-fk', !lite && 'drop-shadow-[0_0_6px_rgb(34_211_238/0.7)]')} />
                    ) : c.isIdentity ? (
                      <Fingerprint className="size-3 text-white/30" />
                    ) : (
                      <span className="size-1 rounded-full bg-white/20" />
                    )}
                  </button>
                  {edit?.col === c.name && edit.field === 'name' ? (
                    <InlineInput value={c.name} onCommit={(v) => (d.renameColumn(id, c.name, v), setEdit(null))} onCancel={() => setEdit(null)} className="flex-1 text-[11.5px]" />
                  ) : (
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate',
                        c.isPrimaryKey ? 'font-semibold text-amber-100' : isFk ? 'text-cyan-100' : 'text-white/80',
                        active && 'text-cyan-200',
                        colDeleted && 'line-through',
                        editable && !colDeleted && 'cursor-text',
                      )}
                      onDoubleClick={(e) => {
                        if (!editable || colDeleted) return;
                        e.stopPropagation();
                        setEdit({ col: c.name, field: 'name' });
                      }}
                    >
                      {c.name}
                    </span>
                  )}
                  {colWorst && (
                    <span title={cp.map((p) => p.title).join('\n')} className={cn('shrink-0', colWorst === 'error' && 'animate-pulse')} style={{ color: SEV_COLOR[colWorst] }}>
                      <SevIcon s={colWorst} className="size-3" />
                    </span>
                  )}
                  {edit?.col === c.name && edit.field === 'type' ? (
                    <InlineInput value={c.type} list={d.typesListId} onCommit={(v) => (d.setType(id, c.name, v), setEdit(null))} onCancel={() => setEdit(null)} className="w-24 text-[10.5px]" />
                  ) : (
                    <span
                      className={cn('max-w-[96px] shrink-0 truncate text-[10.5px] text-white/35', editable && !colDeleted && 'cursor-text hover:text-cyan-200', editable && 'group-hover/col:hidden')}
                      onDoubleClick={(e) => {
                        if (!editable || colDeleted) return;
                        e.stopPropagation();
                        setEdit({ col: c.name, field: 'type' });
                      }}
                    >
                      {c.type.toLowerCase()}
                      {!c.nullable && !c.isPrimaryKey && <span className="text-rose-300/60"> *</span>}
                    </span>
                  )}
                  {/* Row actions in edit mode */}
                  {editable && edit?.col !== c.name && (
                    <span className="nodrag hidden shrink-0 items-center gap-0.5 group-hover/col:flex">
                      {!colDeleted && (
                        <>
                          <button
                            className="rounded px-1 text-[10px] text-white/60 hover:bg-white/10 hover:text-white"
                            title="Change type"
                            onClick={(e) => (e.stopPropagation(), setEdit({ col: c.name, field: 'type' }))}
                          >
                            {c.type.toLowerCase().slice(0, 10)}
                          </button>
                          {!c.isPrimaryKey && (
                            <button
                              className={cn('rounded px-1 text-[10px] hover:bg-white/10', c.nullable ? 'text-white/50' : 'text-rose-300')}
                              title={c.nullable ? 'Make NOT NULL' : 'Allow NULL'}
                              onClick={(e) => (e.stopPropagation(), d.toggleNullable(id, c.name))}
                            >
                              {c.nullable ? 'null' : 'not null'}
                            </button>
                          )}
                        </>
                      )}
                      <button
                        className="flex size-5 items-center justify-center rounded text-white/60 hover:bg-white/10 hover:text-white"
                        title={colDeleted ? 'Keep column' : 'Drop column'}
                        aria-label={colDeleted ? 'Keep column' : 'Drop column'}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (colDeleted) d.restoreColumn(id, c.name);
                          else d.dropColumn(id, c.name);
                        }}
                      >
                        {colDeleted ? <RotateCcw className="size-3" /> : <Trash2 className="size-3" />}
                      </button>
                    </span>
                  )}
                  {i < columns.length - 1 && <span className="absolute right-3 bottom-0 left-3 h-px bg-white/[0.04]" />}
                </motion.div>
              );
            })}
          </AnimatePresence>
          {hidden > 0 && (
            <div className="flex h-6 items-center px-3 text-[10.5px] text-white/35">+{hidden} more column{hidden > 1 ? 's' : ''}</div>
          )}
          {editable && (
            <button
              className="nodrag mx-2 mt-1 mb-0.5 flex h-6 w-[calc(100%-16px)] items-center justify-center gap-1 rounded-md border border-dashed border-white/15 text-[11px] text-white/50 transition-colors hover:border-emerald-300/50 hover:bg-emerald-400/10 hover:text-emerald-200"
              onClick={(e) => (e.stopPropagation(), d.addColumn(id))}
            >
              <Plus className="size-3" /> Add column
            </button>
          )}
        </div>

        {isDeleted && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-rose-950/30">
            <span className="rounded-md bg-rose-500/80 px-2 py-0.5 text-[11px] font-bold tracking-wide text-white shadow-[0_0_20px_rgb(251_113_133/0.8)]">WILL BE DROPPED</span>
          </div>
        )}
        {apply?.state === 'running' && <div className="skeleton pointer-events-none absolute inset-0 opacity-30" />}
        {lit && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: [0.35, 0.7, 0.35] }}
            transition={{ duration: 2.2, repeat: Infinity }}
            className="pointer-events-none absolute inset-x-0 top-0 h-px"
            style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }}
          />
        )}
      </motion.div>

      {/* Apply result bubble */}
      <AnimatePresence>
        {apply?.state === 'failed' && apply.error && (
          <motion.div
            key={`err-${apply.tick}`}
            initial={{ opacity: 0, y: -6, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={spring}
            className="absolute top-full right-0 left-0 z-20 mt-2 rounded-lg border border-rose-400/50 bg-[#2a0d16]/95 p-2 font-mono text-[10.5px] leading-snug text-rose-100 shadow-[0_0_24px_-4px_rgb(251_113_133/0.8)]"
          >
            <span className="absolute -top-1.5 left-6 size-3 rotate-45 border-t border-l border-rose-400/50 bg-[#2a0d16]" />
            {apply.error}
          </motion.div>
        )}
        {apply?.state === 'done' && (
          <motion.div
            key={`ok-${apply.tick}`}
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: [0, 1, 1, 0], scale: [0.4, 1.15, 1, 1] }}
            transition={{ duration: 1.6, times: [0, 0.2, 0.7, 1] }}
            className="pointer-events-none absolute -top-3 -left-3 z-20 text-emerald-300 drop-shadow-[0_0_10px_rgb(52_211_153)]"
          >
            <CheckCircle2 className="size-6" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export const TableNode = memo(TableNodeImpl);
