import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { Activity, Cable, Columns2, GitCompareArrows, LayoutDashboard, NotebookPen, Server, Shield, Table2, TerminalSquare, Waypoints, X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { KIND_LABEL } from '../shared/types';
import { ConnectionDialog } from './components/ConnectionDialog';
import { PromptDialog, SqlConfirmDialog, Toasts } from './components/Dialogs';
import { Sidebar } from './components/Sidebar';
import { DashboardTab } from './components/tabs/DashboardTab';
import { IntegrationsTab } from './components/tabs/IntegrationsTab';
import { EndpointDialog } from './components/EndpointDialog';
import { NotebookTab } from './components/notebook/NotebookTab';
import { UpdateIndicator } from './components/UpdateIndicator';
import { LocalServerTab } from './components/LocalServerTab';
import { NewDatabaseDialog } from './components/NewDatabaseDialog';
import { RestoreBakDialog } from './components/RestoreBakDialog';
import { AiSettingsDialog } from './components/ai/AiSettingsDialog';
import { ActivityTab } from './components/dba/ActivityTab';
import { SecurityTab } from './components/dba/SecurityTab';
import { CompareTab } from './components/dba/CompareTab';
import { DataCompareTab } from './components/dba/DataCompareTab';
import { ImportDialog } from './components/dba/ImportDialog';
import { ExportDialog } from './components/dba/ExportDialog';
import { BackupDialog } from './components/dba/BackupDialog';
import { MockDialog } from './components/dba/MockDialog';
import { DocsDialog } from './components/dba/DocsDialog';
import { DiagramTab } from './components/tabs/DiagramTab';
import { QueryTab } from './components/tabs/QueryTab';
import { TableTab } from './components/tabs/TableTab';
import { TableDesigner } from './components/TableDesigner';
import { ContextMenuProvider, spring, useContextMenu } from './components/ui';
import { Welcome } from './components/Welcome';
import { platform } from './lib/api';
import { useStore, type Tab, type TabKind } from './lib/store';
import { cn } from './lib/utils';

const TAB_ICON: Record<TabKind, ReactNode> = {
  query: <TerminalSquare className="size-3.5 text-violet-300" />,
  table: <Table2 className="size-3.5 text-indigo-300" />,
  diagram: <Waypoints className="size-3.5 text-cyan-300" />,
  dashboard: <LayoutDashboard className="size-3.5 text-emerald-300" />,
  integrations: <Cable className="size-3.5 text-amber-300" />,
  activity: <Activity className="size-3.5 text-rose-300" />,
  security: <Shield className="size-3.5 text-sky-300" />,
  compare: <GitCompareArrows className="size-3.5 text-fuchsia-300" />,
  datacompare: <Columns2 className="size-3.5 text-fuchsia-300" />,
  notebook: <NotebookPen className="size-3.5 text-amber-200" />,
  localserver: <Server className="size-3.5 text-rose-300" />,
};

function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeTabId);
  const connections = useStore((s) => s.connections);
  const { setActiveTab, closeTab, closeOtherTabs } = useStore.getState();
  const openMenu = useContextMenu();

  return (
    // The whole strip is the window's drag handle; on Windows leave room for the caption buttons.
    <div className={cn('drag flex h-11 shrink-0 items-end gap-1 border-b border-line px-2', platform === 'win32' && 'pr-[150px]')}>
      <div className="no-drag no-scrollbar flex min-w-0 flex-1 items-end gap-1 overflow-x-auto pb-1.5" onWheel={(e) => (e.currentTarget.scrollLeft += e.deltaY)}>
        <AnimatePresence initial={false}>
          {tabs.map((t) => {
            const conn = connections.find((c) => c.id === t.connId);
            const active = t.id === activeId;
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 8, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85, width: 0 }}
                transition={spring}
                onMouseDown={(e) => e.button === 1 && closeTab(t.id)}
                onClick={() => setActiveTab(t.id)}
                ref={(el) => {
                  if (el && active) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(e, [
                    { label: 'Close', onClick: () => closeTab(t.id) },
                    { label: 'Close others', onClick: () => closeOtherTabs(t.id) },
                  ]);
                }}
                title={conn ? `${conn.name} · ${t.database}` : t.title}
                className={cn(
                  'group relative flex h-7 max-w-[220px] shrink-0 cursor-pointer items-center gap-2 rounded-lg pr-1 pl-2.5 text-[12.5px] transition-colors',
                  active ? 'text-fg' : 'text-muted hover:bg-white/[0.04] hover:text-fg',
                )}
              >
                {active && (
                  <motion.span
                    layoutId="active-tab"
                    transition={spring}
                    className="absolute inset-0 rounded-lg border border-line-strong bg-white/[0.06] shadow-[0_0_20px_-8px_rgb(129_140_248/0.9)]"
                  />
                )}
                <span className="relative flex items-center gap-2 truncate">
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: conn?.color ?? '#818cf8', boxShadow: `0 0 6px ${conn?.color ?? '#818cf8'}` }} />
                  {TAB_ICON[t.kind]}
                  <span className="truncate">{t.title}</span>
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                  className={cn('relative flex size-5 items-center justify-center rounded-md text-faint hover:bg-white/10 hover:text-fg', !active && 'opacity-0 group-hover:opacity-100')}
                  aria-label="Close tab"
                >
                  <X className="size-3" />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

