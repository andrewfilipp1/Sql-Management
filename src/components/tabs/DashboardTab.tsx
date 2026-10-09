import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { AlertTriangle, Columns3, Eye, GitFork, KeyRound, LayoutDashboard, ListTree, Rows3, Table2, Unlink, Waypoints, Wrench } from 'lucide-react';
import { useEffect, useMemo, type ReactNode } from 'react';
import { KIND_LABEL } from '../../../shared/types';
import { databaseToolsMenu, openDiagram, openTable, refreshSchema } from '../../lib/actions';
import { lintSchema, type Problem } from '../../lib/lint';
import { useConnection, useSchema, useStore, type Tab } from '../../lib/store';
import { compactNumber, formatNumber, nodeId, relationsOf } from '../../lib/utils';
import { Button, EmptyState, Spinner, softSpring, spring, useContextMenu } from '../ui';

function CountUp({ value }: { value: number }) {
  const mv = useMotionValue(0);
  const text = useTransform(mv, (v) => formatNumber(Math.round(v)));
  useEffect(() => {
    const c = animate(mv, value, { duration: 1.1, ease: [0.2, 0.8, 0.2, 1] });
    return () => c.stop();
  }, [mv, value]);
  return <motion.span>{text}</motion.span>;
}

function Stat({ icon, label, value, i }: { icon: ReactNode; label: string; value: number; i: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      whileHover={{ scale: 1.03, y: -2 }}
      transition={{ ...spring, delay: i * 0.05 }}
      className="glass gradient-border relative overflow-hidden rounded-2xl p-4 hover:shadow-[0_0_30px_-10px_rgb(129_140_248/0.7)]"
    >
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="text-accent">{icon}</span>
        {label}
      </div>
      <div className="mt-2 text-[26px] font-semibold tracking-tight tabular-nums">
        <CountUp value={value} />
      </div>
    </motion.div>
  );
}

function Panel({ title, icon, children, delay = 0 }: { title: string; icon: ReactNode; children: ReactNode; delay?: number }) {
  return (
    <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ ...softSpring, delay }} className="glass rounded-2xl p-4">
      <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
        <span className="text-accent">{icon}</span>
        {title}
      </h3>
      {children}
    </motion.section>
  );
}

