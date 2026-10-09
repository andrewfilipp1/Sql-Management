import { motion } from 'motion/react';
import { FileUp, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { CsvPreview } from '../../../shared/ipc';
import { openTable, refreshSchema } from '../../lib/actions';
import { api } from '../../lib/api';
import { useConnection, useSchema, useStore } from '../../lib/store';
import { findTable, formatNumber, nodeId } from '../../lib/utils';
import { DataGrid } from '../DataGrid';
import { Badge, Button, Checkbox, Field, Input, Modal, Segmented, Select, spring } from '../ui';

type Mode = 'existing' | 'new';

const safeName = (s: string) => s.trim().replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '') || 'column';

export function ImportDialog() {
  const d = useStore((s) => s.dbDialog);
  const open = d?.kind === 'import';
  const close = () => useStore.getState().openDbDialog(null);
  const conn = useConnection(d?.connId ?? '');
  const schema = useSchema(d?.connId ?? '', d?.database ?? '')?.data;
  const [csv, setCsv] = useState<CsvPreview | null>(null);
  const [mode, setMode] = useState<Mode>('existing');
  const [tableId, setTableId] = useState('');
  const [newName, setNewName] = useState('');
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [newCols, setNewCols] = useState<{ name: string; include: boolean }[]>([]);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tables = useMemo(() => (schema?.tables ?? []).filter((t) => t.type === 'table'), [schema]);
  const target = tables.find((t) => nodeId(t) === tableId);

  useEffect(() => {
    if (!open) return;
    setCsv(null);
    setError(null);
    setMode(d?.table ? 'existing' : 'new');
    setTableId(d?.table ? nodeId(d.table) : '');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-map CSV headers to the target table's columns by (case-insensitive) name.
  useEffect(() => {
    if (!csv || !target) return;
    const m: Record<string, number | null> = {};
    for (const c of target.columns) {
      const i = csv.headers.findIndex((h) => h.trim().toLowerCase() === c.name.toLowerCase());
      m[c.name] = i >= 0 ? i : null;
    }
    setMapping(m);
  }, [csv, target]);

  const choose = async () => {
    setError(null);
    try {
      const p = await api.pickCsv();
      if (!p) return;
      setCsv(p);
      setNewName(safeName(p.fileName.replace(/\.[^.]+$/, '')).toLowerCase());
      setNewCols(p.headers.map((h) => ({ name: safeName(h), include: true })));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const run = async () => {
    if (!d || !csv) return;
    setBusy(true);
    setError(null);
    try {
      const req =
        mode === 'existing'
          ? { token: csv.token, connId: d.connId, database: d.database, table: target && { schema: target.schema, name: target.name }, mapping, emptyAsNull }
          : {
              token: csv.token,
              connId: d.connId,
              database: d.database,
              createTable: { schema: conn?.kind === 'postgres' ? 'public' : conn?.kind === 'mssql' ? 'dbo' : undefined, name: newName },
              mapping: Object.fromEntries(newCols.map((c, i) => [c.name, c.include ? i : null])),
              emptyAsNull,
            };
      const r = await api.importCsv(req);
      useStore.getState().toast(`Imported ${formatNumber(r.inserted)} rows into ${r.table.name}`, 'success');
      await refreshSchema(d.connId, d.database);
      close();
      openTable(d.connId, d.database, r.table, 'data');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const mapped = mode === 'existing' ? Object.values(mapping).filter((v) => v !== null).length : newCols.filter((c) => c.include).length;

  return (
    <Modal
      open={open}
      onClose={close}
      title="Import CSV"
      icon={<FileUp className="size-4" />}
      width={880}
      footer={
        <>
          {error && <span className="mr-auto line-clamp-2 font-mono text-xs text-danger">{error}</span>}
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            icon={<Upload className="size-3.5" />}
            loading={busy}
            disabled={!csv || !mapped || (mode === 'existing' ? !target : !newName.trim())}
            onClick={() => void run()}
          >
            Import {csv ? formatNumber(csv.rowCount) : ''} rows
          </Button>
        </>
      }
    >
      {!csv ? (
        <motion.button
          whileHover={{ scale: 1.01 }}
          transition={spring}
          onClick={() => void choose()}
          className="flex w-full flex-col items-center gap-3 rounded-2xl border border-dashed border-line-strong p-10 text-muted hover:border-accent/50 hover:text-fg hover:shadow-[0_0_30px_-12px_rgb(129_140_248/0.8)]"
        >
          <FileUp className="size-8 text-accent" />
          <span className="text-[14px] font-medium">Choose a CSV file</span>
          <span className="text-xs text-faint">Comma, semicolon, tab or pipe separated · first row is the header · up to 200 MB</span>
        </motion.button>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="font-medium">{csv.fileName}</span>
            <Badge>{formatNumber(csv.rowCount)} rows</Badge>
            <Badge>{csv.headers.length} columns</Badge>
            <Badge>separator “{csv.delimiter === '\t' ? 'tab' : csv.delimiter}”</Badge>
            <Button size="sm" variant="ghost" onClick={() => void choose()}>
              Choose another file
            </Button>
          </div>

          <div className="h-40 overflow-hidden rounded-xl border border-line">
            <DataGrid columns={csv.headers} rowCount={csv.preview.length} getValue={(r, c) => csv.preview[r][c]} meta={(c) => ({ type: csv.types[c] })} />
          </div>

          <Segmented<Mode>
            layoutId="import-mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'existing', label: 'Into an existing table' },
              { value: 'new', label: 'Create a new table' },
            ]}
          />

          {mode === 'existing' ? (
            <div className="space-y-3">
              <Field label="Table">
                <Select value={tableId} onChange={(e) => setTableId(e.target.value)}>
                  <option value="">Choose…</option>
                  {tables.map((t) => (
                    <option key={nodeId(t)} value={nodeId(t)}>
                      {nodeId(t)}
                    </option>
                  ))}
                </Select>
              </Field>
              {target && (
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                  {target.columns.map((c) => (
                    <div key={c.name} className="flex items-center gap-2">
                      <span className="w-40 truncate font-mono text-[12px]" title={c.type}>
                        {c.name}
                        {c.isIdentity && <span className="text-faint"> (auto)</span>}
                      </span>
                      <span className="text-faint">←</span>
                      <Select
                        value={mapping[c.name] ?? ''}
                        onChange={(e) => setMapping({ ...mapping, [c.name]: e.target.value === '' ? null : Number(e.target.value) })}
                        className="h-7 flex-1 text-xs"
                      >
                        <option value="">— skip —</option>
                        {csv.headers.map((h, i) => (
                          <option key={i} value={i}>
                            {h}
                          </option>
                        ))}
                      </Select>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <Field label="New table name">
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} className="font-mono" />
              </Field>
              <div className="grid grid-cols-3 gap-2">
                {newCols.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-lg border border-line px-2 py-1">
                    <input
                      type="checkbox"
                      checked={c.include}
                      onChange={(e) => setNewCols(newCols.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))}
                      className="accent-indigo-400"
                      aria-label={`Include ${c.name}`}
                    />
                    <Input
                      value={c.name}
                      onChange={(e) => setNewCols(newCols.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                      className="h-6 border-0 bg-transparent px-1 font-mono text-xs"
                    />
                    <span className="text-[10.5px] text-faint">{csv.types[i]}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <Checkbox checked={emptyAsNull} onChange={setEmptyAsNull} label="Treat empty cells as NULL" />
          {schema && d?.table && !findTable(schema, d.table) && <p className="text-xs text-warn">The preselected table no longer exists.</p>}
        </div>
      )}
    </Modal>
  );
}