function StatusBar({ tab }: { tab?: Tab }) {
  const conn = useStore((s) => s.connections.find((c) => c.id === tab?.connId));
  const session = useStore((s) => (tab ? s.sessions[tab.connId] : undefined));
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line px-3 text-[11px] text-faint">
      {conn ? (
        <>
          <span className="flex items-center gap-1.5">
            <span
              className={cn('size-1.5 rounded-full', session?.status === 'connected' ? 'bg-emerald-400 shadow-[0_0_6px_rgb(52_211_153)]' : 'bg-white/25')}
            />
            {conn.name}
          </span>
          {conn.environment === 'production' && <span className="rounded bg-rose-500/20 px-1.5 font-semibold text-rose-300">PRODUCTION</span>}
          {conn.readOnly && <span className="text-muted">read-only</span>}
          <span>{KIND_LABEL[conn.kind]}</span>
          {session?.serverVersion && <span className="truncate">{session.serverVersion}</span>}
          <span className="text-muted">{tab?.database}</span>
        </>
      ) : (
        <span>Not connected</span>
      )}
      <div className="flex-1" />
      <UpdateIndicator />
    </div>
  );
}

/** A red glowing frame whenever the active tab works against a production connection. */
function ProductionFrame({ tab }: { tab?: Tab }) {
  const prod = useStore((s) => s.connections.find((c) => c.id === tab?.connId)?.environment === 'production');
  return (
    <AnimatePresence>
      {prod && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="pointer-events-none absolute inset-0 z-40 rounded-[inherit] shadow-[inset_0_0_0_2px_rgb(251_113_133/0.75),inset_0_0_40px_-12px_rgb(251_113_133/0.6)]"
        />
      )}
    </AnimatePresence>
  );
}

function TabContent({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case 'query':
      return <QueryTab tab={tab} />;
    case 'table':
      return <TableTab tab={tab} />;
    case 'diagram':
      return <DiagramTab tab={tab} />;
    case 'dashboard':
      return <DashboardTab tab={tab} />;
    case 'integrations':
      return <IntegrationsTab />;
    case 'activity':
      return <ActivityTab tab={tab} />;
    case 'security':
      return <SecurityTab tab={tab} />;
    case 'compare':
      return <CompareTab tab={tab} />;
    case 'datacompare':
      return <DataCompareTab tab={tab} />;
    case 'notebook':
      return <NotebookTab tab={tab} />;
    case 'localserver':
      return <LocalServerTab />;
  }
}

export function App() {
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeTabId);
  const loadConnections = useStore((s) => s.loadConnections);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[tabs.length - 1];

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  // Drop tabs that point at connections which no longer exist.
  const connections = useStore((s) => s.connections);
  useEffect(() => {
    if (!connections.length) return;
    const ids = new Set(connections.map((c) => c.id));
    const stale = useStore.getState().tabs.filter((t) => t.kind !== 'integrations' && !ids.has(t.connId));
    stale.forEach((t) => useStore.getState().closeTab(t.id));
  }, [connections]);

  return (
    <ContextMenuProvider>
      <div className="relative flex h-full">
        <ProductionFrame tab={active} />
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          <div className="relative min-h-0 flex-1">
            {tabs.length === 0 && <Welcome />}
            {/* Keep every tab mounted so editors, results and diagram state survive switching;
                display:none (not visibility) because React Flow forces its nodes visible, and it pauses animations. */}
            {tabs.map((t) => (
              <div key={t.id} className={cn('absolute inset-0', t.id !== active?.id && 'hidden')}>
                <LayoutGroup id={t.id}>
                  <TabContent tab={t} />
                </LayoutGroup>
              </div>
            ))}
          </div>
          <StatusBar tab={active} />
        </main>
      </div>
      <ConnectionDialog />
      <SqlConfirmDialog />
      <PromptDialog />
      <TableDesigner />
      <EndpointDialog />
      <AiSettingsDialog />
      <NewDatabaseDialog />
      <RestoreBakDialog />
      <ImportDialog />
      <ExportDialog />
      <BackupDialog />
      <MockDialog />
      <DocsDialog />
      <Toasts />
    </ContextMenuProvider>
  );
}
