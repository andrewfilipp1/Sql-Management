import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  CheckCircle2,
  FileDown,
  LineChart,
  Loader2,
  NotebookPen,
  Pilcrow,
  Play,
  PlayCircle,
  Plus,
  ShieldAlert,
  Table2,
  Terminal,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NOTEBOOK_ROWS, type CellOutput, type Notebook, type NotebookCell } from '../../../shared/notebook';
import { refreshSchema } from '../../lib/actions';
import { api, type ApiError } from '../../lib/api';
import { renderMarkdown } from '../../lib/markdown';
import { useConnection, useSchema, useStore, type Tab } from '../../lib/store';
import { cn, formatMs, formatNumber, uid } from '../../lib/utils';
import { DataGrid } from '../DataGrid';
import { SqlEditor } from '../SqlEditor';
import { Button, EmptyState, IconButton, Modal, Select, Spinner, spring } from '../ui';
import { numericColumns, ResultChart } from './ResultChart';

type RunState = 'running' | 'done' | 'failed';

export function NotebookTab({ tab }: { tab: Tab }) {
  const [nb, setNb] = useState<Notebook | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runState, setRunState] = useState<Record<string, RunState>>({});
  const [editingMd, setEditingMd] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ items: string[]; resolve: (ok: boolean) => void } | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);
  const [runningAll, setRunningAll] = useState(false);
  const conn = useConnection(nb?.connId ?? '');
  const session = useStore((s) => (nb ? s.sessions[nb.connId] : undefined));
  const schema = useSchema(nb?.connId ?? '', nb?.database ?? '')?.data;
  const nbRef = useRef<Notebook | null>(null);
  nbRef.current = nb;

  useEffect(() => {
    if (!tab.notebookId) return;
    api.getNotebook(tab.notebookId).then(
      (n) => {
        setNb(n);
        if (n.connId) void useStore.getState().connect(n.connId).then(() => useStore.getState().ensureSchema(n.connId, n.database));
      },
      (e: Error) => setLoadError(e.message),
    );
  }, [tab.notebookId]);

  // Autosave shortly after the last change.
  const dirty = useRef(false);
  useEffect(() => {
    if (!nb || !dirty.current) return;
    const t = setTimeout(() => {
      dirty.current = false;
      api.saveNotebook(nb).catch((e: Error) => useStore.getState().toast(`Notebook not saved: ${e.message}`, 'error'));
    }, 700);
    return () => clearTimeout(t);
  }, [nb]);

  const change = useCallback((fn: (n: Notebook) => Notebook) => {
    dirty.current = true;
    setNb((n) => (n ? fn(n) : n));
  }, []);
  const setCell = (id: string, patch: Partial<NotebookCell>) => change((n) => ({ ...n, cells: n.cells.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));

  const addCell = (kind: NotebookCell['kind'], after?: string) => {
    const cell: NotebookCell = { id: uid(), kind, source: '' };
    change((n) => {
      const i = after ? n.cells.findIndex((c) => c.id === after) + 1 : n.cells.length;
      const cells = [...n.cells];
      cells.splice(i, 0, cell);
      return { ...n, cells };
    });
    if (kind === 'markdown') setEditingMd(cell.id);
  };
  const move = (id: string, d: -1 | 1) =>
    change((n) => {
      const i = n.cells.findIndex((c) => c.id === id);
      const j = i + d;
      if (j < 0 || j >= n.cells.length) return n;
      const cells = [...n.cells];
      [cells[i], cells[j]] = [cells[j], cells[i]];
      return { ...n, cells };
    });
  const remove = (id: string) => change((n) => ({ ...n, cells: n.cells.filter((c) => c.id !== id) }));

  const askConfirm = (items: string[]) => new Promise<boolean>((resolve) => setConfirm({ items, resolve }));

  /** Runs one SQL cell; resolves false when it failed (so Run all can stop). */
  const runCell = useCallback(async (id: string): Promise<boolean> => {
    const n = nbRef.current;
    const cell = n?.cells.find((c) => c.id === id);
    if (!n || !cell || cell.kind !== 'sql' || !cell.source.trim()) return true;
    setRunState((s) => ({ ...s, [id]: 'running' }));
    const started = performance.now();
    let output: CellOutput;
    const attempt = (confirmed: boolean) => api.query(n.connId, n.database, cell.source, { confirmed });
    try {
      let r;
      try {
        r = await attempt(false);
      } catch (e) {
        const err = e as ApiError;
        if (err.code !== 'CONFIRM_REQUIRED' || !(await askConfirm((err.details as string[]) ?? []))) throw e;
        r = await attempt(true);
      }
      const grid = [...r.results].reverse().find((x) => x.columns.length);
      const affected = r.results.filter((x) => !x.columns.length && x.affectedRows != null).map((x) => `${formatNumber(x.affectedRows)} row(s) affected`);
      output = {
        columns: grid?.columns ?? [],
        rows: grid?.rows.slice(0, NOTEBOOK_ROWS) ?? [],
        rowCount: grid?.rowCount ?? 0,
        truncated: !!grid?.truncated || (grid?.rows.length ?? 0) > NOTEBOOK_ROWS,
        messages: [...r.messages, ...affected],
        durationMs: r.durationMs,
        ranAt: new Date().toISOString(),
      };
      if (!/^\s*(SELECT|WITH|EXPLAIN|PRAGMA|SHOW)\b/i.test(cell.source)) void refreshSchema(n.connId, n.database);
    } catch (e) {
      output = { columns: [], rows: [], rowCount: 0, truncated: false, messages: [], durationMs: performance.now() - started, error: (e as Error).message, ranAt: new Date().toISOString() };
    }
    setCell(id, { output });
    setRunState((s) => ({ ...s, [id]: output.error ? 'failed' : 'done' }));
    return !output.error;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runAll = async () => {
    setRunningAll(true);
    try {
      for (const c of nbRef.current?.cells ?? []) {
        if (c.kind === 'sql' && !(await runCell(c.id))) break;
      }
    } finally {
      setRunningAll(false);
    }
  };

  const rename = async () => {
    const name = await useStore.getState().prompt('Rename notebook', 'Name', nb?.name);
    if (name?.trim()) {
      change((n) => ({ ...n, name: name.trim() }));
      useStore.getState().updateTab(tab.id, { title: name.trim() });
    }
  };

  const exportMarkdown = async () => {
    if (!nb) return;
    const md = [`# ${nb.name}`, ''];
    for (const c of nb.cells) {
      if (c.kind === 'markdown') md.push(c.source, '');
      else {
        md.push('```sql', c.source.trim(), '```', '');
        const o = c.output;
        if (o?.error) md.push(`> Error: ${o.error}`, '');
        else if (o?.columns.length) {
          const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v)).replace(/\|/g, '\\|').replace(/\n/g, ' ');
          md.push(`| ${o.columns.map(cell).join(' | ')} |`, `| ${o.columns.map(() => '---').join(' | ')} |`);
          for (const r of o.rows.slice(0, 50)) md.push(`| ${r.map(cell).join(' | ')} |`);
          if (o.rowCount > 50) md.push('', `_${formatNumber(o.rowCount)} rows, first 50 shown._`);
          md.push('');
        }
      }
    }
    if (await api.saveTextFile(`${nb.name.replace(/[^\w.-]+/g, '_')}.md`, md.join('\n'))) useStore.getState().toast('Exported', 'success');
  };

  const deleteNotebook = async () => {
    if (!nb) return;
    if (!armedDelete) {
      setArmedDelete(true);
      setTimeout(() => setArmedDelete(false), 3000);
      return;
    }
    await api.deleteNotebook(nb.id);
    useStore.getState().closeTab(tab.id);
    useStore.getState().toast(`Deleted “${nb.name}”`, 'info');
  };

  if (loadError) return <EmptyState icon={<XCircle className="size-6" />} title="Cannot open notebook">{loadError}</EmptyState>;
  if (!nb) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  const kind = conn?.kind ?? 'sqlite';

  return (
    <div className="flex h-full flex-col" data-testid="notebook">
      <Modal
        open={!!confirm}
        onClose={() => (confirm?.resolve(false), setConfirm(null))}
        title={`Production: ${conn?.name ?? ''}`}
        icon={<ShieldAlert className="size-4 text-danger" />}
        footer={
          <>
            <Button onClick={() => (confirm?.resolve(false), setConfirm(null))}>Cancel</Button>
            <Button variant="danger" onClick={() => (confirm?.resolve(true), setConfirm(null))}>
              Run anyway
            </Button>
          </>
        }
      >
        <p className="mb-3 text-[13px] text-muted">This cell contains statements that can remove or overwrite a lot of data:</p>
        <ul className="space-y-1.5">
          {confirm?.items.map((it, i) => (
            <li key={i} className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-2.5 py-1.5 font-mono text-xs text-rose-100">
              {it}
            </li>
          ))}
        </ul>
      </Modal>

      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <NotebookPen className="size-4 text-accent" />
        <button className="truncate text-[13px] font-semibold hover:text-accent" onClick={() => void rename()} title="Rename">
          {nb.name}
        </button>
        <span className="truncate text-[11px] text-faint">{conn ? `${conn.name} · ${nb.database}` : 'Connection missing'}</span>
        <div className="flex-1" />
        <Button size="sm" variant="primary" icon={<PlayCircle className="size-3.5" />} loading={runningAll} onClick={() => void runAll()} data-testid="nb-run-all">
          Run all
        </Button>
        <Button size="sm" variant="ghost" icon={<Terminal className="size-3.5" />} onClick={() => addCell('sql')} data-testid="nb-add-sql">
          SQL
        </Button>
        <Button size="sm" variant="ghost" icon={<Pilcrow className="size-3.5" />} onClick={() => addCell('markdown')} data-testid="nb-add-md">
          Text
        </Button>
        {kind !== 'sqlite' && session?.databases.length ? (
          <Select value={nb.database} onChange={(e) => change((n) => ({ ...n, database: e.target.value }))} className="h-7 max-w-[180px] text-xs" title="Database">
            {session.databases.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </Select>
        ) : null}
        <IconButton label="Export as Markdown" onClick={() => void exportMarkdown()}>
          <FileDown className="size-4" />
        </IconButton>
        <IconButton label={armedDelete ? 'Click again to delete this notebook' : 'Delete notebook'} active={armedDelete} onClick={() => void deleteNotebook()}>
          <Trash2 className={cn('size-4', armedDelete && 'text-danger')} />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-5xl space-y-3">
          <AnimatePresence initial={false}>
            {nb.cells.map((c, i) => (
              <motion.div
                key={c.id}
                layout
                initial={{ opacity: 0, y: 14, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: -30, scale: 0.97 }}
                transition={spring}
                className="group relative"
                data-testid="nb-cell"
                data-kind={c.kind}
              >
                <CellCard
                  cell={c}
                  index={i}
                  kind={kind}
                  schema={schema}
                  state={runState[c.id]}
                  editingMd={editingMd === c.id}
                  setEditingMd={(v) => setEditingMd(v ? c.id : null)}
                  onChange={(patch) => setCell(c.id, patch)}
                  onRun={() => void runCell(c.id)}
                  onMove={(d) => move(c.id, d)}
                  onRemove={() => remove(c.id)}
                  onAdd={(k) => addCell(k, c.id)}
                  first={i === 0}
                  last={i === nb.cells.length - 1}
                />
              </motion.div>
            ))}
          </AnimatePresence>
          {!nb.cells.length && (
            <EmptyState icon={<NotebookPen className="size-6" />} title="Empty notebook">
              Add a SQL cell to query, or a text cell for notes.
            </EmptyState>
          )}
          <div className="flex justify-center gap-2 pt-2 opacity-60 transition-opacity hover:opacity-100">
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => addCell('sql')}>
              SQL cell
            </Button>
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => addCell('markdown')}>
              Text cell
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CellCard({
  cell,
  index,
  kind,
  schema,
  state,
  editingMd,
  setEditingMd,
  onChange,
  onRun,
  onMove,
  onRemove,
  onAdd,
  first,
  last,
}: {
  cell: NotebookCell;
  index: number;
  kind: import('../../../shared/types').DbKind;
  schema?: import('../../../shared/types').SchemaSnapshot;
  state?: RunState;
  editingMd: boolean;
  setEditingMd: (v: boolean) => void;
  onChange: (patch: Partial<NotebookCell>) => void;
  onRun: () => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
  onAdd: (k: NotebookCell['kind']) => void;
  first: boolean;
  last: boolean;
}) {
  const tools = (
    <div className="absolute top-1.5 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-line bg-[rgb(14_17_33/0.95)] px-1 opacity-0 shadow-lg transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
      <IconButton label="Move up" className="size-6" disabled={first} onClick={() => onMove(-1)}>
        <ArrowUp className="size-3.5" />
      </IconButton>
      <IconButton label="Move down" className="size-6" disabled={last} onClick={() => onMove(1)}>
        <ArrowDown className="size-3.5" />
      </IconButton>
      <IconButton label="Add SQL cell below" className="size-6" onClick={() => onAdd('sql')}>
        <Terminal className="size-3.5" />
      </IconButton>
      <IconButton label="Add text cell below" className="size-6" onClick={() => onAdd('markdown')}>
        <Pilcrow className="size-3.5" />
      </IconButton>
      <IconButton label="Delete cell" className="size-6" onClick={onRemove}>
        <Trash2 className="size-3.5" />
      </IconButton>
    </div>
  );

  if (cell.kind === 'markdown') {
    return (
      <div className={cn('relative rounded-xl border px-4 py-2.5 transition-colors', editingMd ? 'border-accent/40 bg-white/[0.03]' : 'border-transparent hover:border-line')}>
        {tools}
        {editingMd ? (
          <AutoTextarea value={cell.source} onChange={(v) => onChange({ source: v })} onDone={() => setEditingMd(false)} />
        ) : (
          <div className="min-h-6 cursor-text text-[13.5px] text-fg/90" onDoubleClick={() => setEditingMd(true)} title="Double-click to edit" data-testid="nb-md-view">
            {cell.source.trim() ? renderMarkdown(cell.source) : <span className="text-faint">Empty text cell — double-click to write</span>}
          </div>
        )}
      </div>
    );
  }

  const out = cell.output;
  const numeric = out?.columns.length ? numericColumns(out.columns, out.rows) : [];
  const chartable = !!out && out.columns.length >= 2 && numeric.length > 0;
  const chart = cell.chart;
  const setChart = (k: 'bar' | 'line' | null) =>
    onChange({
      chart: k && out ? { kind: k, x: chart?.x ?? out.columns.find((c) => !numeric.includes(c)) ?? out.columns[0], y: chart?.y ?? numeric.find((c) => c !== out.columns[0]) ?? numeric[0] } : undefined,
    });

  return (
    <div
      className={cn(
        'glass relative overflow-hidden rounded-xl border transition-shadow',
        state === 'running' ? 'border-accent/60 shadow-[0_0_24px_-8px_rgb(129_140_248/0.9)]' : state === 'failed' ? 'border-rose-400/40' : 'border-line',
      )}
    >
      {tools}
      {state === 'running' && (
        <motion.div
          className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-indigo-400 to-transparent"
          initial={{ x: '-100%' }}
          animate={{ x: '100%' }}
          transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      <div className="flex">
        <div className="flex w-12 shrink-0 flex-col items-center gap-1.5 border-r border-line pt-2.5">
          <motion.button
            whileHover={{ scale: 1.12 }}
            whileTap={{ scale: 0.9 }}
            transition={spring}
            onClick={onRun}
            title="Run cell (⌘/Ctrl+Enter)"
            className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-accent ring-1 ring-accent/30 hover:bg-accent/30"
            data-testid="nb-run"
          >
            {state === 'running' ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5 fill-current" />}
          </motion.button>
          <span className="font-mono text-[10px] text-faint">[{index + 1}]</span>
          <AnimatePresence mode="wait">
            {state === 'done' && (
              <motion.span key="ok" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={spring}>
                <CheckCircle2 className="size-3.5 text-ok" />
              </motion.span>
            )}
            {state === 'failed' && (
              <motion.span key="bad" initial={{ scale: 0 }} animate={{ scale: 1, x: [0, -3, 3, -2, 0] }} exit={{ scale: 0 }} transition={{ duration: 0.4 }}>
                <XCircle className="size-3.5 text-danger" />
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <div className="min-w-0 flex-1 bg-black/15">
          <SqlEditor value={cell.source} onChange={(v) => onChange({ source: v })} kind={kind} schema={schema} onRun={onRun} autoHeight placeholder="SELECT …" />
        </div>
      </div>
      <AnimatePresence initial={false}>
        {out && (
          <motion.div key={out.ranAt} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring} className="border-t border-line">
            {out.error ? (
              <div className="flex gap-2 bg-rose-500/10 px-3 py-2.5 font-mono text-xs text-rose-100" data-testid="nb-error">
                <XCircle className="mt-0.5 size-3.5 shrink-0 text-danger" />
                <pre className="whitespace-pre-wrap">{out.error}</pre>
              </div>
            ) : out.columns.length ? (
              <>
                <div className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted">
                  <span>
                    {formatNumber(out.rowCount)} rows · {formatMs(out.durationMs)}
                  </span>
                  {out.truncated && <span className="text-warn">· first {formatNumber(out.rows.length)} kept</span>}
                  <div className="flex-1" />
                  {chartable && (
                    <>
                      <IconButton label="Table" className="size-6" active={!chart} onClick={() => setChart(null)}>
                        <Table2 className="size-3.5" />
                      </IconButton>
                      <IconButton label="Bar chart" className="size-6" active={chart?.kind === 'bar'} onClick={() => setChart('bar')}>
                        <BarChart3 className="size-3.5" />
                      </IconButton>
                      <IconButton label="Line chart" className="size-6" active={chart?.kind === 'line'} onClick={() => setChart('line')}>
                        <LineChart className="size-3.5" />
                      </IconButton>
                    </>
                  )}
                  {chart && (
                    <>
                      <Select value={chart.x} onChange={(e) => onChange({ chart: { ...chart, x: e.target.value } })} className="h-6 max-w-[140px] text-[11px]" title="Labels">
                        {out.columns.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </Select>
                      <Select value={chart.y} onChange={(e) => onChange({ chart: { ...chart, y: e.target.value } })} className="h-6 max-w-[140px] text-[11px]" title="Values">
                        {numeric.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </Select>
                    </>
                  )}
                </div>
                {chart ? (
                  <div data-testid="nb-chart">
                    <ResultChart kind={chart.kind} columns={out.columns} rows={out.rows} x={chart.x} y={chart.y} />
                  </div>
                ) : (
                  <div style={{ height: Math.min(320, 34 + out.rows.length * 28) }} data-testid="nb-grid">
                    <DataGrid columns={out.columns} rowCount={out.rows.length} getValue={(r, c) => out.rows[r][c]} />
                  </div>
                )}
              </>
            ) : (
              <div className="px-3 py-2 font-mono text-xs text-muted">
                {out.messages.length ? out.messages.map((m, i) => <div key={i}>{m}</div>) : 'Done.'}
                <span className="text-ok"> ✓ {formatMs(out.durationMs)}</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AutoTextarea({ value, onChange, onDone }: { value: string; onChange: (v: string) => void; onDone: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  useEffect(() => ref.current?.focus(), []);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onDone}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          onDone();
        }
      }}
      placeholder="# Notes — Markdown: **bold**, *italic*, `code`, lists, [links](https://…)"
      className="block w-full resize-none bg-transparent font-mono text-[12.5px] leading-relaxed outline-none placeholder:text-faint"
      data-testid="nb-md-edit"
    />
  );
}
