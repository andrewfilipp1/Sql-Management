import { AnimatePresence, motion } from 'motion/react';
import { Activity, Ban, Lock, Pause, Play, Search, Skull } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ActivitySession } from '../../../shared/types';
import { api } from '../../lib/api';
import { useConnection, useStore, type Tab } from '../../lib/store';
import { cn, formatMs } from '../../lib/utils';
import { Badge, Button, EmptyState, IconButton, Input, Modal, Switch, spring } from '../ui';

const HISTORY = 60;

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const w = 220;
  const h = 44;
  const pts = values.map((v, i) => [(i / (HISTORY - 1)) * w, h - (v / max) * (h - 6) - 3]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} className="overflow-visible" role="img" aria-label="Active sessions over the last two minutes">
      <defs>
        <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="rgb(129 140 248 / 0.35)" />
          <stop offset="100%" stopColor="rgb(129 140 248 / 0)" />
        </linearGradient>
      </defs>
      {pts.length > 1 && (
        <>
          <path d={`${line} L${pts[pts.length - 1][0]},${h} L${pts[0][0]},${h} Z`} fill="url(#spark-fill)" />
          <motion.path d={line} fill="none" stroke="#818cf8" strokeWidth={1.8} initial={false} animate={{ d: line }} transition={{ duration: 0.4 }} />
          <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={3} fill="#a5b4fc" className="drop-shadow-[0_0_6px_rgb(129_140_248)]" />
        </>
      )}
    </svg>
  );
}

