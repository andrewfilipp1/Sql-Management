import type { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { AnimatePresence, motion } from 'motion/react';
import { AlignLeft, Braces, Cable, Gauge, Clock, FileSpreadsheet, History, Microscope, Play, ShieldAlert, TerminalSquare, XCircle } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { format as formatSql } from 'sql-formatter';
import type { DbKind, QueryResponse } from '../../../shared/types';
import { refreshSchema } from '../../lib/actions';
import { api, type ApiError } from '../../lib/api';
import { useConnection, useSchema, useStore, type Tab } from '../../lib/store';
import { cn, formatMs, formatNumber, toCsv, toJson } from '../../lib/utils';
import { DataGrid } from '../DataGrid';
import { PlanView } from '../dba/PlanView';
import { normalizePlan, type PlanNode } from '../../lib/plan';
import { SqlEditor } from '../SqlEditor';
import { Button, EmptyState, IconButton, Kbd, Modal, Select, spring, useContextMenu } from '../ui';

const FORMAT_LANG: Record<DbKind, 'sqlite' | 'postgresql' | 'mysql' | 'transactsql'> = {
  sqlite: 'sqlite',
  postgres: 'postgresql',
  mysql: 'mysql',
  mssql: 'transactsql',
};

const HISTORY_KEY = 'schemascope.history';
const PLAN_TAB = -1;
function readHistory(): { sql: string; at: number }[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
  } catch {
    return [];
  }
}
function pushHistory(sql: string) {
  try {
    const h = readHistory().filter((x) => x.sql !== sql);
    localStorage.setItem(HISTORY_KEY, JSON.stringify([{ sql, at: Date.now() }, ...h].slice(0, 50)));
  } catch {
    /* storage unavailable */
  }
}

