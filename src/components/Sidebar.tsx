import { AnimatePresence, motion } from 'motion/react';
import {
  Cable,
  ChevronRight,
  Database,
  Eye,
  FunctionSquare,
  Key,
  LayoutDashboard,
  Link2,
  Lock,
  MoreHorizontal,
  Pencil,
  Play,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Table2,
  TerminalSquare,
  Trash2,
  Unplug,
  Waypoints,
  Sparkles,
  NotebookPen,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PublicConnection, TableInfo } from '../../shared/types';
import { KIND_LABEL } from '../../shared/types';
import { databaseToolsMenu, notebooksMenu, openDashboard, openDiagram, openRoutine, openTable, refreshSchema, tableMenu } from '../lib/actions';
import { platform } from '../lib/api';
import { useSchema, useStore } from '../lib/store';
import { cn, compactNumber, dbKey } from '../lib/utils';
import { DbIcon } from './DbIcon';
import { Badge, IconButton, Input, Spinner, spring, useContextMenu } from './ui';

function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 36 }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Row({
  depth,
  open,
  onToggle,
  onClick,
  onContextMenu,
  icon,
  label,
  meta,
  actions,
  active,
  hasChildren = true,
  title,
}: {
  depth: number;
  open?: boolean;
  onToggle?: () => void;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  icon: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  active?: boolean;
  hasChildren?: boolean;
  title?: string;
}) {
  return (
    <div
      title={title}
      onClick={onClick ?? onToggle}
      onContextMenu={onContextMenu}
      className={cn(
        'group relative flex h-7 cursor-pointer items-center gap-1.5 rounded-lg pr-1.5 text-[13px] transition-colors select-none',
        active ? 'bg-accent-soft text-fg' : 'text-fg/85 hover:bg-white/[0.045]',
      )}
      style={{ paddingLeft: 6 + depth * 14 }}
    >
      <span
        onClick={(e) => {
          if (onToggle && onClick) {
            e.stopPropagation();
            onToggle();
          }
        }}
        className={cn('flex size-4 shrink-0 items-center justify-center text-faint', !hasChildren && 'invisible')}
      >
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring} className="flex">
          <ChevronRight className="size-3.5" />
        </motion.span>
      </span>
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta && <span className="shrink-0 font-mono text-[10.5px] text-faint group-hover:hidden">{meta}</span>}
      {actions && <span className="hidden shrink-0 items-center group-hover:flex">{actions}</span>}
    </div>
  );
}