export function ActivityTab({ tab }: { tab: Tab }) {
  const conn = useConnection(tab.connId);
  const [sessions, setSessions] = useState<ActivitySession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [showIdle, setShowIdle] = useState(false);
  const [filter, setFilter] = useState('');
  const [history, setHistory] = useState<number[]>([]);
  const [kill, setKill] = useState<{ s: ActivitySession; mode: 'cancel' | 'terminate' } | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.activity(tab.connId, tab.database);
        if (!alive) return;
        setSessions(r);
        setError(null);
        const active = r.filter((s) => !s.isSelf && s.state && !/idle|sleep/i.test(s.state)).length;
        setHistory((h) => [...h.slice(-(HISTORY - 1)), active]);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void tick();
    if (!live) return () => void (alive = false);
    const t = setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tab.connId, tab.database, live]);

  const blockers = useMemo(() => new Set((sessions ?? []).flatMap((s) => s.blockedBy)), [sessions]);
  const visible = (sessions ?? []).filter((s) => {
    if (s.isSelf) return false;
    if (!showIdle && (!s.state || /idle|sleep|sleeping/i.test(s.state))) return false;
    const q = filter.toLowerCase();
    return !q || [s.user, s.database, s.client, s.query].some((v) => v?.toLowerCase().includes(q));
  });

  if (error && !sessions) return <EmptyState icon={<Activity className="size-6" />} title="Activity is not available">{error}</EmptyState>;

  const doKill = async () => {
    if (!kill) return;
    try {
      await api.killSession(tab.connId, tab.database, kill.s.id, kill.mode);
      useStore.getState().toast(`${kill.mode === 'cancel' ? 'Cancelled query of' : 'Terminated'} session ${kill.s.id}`, 'success');
    } catch (e) {
      useStore.getState().toast((e as Error).message, 'error');
    } finally {
      setKill(null);
    }
  };

  const total = (sessions ?? []).filter((s) => !s.isSelf).length;
  const blocked = (sessions ?? []).filter((s) => s.blockedBy.length).length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-5 border-b border-line px-5 py-3">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            <Activity className="size-4 text-accent" /> Activity
          </h2>
          <div className="text-[11px] text-muted">
            {conn?.name} · {tab.database}
          </div>
        </div>
        <Sparkline values={history} />
        <div className="flex gap-4 text-[12px]">
          <div>
            <div className="text-[18px] font-semibold tabular-nums">{history[history.length - 1] ?? 0}</div>
            <div className="text-faint">active</div>
          </div>
          <div>
            <div className="text-[18px] font-semibold tabular-nums">{total}</div>
            <div className="text-faint">sessions</div>
          </div>
          <div>
            <div className={cn('text-[18px] font-semibold tabular-nums', blocked > 0 && 'text-danger')}>{blocked}</div>
            <div className="text-faint">blocked</div>
          </div>
        </div>
        <div className="flex-1" />
        <div className="w-56">
          <Input icon={<Search className="size-3.5" />} placeholder="Filter user, query…" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-7" />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          <Switch checked={showIdle} onChange={setShowIdle} label="Show idle sessions" /> idle
        </label>
        <IconButton label={live ? 'Pause live refresh' : 'Resume live refresh'} active={live} onClick={() => setLive((v) => !v)}>
          {live ? <Pause className="size-4" /> : <Play className="size-4" />}
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {!visible.length ? (
          <EmptyState icon={<Activity className="size-6" />} title={showIdle ? 'No sessions' : 'Nothing running right now'}>
            {showIdle ? 'No other sessions are connected.' : 'Turn on “idle” to see every connected session.'}
          </EmptyState>
        ) : (
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {visible.map((s) => {
                const isBlocked = s.blockedBy.length > 0;
                const isBlocker = blockers.has(s.id);
                return (
                  <motion.div
                    key={s.id}
                    layout
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: 30 }}
                    transition={spring}
                    className={cn(
                      'glass group rounded-xl px-4 py-2.5',
                      isBlocked && 'border-rose-400/40 shadow-[0_0_24px_-10px_rgb(251_113_133/0.8)]',
                      isBlocker && !isBlocked && 'border-amber-400/40 shadow-[0_0_24px_-10px_rgb(251_191_36/0.8)]',
                    )}
                  >
                    <div className="flex items-center gap-3 text-[12.5px]">
                      <span className="font-mono text-faint">#{s.id}</span>
                      <span className="font-medium">{s.user ?? '—'}</span>
                      <span className="text-muted">{s.database}</span>
                      <span className="truncate text-faint">{s.client}</span>
                      <Badge tone={/active|running|query|execute/i.test(s.state ?? '') ? 'accent' : 'default'}>{s.state ?? 'unknown'}</Badge>
                      {s.wait && <Badge tone="warn">{s.wait}</Badge>}
                      {isBlocked && (
                        <Badge tone="danger">
                          <Lock className="size-3" /> blocked by #{s.blockedBy.join(', #')}
                        </Badge>
                      )}
                      {isBlocker && <Badge tone="warn">blocking others</Badge>}
                      <div className="flex-1" />
                      <span className={cn('font-mono tabular-nums', (s.durationMs ?? 0) > 10_000 ? 'text-warn' : 'text-muted')}>
                        {s.durationMs != null ? formatMs(s.durationMs) : ''}
                      </span>
                      {conn?.kind !== 'mssql' && (
                        <IconButton label="Cancel the running query" onClick={() => setKill({ s, mode: 'cancel' })}>
                          <Ban className="size-3.5" />
                        </IconButton>
                      )}
                      <IconButton label="Terminate the session" onClick={() => setKill({ s, mode: 'terminate' })}>
                        <Skull className="size-3.5" />
                      </IconButton>
                    </div>
                    {s.query && <pre className="mt-1.5 line-clamp-2 font-mono text-[11.5px] whitespace-pre-wrap text-fg/75">{s.query.trim()}</pre>}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>

      <Modal
        open={!!kill}
        onClose={() => setKill(null)}
        title={kill?.mode === 'cancel' ? 'Cancel query' : 'Terminate session'}
        icon={<Skull className="size-4 text-danger" />}
        width={480}
        footer={
          <>
            <Button onClick={() => setKill(null)}>Keep running</Button>
            <Button variant="danger" onClick={() => void doKill()}>
              {kill?.mode === 'cancel' ? 'Cancel query' : 'Terminate'}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-muted">
          {kill?.mode === 'cancel'
            ? `The running statement of session #${kill?.s.id} (${kill?.s.user}) is cancelled; the session stays connected.`
            : `Session #${kill?.s.id} (${kill?.s.user}) is disconnected and any open transaction is rolled back.`}
          {conn?.environment === 'production' && <span className="mt-2 block font-medium text-rose-300">This is a production server.</span>}
        </p>
      </Modal>
    </div>
  );
}