export function QueryTab({ tab }: { tab: Tab }) {
  const conn = useConnection(tab.connId);
  const session = useStore((s) => s.sessions[tab.connId]);
  const schema = useSchema(tab.connId, tab.database)?.data;
  const updateTab = useStore((s) => s.updateTab);
  const openMenu = useContextMenu();
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [active, setActive] = useState(0);
  /** Graphical plan; shown in the result area when `active === PLAN_TAB`. */
  const [plan, setPlan] = useState<{ root: PlanNode; analyzed: boolean } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [split, setSplit] = useState(42);
  const containerRef = useRef<HTMLDivElement>(null);
  const kind = conn?.kind ?? 'sqlite';
  const sql = tab.sql ?? '';

  const [confirm, setConfirm] = useState<{ sql: string; items: string[] } | null>(null);

  const execute = useCallback(
    async (text: string, confirmed = false) => {
      if (!text.trim()) return;
      setRunning(true);
      setError(null);
      try {
        const r = await api.query(tab.connId, tab.database, text, { confirmed });
        setResult(r);
        const firstGrid = r.results.findIndex((x) => x.columns.length);
        setActive(firstGrid >= 0 ? firstGrid : r.results.length);
        pushHistory(text);
        if (!/^\s*(SELECT|WITH|EXPLAIN|PRAGMA|SHOW)\b/i.test(text)) void refreshSchema(tab.connId, tab.database);
      } catch (e) {
        const err = e as ApiError;
        if (err.code === 'CONFIRM_REQUIRED') {
          setConfirm({ sql: text, items: (err.details as string[]) ?? [] });
          return;
        }
        setError(err.message);
        setResult(null);
      } finally {
        setRunning(false);
      }
    },
    [tab.connId, tab.database],
  );

  const selectedText = () => {
    const view = editorRef.current?.view;
    if (!view) return sql;
    const sel = view.state.selection.main;
    return sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to);
  };

  const run = useCallback(() => void execute(selectedText()), [execute, sql]); // eslint-disable-line react-hooks/exhaustive-deps

  const explain = async (analyze: boolean) => {
    const text = selectedText();
    if (!text.trim()) return;
    setPlanning(true);
    try {
      const raw = await api.explain(tab.connId, tab.database, text, analyze);
      setPlan({ root: normalizePlan(raw), analyzed: analyze });
      setError(null);
      setActive(PLAN_TAB);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlanning(false);
    }
  };

  const format = () => {
    try {
      updateTab(tab.id, { sql: formatSql(sql, { language: FORMAT_LANG[kind], keywordCase: 'upper', tabWidth: 2 }) });
    } catch (e) {
      useStore.getState().toast(`Cannot format: ${(e as Error).message}`, 'error');
    }
  };

  const showHistory = (e: React.MouseEvent) => {
    const h = readHistory();
    openMenu(
      e,
      h.length
        ? h.slice(0, 15).map((x) => ({
            label: x.sql.replace(/\s+/g, ' ').slice(0, 70),
            icon: <Clock className="size-3.5" />,
            hint: new Date(x.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            onClick: () => updateTab(tab.id, { sql: x.sql }),
          }))
        : [{ label: 'No history yet', disabled: true }],
    );
  };

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = containerRef.current!.getBoundingClientRect();
    const move = (ev: MouseEvent) => setSplit(Math.max(15, Math.min(85, ((ev.clientY - rect.top) / rect.height) * 100)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const grids = result?.results ?? [];
  const current = grids[active];
  const exportAs = async (type: 'csv' | 'json') => {
    if (!current) return;
    const content = type === 'csv' ? toCsv(current.columns, current.rows) : toJson(current.columns, current.rows);
    if (await api.saveTextFile(`result.${type}`, content)) useStore.getState().toast('Exported', 'success');
  };

  return (
    <div ref={containerRef} className="flex h-full flex-col">
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={`Production: ${conn?.name ?? ''}`}
        icon={<ShieldAlert className="size-4 text-danger" />}
        width={560}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="danger"
              icon={<Play className="size-3.5" />}
              onClick={() => {
                const c = confirm!;
                setConfirm(null);
                void execute(c.sql, true);
              }}
            >
              Run anyway
            </Button>
          </>
        }
      >
        <p className="mb-3 text-[13px] text-muted">This script contains statements that can remove or overwrite a lot of data:</p>
        <ul className="space-y-1.5">
          {confirm?.items.map((it, i) => (
            <li key={i} className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-2.5 py-1.5 font-mono text-xs text-rose-100">
              {it}
            </li>
          ))}
        </ul>
      </Modal>
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Button variant="primary" icon={<Play className="size-3.5 fill-current" />} loading={running} onClick={run}>
          Run
        </Button>
        <span className="hidden items-center gap-1 text-[11px] text-faint lg:flex">
          <Kbd>⌘/Ctrl</Kbd>+<Kbd>Enter</Kbd>
        </span>
        <div className="mx-1 h-5 w-px bg-line" />
        <IconButton label="Estimated execution plan" disabled={planning} onClick={() => void explain(false)}>
          <Microscope className="size-4" />
        </IconButton>
        <IconButton label="Actual execution plan (runs the query — read queries only)" disabled={planning} onClick={() => void explain(true)}>
          <Gauge className="size-4" />
        </IconButton>
        <IconButton label="Format SQL" onClick={format}>
          <AlignLeft className="size-4" />
        </IconButton>
        <IconButton label="History" onClick={showHistory}>
          <History className="size-4" />
        </IconButton>
        <Button
          size="sm"
          variant="ghost"
          icon={<Cable className="size-3.5" />}
          title="Publish this query as a REST endpoint (use :name for parameters)"
          disabled={!sql.trim()}
          onClick={() => useStore.getState().editEndpoint({ connId: tab.connId, database: tab.database, sql: selectedText().trim() })}
        >
          Publish as API
        </Button>
        <div className="flex-1" />
        {kind !== 'sqlite' && session?.databases.length ? (
          <Select
            value={tab.database}
            onChange={(e) => updateTab(tab.id, { database: e.target.value })}
            className="h-7 max-w-[220px] text-xs"
            title="Database"
          >
            {session.databases.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </Select>
        ) : null}
      </div>

      {/* Editor */}
      <div style={{ height: `${split}%` }} className="min-h-0 bg-black/15">
        <SqlEditor
          ref={editorRef}
          value={sql}
          onChange={(v) => updateTab(tab.id, { sql: v })}
          kind={kind}
          schema={schema}
          onRun={run}
          placeholder="-- Write SQL here. Run everything, or select a statement and run just that."
        />
      </div>

      <div onMouseDown={startDrag} className="group relative h-1.5 shrink-0 cursor-row-resize border-y border-line bg-white/[0.02]">
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-accent/0 transition-colors group-hover:bg-accent/70 group-hover:shadow-[0_0_10px_rgb(129_140_248/0.8)]" />
      </div>

      {/* Results */}
      <div className="flex min-h-0 flex-1 flex-col">
        {(result || error || plan) && (
          <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
            {grids.map((g, i) =>
              g.columns.length ? (
                <ResultTabButton key={i} active={active === i} onClick={() => setActive(i)}>
                  Result {grids.slice(0, i + 1).filter((x) => x.columns.length).length}
                  <span className="text-faint">{formatNumber(g.rowCount)}</span>
                </ResultTabButton>
              ) : null,
            )}
            {result && (
              <ResultTabButton active={active === grids.length && !error} onClick={() => setActive(grids.length)}>
                Messages
              </ResultTabButton>
            )}
            {plan && (
              <ResultTabButton active={active === PLAN_TAB && !error} onClick={() => (setActive(PLAN_TAB), setError(null))}>
                <Microscope className="size-3" /> {plan.analyzed ? 'Actual plan' : 'Plan'}
              </ResultTabButton>
            )}
            <div className="flex-1" />
            {current?.truncated && <span className="text-[11px] text-warn">Showing first {formatNumber(current.rowCount)} rows</span>}
            {result && (
              <span className="flex items-center gap-1 text-[11px] text-muted">
                <Clock className="size-3" /> {formatMs(result.durationMs)}
              </span>
            )}
            {current?.columns.length ? (
              <>
                <IconButton label="Export CSV" onClick={() => void exportAs('csv')}>
                  <FileSpreadsheet className="size-3.5" />
                </IconButton>
                <IconButton label="Export JSON" onClick={() => void exportAs('json')}>
                  <Braces className="size-3.5" />
                </IconButton>
              </>
            ) : null}
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          <AnimatePresence mode="wait">
            {error ? (
              <motion.div key="err" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring} className="p-4">
                <div className="flex gap-3 rounded-xl border border-rose-400/30 bg-rose-500/10 p-3.5 shadow-[0_0_30px_-12px_rgb(251_113_133/0.7)]">
                  <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
                  <pre className="font-mono text-xs whitespace-pre-wrap text-rose-100">{error}</pre>
                </div>
              </motion.div>
            ) : active === PLAN_TAB && plan ? (
              <motion.div key={`plan-${plan.root.id}-${plan.analyzed}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full">
                <PlanView root={plan.root} analyzed={plan.analyzed} />
              </motion.div>
            ) : current?.columns.length ? (
              <motion.div key={`grid-${active}-${result?.durationMs}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full">
                <DataGrid columns={current.columns} rowCount={current.rows.length} getValue={(r, c) => current.rows[r][c]} />
              </motion.div>
            ) : result ? (
              <motion.div key="msg" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-1 p-4 font-mono text-xs text-muted">
                {result.messages.length ? result.messages.map((m, i) => <div key={i}>{m}</div>) : <div>Query executed successfully.</div>}
                <div className="pt-2 text-ok">✓ Completed in {formatMs(result.durationMs)}</div>
              </motion.div>
            ) : (
              <EmptyState key="empty" icon={<TerminalSquare className="size-6" />} title="Ready">
                Results appear here. Multiple statements produce multiple result tabs.
              </EmptyState>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function ResultTabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn('relative flex h-6 items-center gap-1.5 rounded-md px-2 text-xs transition-colors', active ? 'text-fg' : 'text-muted hover:text-fg')}
    >
      {active && <motion.span layoutId="result-tab" transition={spring} className="absolute inset-0 rounded-md bg-accent-soft ring-1 ring-accent/30" />}
      <span className="relative flex items-center gap-1.5">{children}</span>
    </button>
  );
}
