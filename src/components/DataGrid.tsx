import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Copy, Edit3, Key, Link2, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { cn } from '../lib/utils';
import { useContextMenu } from './ui';

export interface ColumnMeta {
  pk?: boolean;
  fk?: boolean;
  type?: string;
}

export type RowState = 'new' | 'deleted' | undefined;

interface Props {
  columns: string[];
  rowCount: number;
  getValue: (row: number, col: number) => unknown;
  meta?: (col: number) => ColumnMeta;
  rowState?: (row: number) => RowState;
  isEdited?: (row: number, col: number) => boolean;
  editable?: boolean;
  onEdit?: (row: number, col: number, value: unknown) => void;
  onDeleteRows?: (rows: number[]) => void;
  sort?: { column: string; dir: 'asc' | 'desc' } | null;
  onSort?: (column: string) => void;
  selected?: Set<number>;
  onSelectedChange?: (s: Set<number>) => void;
  rowOffset?: number;
}

const ROW_H = 30;
const NUM_W = 56;

function display(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function estimateWidth(name: string, sample: unknown[]): number {
  let max = name.length + 4;
  for (const v of sample) max = Math.max(max, Math.min(display(v).length, 48));
  return Math.max(80, Math.min(380, max * 7.4 + 24));
}

export function DataGrid({
  columns,
  rowCount,
  getValue,
  meta,
  rowState,
  isEdited,
  editable,
  onEdit,
  onDeleteRows,
  sort,
  onSort,
  selected,
  onSelectedChange,
  rowOffset = 0,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<number[]>([]);
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null);
  const openMenu = useContextMenu();

  // Size columns from the header and the first rows whenever the column set changes.
  const colKey = columns.join('\u0000');
  useEffect(() => {
    const sample = Math.min(rowCount, 60);
    setWidths(
      columns.map((c, ci) =>
        estimateWidth(
          // header shows name, type and a key icon
          c + (meta?.(ci)?.type ? ' ' + meta(ci).type : '') + (meta?.(ci)?.pk || meta?.(ci)?.fk ? '  ' : ''),
          Array.from({ length: sample }, (_, r) => getValue(r, ci)),
        ),
      ),
    );
    setActive(null);
    setEditing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colKey]);

  const template = useMemo(
    () => `${NUM_W}px ${columns.map((_, i) => `${widths[i] ?? 140}px`).join(' ')}`,
    [columns, widths],
  );
  const totalWidth = NUM_W + columns.reduce((a, _, i) => a + (widths[i] ?? 140), 0);

  const virt = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  const startResize = (ci: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widths[ci] ?? 140;
    const move = (ev: MouseEvent) =>
      setWidths((ws) => ws.map((w, i) => (i === ci ? Math.max(48, w0 + ev.clientX - x0) : w)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const copy = (text: string) => void navigator.clipboard.writeText(text);

  const commitEdit = () => {
    if (!editing) return;
    onEdit?.(editing.r, editing.c, editing.value);
    setEditing(null);
  };

  const toggleRow = (r: number, additive: boolean) => {
    if (!onSelectedChange) return;
    const next = new Set(additive ? selected : []);
    if (next.has(r) && additive) next.delete(r);
    else next.add(r);
    onSelectedChange(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing || !active) return;
    const { r, c } = active;
    const move = (dr: number, dc: number) => {
      const nr = Math.max(0, Math.min(rowCount - 1, r + dr));
      const nc = Math.max(0, Math.min(columns.length - 1, c + dc));
      setActive({ r: nr, c: nc });
      virt.scrollToIndex(nr);
      e.preventDefault();
    };
    if (e.key === 'ArrowDown') move(1, 0);
    else if (e.key === 'ArrowUp') move(-1, 0);
    else if (e.key === 'ArrowLeft') move(0, -1);
    else if (e.key === 'ArrowRight' || e.key === 'Tab') move(0, 1);
    else if ((e.metaKey || e.ctrlKey) && e.key === 'c') copy(display(getValue(r, c)));
    else if (e.key === 'Enter' && editable && rowState?.(r) !== 'deleted') {
      const v = getValue(r, c);
      setEditing({ r, c, value: v == null ? '' : display(v) });
      e.preventDefault();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && editable && selected?.size) {
      onDeleteRows?.([...selected]);
    }
  };

  const cellMenu = (e: React.MouseEvent, r: number, c: number) => {
    e.preventDefault();
    setActive({ r, c });
    const v = getValue(r, c);
    openMenu(e, [
      { label: 'Copy value', icon: <Copy className="size-3.5" />, onClick: () => copy(display(v)), hint: '⌘C' },
      {
        label: 'Copy row as JSON',
        icon: <Copy className="size-3.5" />,
        onClick: () => copy(JSON.stringify(Object.fromEntries(columns.map((col, i) => [col, getValue(r, i)])), null, 2)),
      },
      ...(editable
        ? [
            { separator: true },
            {
              label: 'Edit cell',
              icon: <Edit3 className="size-3.5" />,
              onClick: () => setEditing({ r, c, value: v == null ? '' : display(v) }),
              hint: 'Enter',
            },
            { label: 'Set NULL', icon: <X className="size-3.5" />, onClick: () => onEdit?.(r, c, null) },
            {
              label: selected?.has(r) && selected.size > 1 ? `Delete ${selected.size} rows` : 'Delete row',
              icon: <Trash2 className="size-3.5" />,
              danger: true,
              onClick: () => onDeleteRows?.(selected?.has(r) ? [...selected] : [r]),
            },
          ]
        : []),
    ]);
  };

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative h-full overflow-auto font-mono text-[12.5px] outline-none"
    >
      <div style={{ width: totalWidth, minWidth: '100%' }}>
        {/* Header */}
        <div
          className="sticky top-0 z-10 grid border-b border-line-strong bg-[#0f1326]/95 backdrop-blur-md"
          style={{ gridTemplateColumns: template, height: ROW_H + 4 }}
        >
          <div className="flex items-center justify-center text-[10.5px] text-faint">#</div>
          {columns.map((c, ci) => {
            const m = meta?.(ci);
            const sorted = sort?.column === c ? sort.dir : null;
            return (
              <div
                key={ci}
                onClick={() => onSort?.(c)}
                title={m?.type ? `${c} — ${m.type}` : c}
                className={cn(
                  'group relative flex items-center gap-1.5 border-l border-line px-2.5 font-sans text-xs font-semibold text-fg select-none',
                  onSort && 'cursor-pointer hover:bg-white/4',
                )}
              >
                {m?.pk && <Key className="size-3 shrink-0 text-pk" />}
                {m?.fk && <Link2 className="size-3 shrink-0 text-fk" />}
                <span className="truncate">{c}</span>
                {m?.type && <span className="truncate font-mono text-[10px] font-normal text-faint">{m.type}</span>}
                {sorted === 'asc' && <ArrowUp className="ml-auto size-3 shrink-0 text-accent" />}
                {sorted === 'desc' && <ArrowDown className="ml-auto size-3 shrink-0 text-accent" />}
                <span
                  onMouseDown={(e) => startResize(ci, e)}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize hover:bg-accent/40"
                />
              </div>
            );
          })}
        </div>

        {/* Body */}
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((vr) => {
            const r = vr.index;
            const state = rowState?.(r);
            const isSel = selected?.has(r);
            const style: CSSProperties = {
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: ROW_H,
              transform: `translateY(${vr.start}px)`,
              gridTemplateColumns: template,
            };
            return (
              <div
                key={r}
                style={style}
                className={cn(
                  'grid border-b border-line/70 transition-colors',
                  r % 2 ? 'bg-white/[0.015]' : '',
                  isSel && 'bg-accent-soft',
                  state === 'new' && 'bg-emerald-400/8',
                  state === 'deleted' && 'bg-rose-500/10 line-through opacity-60',
                  !isSel && !state && 'hover:bg-white/[0.035]',
                )}
              >
                <div
                  onClick={(e) => toggleRow(r, e.metaKey || e.ctrlKey || e.shiftKey)}
                  className={cn(
                    'flex cursor-pointer items-center justify-end pr-2.5 text-[11px] select-none',
                    isSel ? 'text-accent' : 'text-faint hover:text-muted',
                  )}
                >
                  {state === 'new' ? <span className="text-ok">+</span> : r + 1 + rowOffset}
                </div>
                {columns.map((_, c) => {
                  const v = getValue(r, c);
                  const isActive = active?.r === r && active?.c === c;
                  const isEditing = editing?.r === r && editing?.c === c;
                  const edited = isEdited?.(r, c);
                  const isNum = typeof v === 'number';
                  return (
                    <div
                      key={c}
                      onMouseDown={() => setActive({ r, c })}
                      onDoubleClick={() =>
                        editable && state !== 'deleted' && setEditing({ r, c, value: v == null ? '' : display(v) })
                      }
                      onContextMenu={(e) => cellMenu(e, r, c)}
                      className={cn(
                        'relative flex items-center overflow-hidden border-l border-line/60 px-2.5',
                        isNum && 'justify-end',
                        edited && 'bg-amber-400/12',
                        isActive && 'ring-1 ring-accent/70 ring-inset',
                      )}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={editing.value}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') commitEdit();
                            if (e.key === 'Escape') setEditing(null);
                          }}
                          className="absolute inset-0 bg-[#141a35] px-2.5 text-fg shadow-[0_0_0_2px_rgb(129_140_248/0.8),0_0_18px_rgb(129_140_248/0.5)] outline-none"
                        />
                      ) : v === undefined ? (
                        <span className="text-faint/70 italic">default</span>
                      ) : v === null ? (
                        <span className="text-faint italic">NULL</span>
                      ) : (
                        <span className={cn('truncate', isNum ? 'text-amber-200/90' : 'text-fg/90')}>{display(v)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
