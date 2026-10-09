import { motion } from 'motion/react';
import { ArrowRight, Columns2, Equal, Minus, Play, Plus, Rows3 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { qualify, quoteIdent, sqlLiteral } from '../../../shared/dialect';
import type { DbKind, SchemaSnapshot, TableInfo } from '../../../shared/types';
import { api } from '../../lib/api';
import { useStore, type Tab } from '../../lib/store';
import { cn, formatNumber, nodeId } from '../../lib/utils';
import { DataGrid } from '../DataGrid';
import { DbPicker, type DbTarget } from '../DbPicker';
import { Badge, Button, Checkbox, EmptyState, Segmented, Select, softSpring } from '../ui';

const MAX_ROWS = 50_000;
const PAGE = 5000;

interface Side extends DbTarget {
  table: string;
}

type View = 'different' | 'onlyA' | 'onlyB' | 'same';

interface Result {
  columns: string[];
  key: string[];
  aRows: Map<string, unknown[]>;
  bRows: Map<string, unknown[]>;
  different: string[];
  onlyA: string[];
  onlyB: string[];
  same: number;
  truncated: boolean;
  bTable: TableInfo;
  bKind: DbKind;
}

async function fetchAll(side: Side, t: TableInfo, columns: string[]): Promise<{ rows: unknown[][]; truncated: boolean }> {
  const rows: unknown[][] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const r = await api.rows(side.connId, side.database, { table: t, offset, limit: PAGE, columns, noCount: true, orderBy: t.primaryKey[0] });
    rows.push(...r.rows);
    if (r.rows.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

const DECIMAL = /^-?\d+\.\d+$/;
/**
 * Value equality across drivers: some return decimals as numbers (1.5), others as strings ("1.50").
 * Compare numerically when either side is a number or both are decimal strings; text like "007" stays text.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === 'number' || typeof b === 'number' || (DECIMAL.test(String(a)) && DECIMAL.test(String(b)))) {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  }
  return String(a) === String(b);
}

function TablePicker({ side, onChange, label }: { side: Side; onChange: (s: Side) => void; label: string }) {
  const [schema, setSchema] = useState<SchemaSnapshot | null>(null);
  useEffect(() => {
    setSchema(null);
    if (side.connId && side.database) void api.schema(side.connId, side.database).then(setSchema).catch(() => {});
  }, [side.connId, side.database]);
  return (
    <div className="flex items-center gap-2">
      <DbPicker label={label} value={side} onChange={(v) => onChange({ ...v, table: '' })} />
      <Select value={side.table} onChange={(e) => onChange({ ...side, table: e.target.value })} className="h-8 w-44 text-xs" disabled={!schema} aria-label={`${label} table`}>
        <option value="">Table…</option>
        {schema?.tables.filter((t) => t.type === 'table').map((t) => (
          <option key={nodeId(t)}>{nodeId(t)}</option>
        ))}
      </Select>
    </div>
  );
}

export function DataCompareTab({ tab }: { tab: Tab }) {
  const [a, setA] = useState<Side>({ connId: tab.connId, database: tab.database, table: tab.table ? nodeId(tab.table) : '' });
  const [b, setB] = useState<Side>({ connId: '', database: '', table: '' });
  const [res, setRes] = useState<Result | null>(null);
  const [view, setView] = useState<View>('different');
  const [withDeletes, setWithDeletes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const [sa, sb] = await Promise.all([api.schema(a.connId, a.database), api.schema(b.connId, b.database)]);
      const ta = sa.tables.find((t) => nodeId(t) === a.table);
      const tb = sb.tables.find((t) => nodeId(t) === b.table);
      if (!ta || !tb) throw new Error('Choose both tables');
      const key = ta.primaryKey;
      if (!key.length) throw new Error(`${ta.name} has no primary key — rows cannot be matched`);
      const bCols = new Set(tb.columns.map((c) => c.name));
      if (!key.every((k) => bCols.has(k))) throw new Error(`${tb.name} does not have the key column(s) ${key.join(', ')}`);
      const columns = ta.columns.map((c) => c.name).filter((c) => bCols.has(c));
      const [ra, rb] = await Promise.all([fetchAll(a, ta, columns), fetchAll(b, tb, columns)]);
      const kIdx = key.map((k) => columns.indexOf(k));
      const kOf = (r: unknown[]) => JSON.stringify(kIdx.map((i) => (r[i] === null ? null : String(r[i]))));
      const aRows = new Map(ra.rows.map((r) => [kOf(r), r]));
      const bRows = new Map(rb.rows.map((r) => [kOf(r), r]));
      const different: string[] = [];
      const onlyA: string[] = [];
      let sameCount = 0;
      for (const [k, r] of aRows) {
        const o = bRows.get(k);
        if (!o) onlyA.push(k);
        else if (r.some((v, i) => !same(v, o[i]))) different.push(k);
        else sameCount++;
      }
      const onlyB = [...bRows.keys()].filter((k) => !aRows.has(k));
      setRes({ columns, key, aRows, bRows, different, onlyA, onlyB, same: sameCount, truncated: ra.truncated || rb.truncated, bTable: tb, bKind: sb.kind });
      setView(different.length ? 'different' : onlyA.length ? 'onlyA' : onlyB.length ? 'onlyB' : 'same');
    } catch (e) {
      setError((e as Error).message);
      setRes(null);
    } finally {
      setBusy(false);
    }
  };

  const keys = res ? (view === 'different' ? res.different : view === 'onlyA' ? res.onlyA : view === 'onlyB' ? res.onlyB : []) : [];

  /** SQL that makes B match A (literal values, reviewed before running). */
  const syncSql = useMemo(() => {
    if (!res) return '';
    const k = res.bKind;
    const t = qualify(k, res.bTable);
    const q = (c: string) => quoteIdent(k, c);
    const where = (r: unknown[]) => res.key.map((c) => `${q(c)} = ${sqlLiteral(k, r[res.columns.indexOf(c)])}`).join(' AND ');
    const lines: string[] = [];
    for (const key of res.onlyA) {
      const r = res.aRows.get(key)!;
      lines.push(`INSERT INTO ${t} (${res.columns.map(q).join(', ')}) VALUES (${r.map((v) => sqlLiteral(k, v)).join(', ')});`);
    }
    for (const key of res.different) {
      const r = res.aRows.get(key)!;
      const o = res.bRows.get(key)!;
      const set = res.columns.filter((c, i) => !res.key.includes(c) && !same(r[i], o[i])).map((c) => `${q(c)} = ${sqlLiteral(k, r[res.columns.indexOf(c)])}`);
      if (set.length) lines.push(`UPDATE ${t} SET ${set.join(', ')} WHERE ${where(r)};`);
    }
    if (withDeletes) for (const key of res.onlyB) lines.push(`DELETE FROM ${t} WHERE ${where(res.bRows.get(key)!)};`);
    return lines.join('\n');
  }, [res, withDeletes]);

  const stat = (v: View, label: string, n: number, icon: React.ReactNode, tone: string) => (
    <motion.button
      whileHover={{ scale: 1.03 }}
      onClick={() => setView(v)}
      className={cn('glass flex items-center gap-2.5 rounded-xl px-3 py-2 text-left', view === v && 'border-accent/50 shadow-[0_0_20px_-8px_rgb(129_140_248/0.9)]')}
    >
      <span className={tone}>{icon}</span>
      <div>
        <div className="text-[18px] font-semibold tabular-nums">{formatNumber(n)}</div>
        <div className="text-[11px] text-muted">{label}</div>
      </div>
    </motion.button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <Columns2 className="size-5 text-accent" />
        <div className="mr-2 text-[15px] font-semibold">Data compare</div>
        <TablePicker side={a} onChange={setA} label="A" />
        <ArrowRight className="size-4 text-faint" />
        <TablePicker side={b} onChange={setB} label="B" />
        <Button variant="primary" loading={busy} disabled={!a.table || !b.table} onClick={() => void run()}>
          Compare
        </Button>
      </div>
      {error && <div className="m-4 rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-xs text-rose-100">{error}</div>}
      {!res ? (
        <EmptyState icon={<Rows3 className="size-6" />} title="Compare the rows of two tables">
          Rows are matched by A’s primary key; only columns present in both tables are compared (up to {formatNumber(MAX_ROWS)} rows per side).
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={softSpring} className="flex flex-wrap items-center gap-2 px-4 py-3">
            {stat('different', 'different', res.different.length, <Columns2 className="size-4" />, 'text-warn')}
            {stat('onlyA', 'only in A', res.onlyA.length, <Plus className="size-4" />, 'text-ok')}
            {stat('onlyB', 'only in B', res.onlyB.length, <Minus className="size-4" />, 'text-danger')}
            {stat('same', 'identical', res.same, <Equal className="size-4" />, 'text-muted')}
            {res.truncated && <Badge tone="warn">compared the first {formatNumber(MAX_ROWS)} rows</Badge>}
            <div className="flex-1" />
            <Checkbox checked={withDeletes} onChange={setWithDeletes} label="Sync also deletes rows only in B" />
            <Button
              icon={<Play className="size-3.5" />}
              disabled={!syncSql}
              onClick={() =>
                useStore.getState().confirmSql({
                  connId: b.connId,
                  database: b.database,
                  title: `Sync ${b.table} with ${a.table}`,
                  sql: syncSql,
                  danger: withDeletes && res.onlyB.length > 0,
                  onDone: () => void run(),
                })
              }
            >
              Sync B from A…
            </Button>
          </motion.div>
          <div className="mx-4 mb-2">
            <Segmented
              layoutId="dc-view"
              value={view}
              onChange={setView}
              options={[
                { value: 'different', label: 'Different' },
                { value: 'onlyA', label: 'Only in A' },
                { value: 'onlyB', label: 'Only in B' },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 border-t border-line">
            {view === 'same' || !keys.length ? (
              <EmptyState icon={<Equal className="size-6" />} title="Nothing here" />
            ) : (
              <DataGrid
                columns={res.columns}
                rowCount={keys.length}
                getValue={(r, c) => {
                  const k = keys[r];
                  if (view === 'onlyB') return res.bRows.get(k)![c];
                  const av = res.aRows.get(k)![c];
                  if (view === 'different') {
                    const bv = res.bRows.get(k)![c];
                    return same(av, bv) ? av : `${bv ?? 'NULL'} → ${av ?? 'NULL'}`;
                  }
                  return av;
                }}
                isEdited={(r, c) => view === 'different' && !same(res.aRows.get(keys[r])![c], res.bRows.get(keys[r])![c])}
                meta={(c) => ({ pk: res.key.includes(res.columns[c]) })}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