function TableRow({ connId, database, kind, t, depth, filter }: { connId: string; database: string; kind: PublicConnection['kind']; t: TableInfo; depth: number; filter: string }) {
  const key = `${dbKey(connId, database)}::t::${t.schema ?? ''}.${t.name}`;
  const open = useStore((s) => !!s.expanded[key]);
  const toggle = useStore((s) => s.toggle);
  const activeTab = useStore((s) => s.tabs.find((x) => x.id === s.activeTabId));
  const openMenu = useContextMenu();
  const fks = new Set(t.foreignKeys.flatMap((f) => f.columns));
  const isActive = activeTab?.kind === 'table' && activeTab.connId === connId && activeTab.database === database && activeTab.table?.name === t.name && (activeTab.table?.schema ?? '') === (t.schema ?? '');

  return (
    <>
      <Row
        depth={depth}
        open={open}
        onToggle={() => toggle(key)}
        onClick={() => openTable(connId, database, t)}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e, tableMenu(connId, database, kind, t));
        }}
        active={isActive}
        icon={t.type === 'view' ? <Eye className="size-3.5 text-violet-300" /> : <Table2 className="size-3.5 text-indigo-300" />}
        label={
          <>
            {t.schema && <span className="text-faint">{t.schema}.</span>}
            <Highlight text={t.name} q={filter} />
          </>
        }
        meta={t.rowCount != null ? compactNumber(t.rowCount) : undefined}
        actions={
          <IconButton
            label="More"
            className="size-5"
            onClick={(e) => {
              e.stopPropagation();
              openMenu(e, tableMenu(connId, database, kind, t));
            }}
          >
            <MoreHorizontal className="size-3.5" />
          </IconButton>
        }
      />
      <Collapse open={open}>
        {t.columns.map((c) => (
          <Row
            key={c.name}
            depth={depth + 1}
            hasChildren={false}
            icon={
              c.isPrimaryKey ? (
                <Key className="size-3 text-pk" />
              ) : fks.has(c.name) ? (
                <Link2 className="size-3 text-fk" />
              ) : (
                <span className="size-1 rounded-full bg-white/25" />
              )
            }
            label={<span className="font-mono text-[12px]">{c.name}</span>}
            meta={<span className="lowercase">{c.type}</span>}
            title={`${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`}
          />
        ))}
      </Collapse>
    </>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded bg-cyan-400/25 text-cyan-100">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function DatabaseNode({ conn, database, depth, filter }: { conn: PublicConnection; database: string; depth: number; filter: string }) {
  const key = dbKey(conn.id, database);
  const open = useStore((s) => !!s.expanded[key]);
  const expanded = useStore((s) => s.expanded);
  const toggle = useStore((s) => s.toggle);
  const ensureSchema = useStore((s) => s.ensureSchema);
  const newQuery = useStore((s) => s.newQuery);
  const openDesigner = useStore((s) => s.openDesigner);
  const schema = useSchema(conn.id, database);
  const openMenu = useContextMenu();

  useEffect(() => {
    if (open) ensureSchema(conn.id, database);
  }, [open, conn.id, database, ensureSchema]);

  const q = filter.trim().toLowerCase();
  const tables = useMemo(
    () => (schema?.data?.tables ?? []).filter((t) => !q || t.name.toLowerCase().includes(q)),
    [schema?.data, q],
  );
  const routines = (schema?.data?.routines ?? []).filter((r) => !q || r.name.toLowerCase().includes(q));
  const base = tables.filter((t) => t.type === 'table');
  const views = tables.filter((t) => t.type === 'view');
  const group = (g: string) => `${key}::g::${g}`;
  const groupOpen = (g: string) => (q ? true : expanded[group(g)] ?? g === 'tables');

  const actions = (
    <>
      <IconButton label="Diagram" className="size-5" onClick={(e) => (e.stopPropagation(), openDiagram(conn.id, database))}>
        <Waypoints className="size-3.5" />
      </IconButton>
      <IconButton label="New query" className="size-5" onClick={(e) => (e.stopPropagation(), newQuery(conn.id, database))}>
        <TerminalSquare className="size-3.5" />
      </IconButton>
    </>
  );

  return (
    <>
      <Row
        depth={depth}
        open={open}
        onToggle={() => toggle(key)}
        icon={<Database className="size-3.5 text-cyan-300" />}
        label={database}
        actions={actions}
        meta={schema?.status === 'loading' ? <Spinner className="size-3" /> : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e, [
            { label: 'Schema diagram', icon: <Waypoints className="size-3.5" />, onClick: () => openDiagram(conn.id, database) },
            { label: 'Overview', icon: <LayoutDashboard className="size-3.5" />, onClick: () => openDashboard(conn.id, database) },
            { label: 'New query', icon: <TerminalSquare className="size-3.5" />, onClick: () => newQuery(conn.id, database) },
            { label: 'Create table…', icon: <Plus className="size-3.5" />, onClick: () => openDesigner({ connId: conn.id, database }) },
            { separator: true },
            ...databaseToolsMenu(conn.id, database, conn.kind),
            { separator: true },
            { label: 'Refresh', icon: <RefreshCw className="size-3.5" />, onClick: () => void refreshSchema(conn.id, database) },
          ]);
        }}
      />
      <Collapse open={open}>
        {schema?.status === 'error' && <div className="px-6 py-1 text-xs text-danger">{schema.error}</div>}
        {schema?.data && (
          <>
            <div className="flex gap-1 py-1" style={{ paddingLeft: 6 + (depth + 1) * 14 + 20 }}>
              <QuickChip icon={<Waypoints className="size-3" />} label="Diagram" onClick={() => openDiagram(conn.id, database)} />
              <QuickChip icon={<LayoutDashboard className="size-3" />} label="Overview" onClick={() => openDashboard(conn.id, database)} />
              <QuickChip icon={<Play className="size-3" />} label="Query" onClick={() => newQuery(conn.id, database)} />
            </div>
            <Row
              depth={depth + 1}
              open={groupOpen('tables')}
              onToggle={() => toggle(group('tables'), !groupOpen('tables'))}
              icon={<Table2 className="size-3.5 text-muted" />}
              label="Tables"
              meta={base.length}
              actions={
                <IconButton label="Create table" className="size-5" onClick={(e) => (e.stopPropagation(), openDesigner({ connId: conn.id, database }))}>
                  <Plus className="size-3.5" />
                </IconButton>
              }
            />
            <Collapse open={groupOpen('tables')}>
              {base.map((t) => (
                <TableRow key={`${t.schema}.${t.name}`} connId={conn.id} database={database} kind={conn.kind} t={t} depth={depth + 2} filter={q} />
              ))}
            </Collapse>
            {views.length > 0 && (
              <>
                <Row depth={depth + 1} open={groupOpen('views')} onToggle={() => toggle(group('views'), !groupOpen('views'))} icon={<Eye className="size-3.5 text-muted" />} label="Views" meta={views.length} />
                <Collapse open={groupOpen('views')}>
                  {views.map((t) => (
                    <TableRow key={`${t.schema}.${t.name}`} connId={conn.id} database={database} kind={conn.kind} t={t} depth={depth + 2} filter={q} />
                  ))}
                </Collapse>
              </>
            )}
            {routines.length > 0 && (
              <>
                <Row depth={depth + 1} open={groupOpen('routines')} onToggle={() => toggle(group('routines'), !groupOpen('routines'))} icon={<FunctionSquare className="size-3.5 text-muted" />} label="Routines" meta={routines.length} />
                <Collapse open={groupOpen('routines')}>
                  {routines.map((r) => (
                    <Row
                      key={`${r.schema}.${r.name}.${r.type}`}
                      depth={depth + 2}
                      hasChildren={false}
                      onClick={() => void openRoutine(conn.id, database, r)}
                      icon={<FunctionSquare className={cn('size-3.5', r.type === 'procedure' ? 'text-amber-300' : 'text-pink-300')} />}
                      label={
                        <>
                          {r.schema && <span className="text-faint">{r.schema}.</span>}
                          {r.name}
                        </>
                      }
                      meta={r.type === 'procedure' ? 'proc' : 'fn'}
                    />
                  ))}
                </Collapse>
              </>
            )}
          </>
        )}
        {schema?.status === 'loading' && !schema.data && (
          <div className="space-y-1.5 py-1.5" style={{ paddingLeft: 6 + (depth + 1) * 14 + 20 }}>
            {[70, 55, 80].map((w) => (
              <div key={w} className="skeleton h-3.5" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
      </Collapse>
    </>
  );
}

function QuickChip({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <motion.button
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      transition={spring}
      onClick={onClick}
      className="flex h-5 items-center gap-1 rounded-md border border-line bg-white/[0.03] px-1.5 text-[10.5px] text-muted hover:border-accent/40 hover:text-fg hover:shadow-[0_0_12px_-4px_rgb(129_140_248/0.7)]"
    >
      {icon}
      {label}
    </motion.button>
  );
}

function ConnectionNode({ conn, filter }: { conn: PublicConnection; filter: string }) {
  const session = useStore((s) => s.sessions[conn.id]);
  const open = useStore((s) => !!s.expanded[conn.id]);
  const { toggle, connect, disconnect, openConnectionDialog, deleteConnection, newQuery, toast } = useStore.getState();
  const openMenu = useContextMenu();
  const connected = session?.status === 'connected';
  const color = conn.color ?? '#818cf8';

  const onClick = async () => {
    if (!connected) {
      const s = await connect(conn.id);
      if (s) toggle(conn.id, true);
    } else toggle(conn.id);
  };

  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e, [
      connected
        ? { label: 'Disconnect', icon: <Unplug className="size-3.5" />, onClick: () => void disconnect(conn.id) }
        : { label: 'Connect', icon: <Plug className="size-3.5" />, onClick: () => void onClick() },
      {
        label: 'New query',
        icon: <TerminalSquare className="size-3.5" />,
        disabled: !connected,
        onClick: () => newQuery(conn.id, session!.defaultDatabase),
      },
      { label: 'Edit connection…', icon: <Pencil className="size-3.5" />, onClick: () => openConnectionDialog(conn) },
      { separator: true },
      {
        label: 'Remove connection',
        icon: <Trash2 className="size-3.5" />,
        danger: true,
        onClick: () => void deleteConnection(conn.id).then(() => toast(`Removed “${conn.name}”`)),
      },
    ]);
  };

  const dbs = session?.databases ?? [];

  return (
    <div className="mb-1">
      <div
        onClick={() => void onClick()}
        onContextMenu={menu}
        className={cn(
          'group flex cursor-pointer items-center gap-2.5 rounded-xl border px-2 py-1.5 transition-all duration-200',
          connected ? 'border-line bg-white/[0.03]' : 'border-transparent hover:border-line hover:bg-white/[0.03]',
          conn.environment === 'production' && '!border-rose-400/40 shadow-[0_0_16px_-6px_rgb(251_113_133/0.7)]',
        )}
      >
        <div className="relative">
          <DbIcon kind={conn.kind} color={color} />
          <span
            className={cn(
              'absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-[#0d1020]',
              session?.status === 'connected' && 'bg-emerald-400 shadow-[0_0_8px_rgb(52_211_153/0.9)]',
              session?.status === 'connecting' && 'animate-pulse bg-amber-400',
              session?.status === 'error' && 'bg-rose-400',
              !session && 'bg-white/20',
            )}
          />
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium">{conn.name}</span>
            {conn.environment === 'production' && <Badge tone="danger">PROD</Badge>}
            {conn.environment === 'staging' && <Badge tone="warn">STAGING</Badge>}
            {conn.readOnly && <span title="Read-only"><Lock className="size-3 text-faint" /></span>}
          </div>
          <div className="truncate text-[11px] text-faint">
            {KIND_LABEL[conn.kind]}
            {conn.kind !== 'sqlite' && conn.host ? ` · ${conn.host}${conn.instance ? '\\' + conn.instance : ''}` : ''}
          </div>
        </div>
        {session?.status === 'connecting' ? (
          <Spinner className="size-3.5" />
        ) : (
          <span className="hidden items-center group-hover:flex">
            {!connected && (
              <IconButton label="Connect" className="size-6" onClick={(e) => (e.stopPropagation(), void onClick())}>
                <PlugZap className="size-3.5" />
              </IconButton>
            )}
            <IconButton label="More" className="size-6" onClick={menu}>
              <MoreHorizontal className="size-3.5" />
            </IconButton>
          </span>
        )}
      </div>
      <Collapse open={open && connected}>
        <div className="pt-1">
          {conn.kind === 'sqlite' ? (
            <DatabaseNode conn={conn} database="main" depth={0} filter={filter} />
          ) : (
            dbs.map((d) => <DatabaseNode key={d} conn={conn} database={d} depth={0} filter={filter} />)
          )}
        </div>
      </Collapse>
    </div>
  );
}

export function Sidebar() {
  const connections = useStore((s) => s.connections);
  const openConnectionDialog = useStore((s) => s.openConnectionDialog);
  const [filter, setFilter] = useState('');
  const openMenu = useContextMenu();

  return (
    <aside className="glass relative z-10 flex h-full w-[280px] shrink-0 flex-col border-y-0 border-l-0">
      <div className={cn('drag flex h-11 shrink-0 items-center gap-2 px-3', platform === 'darwin' && 'pl-[84px]')}>
        <motion.div
          initial={{ rotate: -30, scale: 0.6, opacity: 0 }}
          animate={{ rotate: 0, scale: 1, opacity: 1 }}
          transition={spring}
          className="flex size-6 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-400 to-cyan-400 shadow-[0_0_18px_-2px_rgb(129_140_248/0.9)]"
        >
          <Waypoints className="size-3.5 text-white" />
        </motion.div>
        <span className="flex-1 text-[13px] font-semibold tracking-tight">SchemaScope</span>
        <IconButton label="Integrations: REST API, endpoints, MCP" className="no-drag" onClick={() => useStore.getState().openIntegrations()}>
          <Cable className="size-4" />
        </IconButton>
        <IconButton label="Notebooks" className="no-drag" onClick={(e) => void notebooksMenu().then((items) => openMenu(e, items))}>
          <NotebookPen className="size-4" />
        </IconButton>
        <IconButton label="AI assistant settings" className="no-drag" onClick={() => useStore.getState().openAiSettings(true)}>
          <Sparkles className="size-4" />
        </IconButton>
      </div>

      <div className="flex items-center gap-2 px-3 pt-1 pb-2">
        <span className="flex-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Connections</span>
        <IconButton label="New connection" onClick={() => openConnectionDialog()}>
          <Plus className="size-4" />
        </IconButton>
      </div>
      <div className="px-3 pb-2">
        <Input icon={<Search className="size-3.5" />} placeholder="Filter tables…" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-7" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {connections.map((c, i) => (
          <motion.div key={c.id} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ ...spring, delay: i * 0.04 }}>
            <ConnectionNode conn={c} filter={filter} />
          </motion.div>
        ))}
        {!connections.length && (
          <button
            onClick={() => openConnectionDialog()}
            className="mt-2 flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong p-5 text-muted hover:border-accent/50 hover:text-fg"
          >
            <Plus className="size-5" />
            <span className="text-xs">Add your first connection</span>
          </button>
        )}
      </div>
    </aside>
  );
}