export function DashboardTab({ tab }: { tab: Tab }) {
  const state = useSchema(tab.connId, tab.database);
  const conn = useConnection(tab.connId);
  const session = useStore((s) => s.sessions[tab.connId]);
  const ensureSchema = useStore((s) => s.ensureSchema);
  const openMenu = useContextMenu();
  useEffect(() => ensureSchema(tab.connId, tab.database), [tab.connId, tab.database, ensureSchema]);
  const s = state?.data;

  const stats = useMemo(() => {
    if (!s) return null;
    const rels = relationsOf(s);
    const tables = s.tables.filter((t) => t.type === 'table');
    const degree = new Map<string, number>();
    for (const r of rels) {
      degree.set(nodeId(r.from), (degree.get(nodeId(r.from)) ?? 0) + 1);
      degree.set(nodeId(r.to), (degree.get(nodeId(r.to)) ?? 0) + 1);
    }
    const largest = [...tables].filter((t) => t.rowCount != null).sort((a, b) => (b.rowCount ?? 0) - (a.rowCount ?? 0)).slice(0, 8);
    const hubs = [...tables].map((t) => ({ t, d: degree.get(nodeId(t)) ?? 0 })).filter((x) => x.d > 0).sort((a, b) => b.d - a.d).slice(0, 6);
    // Same checks as the diagram's problem markers.
    const problems = lintSchema(s, s.kind);
    const byRule = (rule: string) => problems.filter((p) => p.rule === rule);
    const noPk = byRule('no-pk');
    const isolated = byRule('isolated');
    const unindexedFks = byRule('fk-no-index');
    return {
      tables: tables.length,
      views: s.tables.length - tables.length,
      columns: s.tables.reduce((a, t) => a + t.columns.length, 0),
      relations: rels.length,
      indexes: tables.reduce((a, t) => a + t.indexes.length, 0),
      rows: tables.reduce((a, t) => a + (t.rowCount ?? 0), 0),
      largest,
      hubs,
      noPk,
      isolated,
      unindexedFks,
    };
  }, [s]);

  if (state?.status === 'error') return <EmptyState icon={<LayoutDashboard className="size-6" />} title="Could not read the schema">{state.error}</EmptyState>;
  if (!s || !stats || !conn) return <div className="flex h-full items-center justify-center"><Spinner /></div>;

  const maxRows = Math.max(1, ...stats.largest.map((t) => t.rowCount ?? 0));
  const healthItem = (p: Problem, view: 'structure' | 'data') => ({
    label: p.column ? `${p.table}.${p.column}` : p.table,
    onClick: () => {
      const t = s.tables.find((x) => nodeId(x) === p.key);
      if (t) openTable(tab.connId, tab.database, t, view);
    },
    onFix: p.fix
      ? () => useStore.getState().confirmSql({ connId: tab.connId, database: tab.database, title: p.fix!.label, description: p.title, sql: p.fix!.sql, onDone: () => void refreshSchema(tab.connId, tab.database) })
      : undefined,
  });

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl space-y-5 p-6">
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={softSpring} className="flex items-end gap-4">
          <div className="flex-1">
            <div className="text-xs text-muted">
              {KIND_LABEL[conn.kind]} {session?.serverVersion ? `· ${session.serverVersion}` : ''}
            </div>
            <h1 className="glow-text mt-1 text-2xl font-semibold tracking-tight">{tab.database}</h1>
          </div>
          <Button icon={<Wrench className="size-4" />} onClick={(e) => openMenu(e, databaseToolsMenu(tab.connId, tab.database, conn.kind))}>
            Tools
          </Button>
          <Button variant="primary" icon={<Waypoints className="size-4" />} onClick={() => openDiagram(tab.connId, tab.database)}>
            Open diagram
          </Button>
        </motion.div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat i={0} icon={<Table2 className="size-3.5" />} label="Tables" value={stats.tables} />
          <Stat i={1} icon={<Eye className="size-3.5" />} label="Views" value={stats.views} />
          <Stat i={2} icon={<Columns3 className="size-3.5" />} label="Columns" value={stats.columns} />
          <Stat i={3} icon={<GitFork className="size-3.5" />} label="Relationships" value={stats.relations} />
          <Stat i={4} icon={<ListTree className="size-3.5" />} label="Indexes" value={stats.indexes} />
          <Stat i={5} icon={<Rows3 className="size-3.5" />} label="Rows (approx.)" value={stats.rows} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Largest tables" icon={<Rows3 className="size-4" />} delay={0.15}>
            <div className="space-y-2">
              {stats.largest.map((t, i) => (
                <button key={nodeId(t)} onClick={() => openTable(tab.connId, tab.database, t)} className="group block w-full text-left">
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="font-mono text-fg/90 group-hover:text-accent">{t.name}</span>
                    <span className="font-mono text-muted tabular-nums">{formatNumber(t.rowCount)}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-white/[0.05]">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.max(2, ((t.rowCount ?? 0) / maxRows) * 100)}%` }}
                      transition={{ ...softSpring, delay: 0.25 + i * 0.06 }}
                      className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 shadow-[0_0_12px_rgb(129_140_248/0.6)]"
                    />
                  </div>
                </button>
              ))}
              {!stats.largest.length && <div className="text-xs text-faint">No row counts available.</div>}
            </div>
          </Panel>

          <Panel title="Most connected tables" icon={<GitFork className="size-4" />} delay={0.2}>
            <div className="space-y-1.5">
              {stats.hubs.map(({ t, d }, i) => (
                <motion.button
                  key={nodeId(t)}
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  whileHover={{ scale: 1.02, x: 2 }}
                  transition={{ ...spring, delay: 0.25 + i * 0.05 }}
                  onClick={() => openDiagram(tab.connId, tab.database, nodeId(t))}
                  className="flex w-full items-center gap-3 rounded-xl border border-line bg-white/[0.02] px-3 py-2 text-left hover:border-cyan-300/30 hover:shadow-[0_0_18px_-6px_rgb(34_211_238/0.6)]"
                >
                  <span className="flex size-7 items-center justify-center rounded-lg bg-cyan-400/10 font-mono text-xs text-fk">{d}</span>
                  <span className="flex-1 font-mono text-[12.5px]">{t.name}</span>
                  <span className="text-[11px] text-faint">{compactNumber(t.rowCount)} rows</span>
                  <Waypoints className="size-3.5 text-faint" />
                </motion.button>
              ))}
              {!stats.hubs.length && <div className="text-xs text-faint">No foreign keys defined.</div>}
            </div>
          </Panel>
        </div>

        <Panel title="Schema health" icon={<AlertTriangle className="size-4" />} delay={0.3}>
          <div className="grid gap-4 md:grid-cols-3">
            <Health icon={<KeyRound className="size-3.5" />} title="Tables without a primary key" items={stats.noPk.map((p) => healthItem(p, 'structure'))} ok="Every table has a primary key." />
            <Health icon={<ListTree className="size-3.5" />} title="Foreign keys without an index" items={stats.unindexedFks.map((p) => healthItem(p, 'structure'))} ok="All foreign keys are indexed." />
            <Health icon={<Unlink className="size-3.5" />} title="Tables with no relationships" items={stats.isolated.map((p) => healthItem(p, 'data'))} ok="Every table is connected." />
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Health({ icon, title, items, ok }: { icon: ReactNode; title: string; items: { label: string; onClick: () => void; onFix?: () => void }[]; ok: string }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs text-muted">
        <span className={items.length ? 'text-warn' : 'text-ok'}>{icon}</span>
        {title}
        <span className={items.length ? 'ml-auto text-warn' : 'ml-auto text-ok'}>{items.length}</span>
      </div>
      {items.length ? (
        <div className="flex flex-wrap gap-1.5">
          {items.slice(0, 14).map((it) => (
            <span key={it.label} className="inline-flex overflow-hidden rounded-md border border-amber-400/20 bg-amber-400/5 font-mono text-[11px] text-amber-100/90">
              <button onClick={it.onClick} className="px-1.5 py-0.5 hover:bg-amber-400/10">
                {it.label}
              </button>
              {it.onFix && (
                <button onClick={it.onFix} title="Fix" aria-label={`Fix ${it.label}`} className="border-l border-amber-400/20 px-1 hover:bg-emerald-400/15 hover:text-emerald-200">
                  <Wrench className="size-3" />
                </button>
              )}
            </span>
          ))}
          {items.length > 14 && <span className="text-[11px] text-faint">+{items.length - 14} more</span>}
        </div>
      ) : (
        <div className="text-xs text-ok/80">{ok}</div>
      )}
    </div>
  );
}
