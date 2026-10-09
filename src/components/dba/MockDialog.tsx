import { Dices, RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { qualify, quoteIdent } from '../../../shared/dialect';
import { openTable, refreshSchema } from '../../lib/actions';
import { api } from '../../lib/api';
import { conventionalRange, GENERATORS, generateValue, guessGenerator, type ColumnPlan, type GeneratorId } from '../../lib/mock';
import { useConnection, useSchema, useStore } from '../../lib/store';
import { findTable, formatNumber, resolveRef } from '../../lib/utils';
import { DataGrid } from '../DataGrid';
import { Button, Field, Input, Modal, Select, Spinner } from '../ui';

export function MockDialog() {
  const d = useStore((s) => s.dbDialog);
  const open = d?.kind === 'mock';
  const close = () => useStore.getState().openDbDialog(null);
  const conn = useConnection(d?.connId ?? '');
  const schema = useSchema(d?.connId ?? '', d?.database ?? '')?.data;
  const table = schema && d?.table ? findTable(schema, d.table) : undefined;
  const [plans, setPlans] = useState<ColumnPlan[] | null>(null);
  const [count, setCount] = useState(100);
  const [seed, setSeed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Build per-column plans, loading parent keys, existing values and sequence starts.
  useEffect(() => {
    if (!open || !table || !d || !conn || !schema) return;
    setPlans(null);
    setError(null);
    const kind = conn.kind;
    const tbl = qualify(kind, table);
    const q = async (sql: string) => (await api.query(d.connId, d.database, sql)).results[0]?.rows ?? [];
    const distinct = (col: string) =>
      kind === 'mssql' ? `SELECT DISTINCT TOP 50 ${quoteIdent(kind, col)} FROM ${tbl} WHERE ${quoteIdent(kind, col)} IS NOT NULL` : `SELECT DISTINCT ${quoteIdent(kind, col)} FROM ${tbl} WHERE ${quoteIdent(kind, col)} IS NOT NULL LIMIT 50`;
    const uniqueCols = new Set(table.indexes.filter((i) => i.unique && !i.primary && i.columns.length === 1).map((i) => i.columns[0]));
    void (async () => {
      try {
        const out: ColumnPlan[] = [];
        for (const c of table.columns) {
          let gen: GeneratorId = guessGenerator(c, table);
          const p: ColumnPlan = { column: c, gen, unique: uniqueCols.has(c.name) || (c.isPrimaryKey && table.primaryKey.length === 1), nullRate: 0.1 };
          if (gen === 'fk') {
            const fk = table.foreignKeys.find((f) => f.columns.includes(c.name))!;
            const parent = resolveRef(schema, fk.refSchema ?? table.schema, fk.refTable);
            const refCol = fk.refColumns[fk.columns.indexOf(c.name)];
            if (parent) {
              const r = await api.rows(d.connId, d.database, { table: parent, offset: 0, limit: 1000, columns: [refCol], noCount: true });
              p.values = r.rows.map((x) => x[0]);
            }
            if (!p.values?.length) p.gen = c.nullable ? 'null' : 'integer';
          } else if (gen === 'existing') {
            p.values = (await q(distinct(c.name))).map((x) => x[0]);
            if (!p.values.length) p.gen = 'title';
          } else if (gen === 'sequence' || (p.unique && gen === 'integer')) {
            const r = await q(`SELECT MAX(${quoteIdent(kind, c.name)}) FROM ${tbl}`);
            p.start = Number(r[0]?.[0] ?? 0) + 1;
          } else if (gen === 'integer' || gen === 'decimal') {
            // Stay inside the values the column already holds (keeps CHECK constraints such as rating 1–5 happy).
            const r = await q(`SELECT MIN(${quoteIdent(kind, c.name)}), MAX(${quoteIdent(kind, c.name)}) FROM ${tbl}`);
            const [lo, hi] = [r[0]?.[0], r[0]?.[1]];
            p.range = lo != null && hi != null ? [Number(lo), Number(hi)] : conventionalRange(c.name);
          }
          gen = p.gen;
          out.push(p);
        }
        setPlans(out);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [open, table?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = plans?.filter((p) => p.gen !== 'skip') ?? [];
  const preview = useMemo(() => Array.from({ length: 6 }, (_, i) => active.map((p) => generateValue(p, i))), [plans, seed]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d) return null;

  const setGen = (i: number, gen: GeneratorId) => setPlans(plans!.map((p, j) => (j === i ? { ...p, gen } : p)));

  const insert = async () => {
    if (!plans || !table) return;
    setBusy(true);
    setError(null);
    try {
      const columns = active.map((p) => p.column.name);
      let inserted = 0;
      for (let start = 0; start < count; start += 2000) {
        const n = Math.min(2000, count - start);
        const rows = Array.from({ length: n }, (_, k) => active.map((p) => generateValue(p, start + k)));
        inserted += await api.bulkInsert(d.connId, d.database, { schema: table.schema, name: table.name }, columns, rows);
      }
      useStore.getState().toast(`Inserted ${formatNumber(inserted)} generated rows into ${table.name}`, 'success');
      await refreshSchema(d.connId, d.database);
      close();
      openTable(d.connId, d.database, table, 'data');
    } catch (e) {
      setError(`${(e as Error).message} — nothing was inserted. Adjust the generator of that column and try again.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Generate test data — ${table?.name ?? ''}`}
      icon={<Dices className="size-4" />}
      width={860}
      footer={
        <>
          {error && <span className="mr-auto line-clamp-2 font-mono text-xs text-danger">{error}</span>}
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" icon={<Sparkles className="size-3.5" />} loading={busy} disabled={!plans || !active.length || count < 1} onClick={() => void insert()}>
            Insert {formatNumber(count)} rows
          </Button>
        </>
      }
    >
      {conn?.environment === 'production' && (
        <p className="mb-3 rounded-lg border border-rose-400/40 bg-rose-500/15 p-2.5 text-[13px] text-rose-200">This is a production connection — generated rows are real inserts.</p>
      )}
      {!plans ? (
        <div className="flex justify-center p-8">{error ? null : <Spinner />}</div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-end gap-3">
            <Field label="Rows" className="w-32">
              <Input type="number" min={1} max={10000} value={count} onChange={(e) => setCount(Math.max(1, Math.min(10000, Number(e.target.value) || 1)))} />
            </Field>
            <p className="pb-2 text-xs text-muted">Foreign keys use existing parent rows; unique columns get a running suffix. Up to 10,000 rows per run.</p>
          </div>
          <div className="grid max-h-60 grid-cols-2 gap-x-6 gap-y-1.5 overflow-auto">
            {plans.map((p, i) => (
              <div key={p.column.name} className="flex items-center gap-2">
                <span className="w-36 truncate font-mono text-[12px]" title={p.column.type}>
                  {p.column.name}
                </span>
                <Select value={p.gen} onChange={(e) => setGen(i, e.target.value as GeneratorId)} className="h-7 flex-1 text-xs">
                  {GENERATORS.filter((g) => (g.id === 'fk' ? p.values !== undefined : true)).map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="flex-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Preview</span>
              <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => setSeed((s) => s + 1)}>
                Shuffle
              </Button>
            </div>
            <div className="h-48 overflow-hidden rounded-xl border border-line">
              <DataGrid columns={active.map((p) => p.column.name)} rowCount={preview.length} getValue={(r, c) => preview[r][c]} />
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
