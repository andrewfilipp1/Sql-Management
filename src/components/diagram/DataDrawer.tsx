import { motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Crosshair,
  ExternalLink,
  Eye,
  Key,
  Link2,
  RefreshCw,
  Rows3,
  Table2,
  Wrench,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RowsResponse, SchemaSnapshot, TableInfo, TableRef } from '../../../shared/types';
import { api } from '../../lib/api';
import { formatMs, formatNumber, nodeId, relationsOf, sameTable } from '../../lib/utils';
import { DataGrid } from '../DataGrid';
import { Badge, Button, IconButton, Segmented, Spinner, softSpring, spring } from '../ui';
import { fkColumnSet } from './layout';
import type { Problem } from '../../lib/lint';

type View = 'data' | 'columns' | 'relations' | 'problems';
const PAGE = 50;

interface Props {
  connId: string;
  database: string;
  schema: SchemaSnapshot;
  table: TableInfo;
  hue: number;
  onClose: () => void;
  onSelect: (t: TableRef) => void;
  onFocus: () => void;
  onOpen: () => void;
  problems?: Problem[];
  onFix?: (p: Problem) => void;
}

export function DataDrawer({ connId, database, schema, table, hue, onClose, onSelect, onFocus, onOpen, problems = [], onFix }: Props) {
  const [view, setView] = useState<View>('data');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<RowsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ref = useMemo(() => ({ schema: table.schema, name: table.name }), [table.schema, table.name]);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.rows(connId, database, { table: ref, offset: page * PAGE, limit: PAGE }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [connId, database, ref, page]);

  useEffect(() => setPage(0), [ref]);
  useEffect(() => {
    if (view === 'problems' && !problems.length) setView('data');
  }, [problems.length, view]);
  useEffect(() => {
    void load();
  }, [load]);

  const rels = useMemo(() => relationsOf(schema), [schema]);
  const outgoing = rels.filter((r) => sameTable(r.from, table));
  const incoming = rels.filter((r) => sameTable(r.to, table) && !sameTable(r.from, table));
  const fks = fkColumnSet(table);
  const total = data?.total ?? null;
  const pages = total != null ? Math.max(1, Math.ceil(total / PAGE)) : null;
  const accent = `hsl(${hue} 85% 66%)`;

  return (
    <motion.aside
      initial={{ x: '105%', opacity: 0.4 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: '105%', opacity: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 28, mass: 0.9 }}
      className="glass-strong absolute top-3 right-3 bottom-3 z-20 !bg-[#0a0d1c]/95 flex w-[min(620px,calc(100%-24px))] flex-col overflow-hidden rounded-2xl shadow-[var(--shadow)]"
      style={{ boxShadow: `0 0 0 1px hsl(${hue} 85% 66% / 0.35), 0 0 60px -20px hsl(${hue} 85% 60% / 0.6), var(--shadow)` }}
    >
      {/* Header */}
      <div
        className="relative px-4 pt-4 pb-3"
        style={{ background: `linear-gradient(135deg, hsl(${hue} 80% 58% / 0.22), transparent 70%)` }}
      >
        <div className="flex items-start gap-3">
          <motion.span
            key={nodeId(table)}
            initial={{ scale: 0.6, rotate: -20, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={spring}
            className="flex size-10 shrink-0 items-center justify-center rounded-xl"
            style={{ background: `hsl(${hue} 80% 60% / 0.18)`, color: accent, boxShadow: `0 0 22px -4px hsl(${hue} 85% 60% / 0.8)` }}
          >
            {table.type === 'view' ? <Eye className="size-5" /> : <Table2 className="size-5" />}
          </motion.span>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-muted">
              {table.schema ? `${table.schema} · ` : ''}
              {table.type === 'view' ? 'View' : 'Table'}
            </div>
            <motion.h3
              key={table.name}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={softSpring}
              className="truncate text-lg font-semibold"
            >
              {table.name}
            </motion.h3>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Badge>{table.columns.length} columns</Badge>
              {table.rowCount != null && <Badge tone="accent">{formatNumber(table.rowCount)} rows</Badge>}
              {table.primaryKey.length > 0 && <Badge tone="pk">PK {table.primaryKey.join(', ')}</Badge>}
              {outgoing.length + incoming.length > 0 && <Badge tone="fk">{outgoing.length + incoming.length} relations</Badge>}
            </div>
          </div>
          <IconButton label="Close (Esc)" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Segmented
            layoutId="drawer-view"
            value={view}
            onChange={setView}
            options={[
              { value: 'data', label: 'Data', icon: <Rows3 className="size-3.5" /> },
              { value: 'columns', label: 'Columns', icon: <Columns3 className="size-3.5" /> },
              { value: 'relations', label: 'Relations', icon: <ArrowLeftRight className="size-3.5" /> },
              ...(problems.length
                ? [
                    {
                      value: 'problems' as View,
                      label: `${problems.length}`,
                      icon: <AlertTriangle className={problems.some((p) => p.severity === 'error') ? 'size-3.5 text-danger' : 'size-3.5 text-warn'} />,
                    },
                  ]
                : []),
            ]}
          />
          <div className="flex-1" />
          <Button size="sm" variant="ghost" icon={<Crosshair className="size-3.5" />} onClick={onFocus}>
            Focus
          </Button>
          <Button size="sm" variant="primary" icon={<ExternalLink className="size-3.5" />} onClick={onOpen}>
            Open
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="relative min-h-0 flex-1 border-t border-line">
        {view === 'data' && (
          <div className="flex h-full flex-col">
            <div className="relative min-h-0 flex-1">
              {error ? (
                <div className="p-4 font-mono text-xs text-danger">{error}</div>
              ) : data ? (
                <motion.div key={`${nodeId(table)}:${page}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full">
                  <DataGrid
                    columns={data.columns}
                    rowCount={data.rows.length}
                    getValue={(r, c) => data.rows[r][c]}
                    rowOffset={page * PAGE}
                    meta={(c) => {
                      const col = table.columns.find((x) => x.name === data.columns[c]);
                      return { pk: col?.isPrimaryKey, fk: fks.has(data.columns[c]) };
                    }}
                  />
                </motion.div>
              ) : null}
              {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
                  <Spinner />
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 border-t border-line px-3 py-2 text-xs text-muted">
              <IconButton label="Reload" onClick={() => void load()}>
                <RefreshCw className="size-3.5" />
              </IconButton>
              <span>
                {data && data.rows.length
                  ? `${formatNumber(page * PAGE + 1)}–${formatNumber(page * PAGE + data.rows.length)}`
                  : '0'}{' '}
                of {formatNumber(total)}
              </span>
              {data && <span className="text-faint">· {formatMs(data.durationMs)}</span>}
              <div className="flex-1" />
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
        )}

        {view === 'columns' && (
          <div className="h-full overflow-auto p-3">
            {table.columns.map((c, i) => (
              <motion.div
                key={c.name}
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ ...softSpring, delay: Math.min(i * 0.02, 0.4) }}
                className="flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-white/4"
              >
                <span className="flex w-4 justify-center">
                  {c.isPrimaryKey ? <Key className="size-3.5 text-pk" /> : fks.has(c.name) ? <Link2 className="size-3.5 text-fk" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{c.name}</span>
                <span className="font-mono text-[11px] text-accent">{c.type}</span>
                <span className="w-16 text-right text-[11px] text-faint">{c.nullable ? 'null' : 'not null'}</span>
                {c.default != null && (
                  <span className="max-w-[120px] truncate font-mono text-[11px] text-muted" title={c.default}>
                    = {c.default}
                  </span>
                )}
              </motion.div>
            ))}
          </div>
        )}

        {view === 'problems' && (
          <div className="h-full space-y-2 overflow-auto p-4">
            {problems.map((p, i) => (
              <motion.div
                key={p.id}
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ ...softSpring, delay: i * 0.04 }}
                className={`glass flex items-start gap-3 rounded-xl px-3 py-2.5 ${p.severity === 'error' ? 'border-rose-400/40' : p.severity === 'warning' ? 'border-amber-400/30' : ''}`}
              >
                <AlertTriangle className={`mt-0.5 size-4 shrink-0 ${p.severity === 'error' ? 'text-danger' : p.severity === 'warning' ? 'text-warn' : 'text-sky-300'}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">{p.title}</div>
                  {p.detail && <div className="mt-0.5 text-[12px] text-muted">{p.detail}</div>}
                </div>
                {p.fix && onFix && (
                  <Button size="sm" icon={<Wrench className="size-3" />} onClick={() => onFix(p)}>
                    {p.fix.label}
                  </Button>
                )}
              </motion.div>
            ))}
          </div>
        )}

        {view === 'relations' && (
          <div className="h-full space-y-4 overflow-auto p-4">
            <RelationList title="References (outgoing)" empty="This table does not reference others.">
              {outgoing.map((r) => (
                <RelationRow key={r.id} onClick={() => onSelect(r.to)} target={r.to.name} detail={`${r.fromColumns.join(', ')} → ${r.toColumns.join(', ')}`} action={r.onDelete} />
              ))}
            </RelationList>
            <RelationList title="Referenced by (incoming)" empty="No table references this one.">
              {incoming.map((r) => (
                <RelationRow key={r.id} onClick={() => onSelect(r.from)} target={r.from.name} detail={`${r.from.name}.${r.fromColumns.join(', ')}`} action={r.onDelete} />
              ))}
            </RelationList>
          </div>
        )}
      </div>
    </motion.aside>
  );
}

function RelationList({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">{title}</div>
      {children.length ? <div className="space-y-1.5">{children}</div> : <div className="text-xs text-faint">{empty}</div>}
    </div>
  );
}

function RelationRow({ target, detail, action, onClick }: { target: string; detail: string; action?: string; onClick: () => void }) {
  return (
    <motion.button
      whileHover={{ scale: 1.015, x: 2 }}
      transition={spring}
      onClick={onClick}
      className="glass flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:border-cyan-300/30 hover:shadow-[0_0_20px_-6px_rgb(34_211_238/0.6)]"
    >
      <Link2 className="size-4 shrink-0 text-fk" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{target}</div>
        <div className="truncate font-mono text-[11px] text-muted">{detail}</div>
      </div>
      {action && action !== 'NO ACTION' && <Badge tone="warn">ON DELETE {action}</Badge>}
      <ChevronRight className="size-4 text-faint" />
    </motion.button>
  );
}
