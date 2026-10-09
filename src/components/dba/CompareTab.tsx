import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, CheckCircle2, GitCompareArrows, Minus, Pencil, Play, Plus, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { SchemaSnapshot } from '../../../shared/types';
import { KIND_LABEL } from '../../../shared/types';
import { api } from '../../lib/api';
import { diffSchemas, migrationScript, type SchemaChange } from '../../lib/schemaDiff';
import { useStore, type Tab } from '../../lib/store';
import { cn } from '../../lib/utils';
import { DbPicker, type DbTarget } from '../DbPicker';
import { SqlEditor } from '../SqlEditor';
import { Badge, Button, EmptyState, softSpring, spring } from '../ui';

const ICON: Record<string, React.ReactNode> = {
  create: <Plus className="size-3.5 text-ok" />,
  add: <Plus className="size-3.5 text-ok" />,
  drop: <Minus className="size-3.5 text-danger" />,
  alter: <Pencil className="size-3.5 text-warn" />,
};

export function CompareTab({ tab }: { tab: Tab }) {
  const connections = useStore((s) => s.connections);
  const [source, setSource] = useState<DbTarget>({ connId: tab.connId, database: tab.database });
  const [target, setTarget] = useState<DbTarget>({ connId: '', database: '' });
  const [snaps, setSnaps] = useState<{ s: SchemaSnapshot; t: SchemaSnapshot } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changes = useMemo(() => (snaps ? diffSchemas(snaps.s, snaps.t) : []), [snaps]);
  const picked = changes.filter((c) => selected.has(c.id));
  const tconn = connections.find((c) => c.id === target.connId);
  const script = snaps && tconn ? migrationScript(tconn.kind, picked, `Make ${tconn.name}/${target.database} match ${connections.find((c) => c.id === source.connId)?.name}/${source.database}`) : '';

  const compare = async () => {
    setBusy(true);
    setError(null);
    try {
      const [s, t] = await Promise.all([api.schema(source.connId, source.database, true), api.schema(target.connId, target.database, true)]);
      setSnaps({ s, t });
      setSelected(new Set(diffSchemas(s, t).filter((c) => !c.destructive && !c.unsupported).map((c) => c.id)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const groups = useMemo(() => {
    const m = new Map<string, SchemaChange[]>();
    for (const c of changes) m.set(c.table, [...(m.get(c.table) ?? []), c]);
    return [...m.entries()];
  }, [changes]);

  const counts = {
    add: changes.filter((c) => c.kind.startsWith('create') || c.kind.startsWith('add')).length,
    alter: changes.filter((c) => c.kind === 'alter-column').length,
    drop: changes.filter((c) => c.kind.startsWith('drop')).length,
  };

  const apply = () =>
    useStore.getState().confirmSql({
      connId: target.connId,
      database: target.database,
      title: `Apply ${picked.length} change(s) to ${target.database}`,
      sql: script,
      danger: picked.some((c) => c.destructive),
      description: picked.some((c) => c.destructive) ? 'Some selected changes drop columns, indexes, keys or tables.' : undefined,
      onDone: () => void compare(),
    });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <GitCompareArrows className="size-5 text-accent" />
        <div className="mr-2">
          <div className="text-[15px] font-semibold">Schema compare</div>
          <div className="text-[11px] text-muted">Generates the SQL that makes the target match the source.</div>
        </div>
        <DbPicker label="Source" value={source} onChange={setSource} />
        <ArrowRight className="size-4 text-faint" />
        <DbPicker label="Target" value={target} onChange={setTarget} />
        <Button
          variant="primary"
          loading={busy}
          disabled={!source.database || !target.database || (source.connId === target.connId && source.database === target.database)}
          onClick={() => void compare()}
        >
          Compare
        </Button>
      </div>

      {error && <div className="m-4 rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 font-mono text-xs text-rose-100">{error}</div>}

      {!snaps ? (
        <EmptyState icon={<GitCompareArrows className="size-6" />} title="Compare two databases">
          Pick a source (for example development) and a target (for example production). Engines may differ — types are mapped
          (e.g. PostgreSQL text → SQL Server nvarchar(max)).
        </EmptyState>
      ) : !changes.length ? (
        <EmptyState icon={<CheckCircle2 className="size-6" />} title="The schemas match">
          No differences in tables, columns, indexes or foreign keys.
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-auto p-4">
            <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={softSpring} className="mb-3 flex items-center gap-2">
              <Badge tone="ok">+{counts.add} add</Badge>
              <Badge tone="warn">~{counts.alter} change</Badge>
              <Badge tone="danger">−{counts.drop} drop</Badge>
              {snaps.s.kind !== snaps.t.kind && (
                <Badge tone="accent">
                  {KIND_LABEL[snaps.s.kind]} → {KIND_LABEL[snaps.t.kind]}
                </Badge>
              )}
              <div className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(changes.filter((c) => !c.unsupported).map((c) => c.id)))}>
                Select all
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                None
              </Button>
            </motion.div>
            <div className="space-y-3">
              {groups.map(([table, list], gi) => (
                <motion.section key={table} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: Math.min(gi * 0.04, 0.5) }} className="glass rounded-xl">
                  <div className="border-b border-line px-3 py-2 font-mono text-[12.5px] font-semibold">{table}</div>
                  {list.map((c) => {
                    const verb = c.kind.split('-')[0];
                    return (
                      <label
                        key={c.id}
                        className={cn('flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[12.5px] hover:bg-white/[0.03]', c.unsupported && 'cursor-not-allowed opacity-50')}
                      >
                        <input
                          type="checkbox"
                          disabled={c.unsupported}
                          checked={selected.has(c.id)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(c.id);
                            else next.delete(c.id);
                            setSelected(next);
                          }}
                          className="accent-indigo-400"
                        />
                        {ICON[verb]}
                        <span className="flex-1">{c.title}</span>
                        {c.detail && <span className="font-mono text-[11px] text-muted">{c.detail}</span>}
                        {c.destructive && <TriangleAlert className="size-3.5 text-danger" aria-label="Destructive" />}
                        {c.unsupported && <Badge>not supported</Badge>}
                      </label>
                    );
                  })}
                </motion.section>
              ))}
            </div>
          </div>
          <div className="flex w-[44%] min-w-[380px] flex-col border-l border-line">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <span className="flex-1 text-[12px] font-semibold">Migration script · {picked.length} change(s)</span>
              <Button size="sm" variant="ghost" disabled={!picked.length} onClick={() => useStore.getState().newQuery(target.connId, target.database, script)}>
                Open in query
              </Button>
              <Button size="sm" variant={picked.some((c) => c.destructive) ? 'danger' : 'primary'} icon={<Play className="size-3.5" />} disabled={!picked.length} onClick={apply}>
                Apply to target
              </Button>
            </div>
            <div className="min-h-0 flex-1 bg-black/20">
              <AnimatePresence mode="wait">
                <motion.div key={picked.length} initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} className="h-full">
                  {tconn && <SqlEditor value={script} kind={tconn.kind} readOnly />}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
