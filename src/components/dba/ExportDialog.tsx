import { FileDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useSchema, useStore } from '../../lib/store';
import { formatNumber, nodeId } from '../../lib/utils';
import { Button, Checkbox, Field, Modal, Segmented } from '../ui';

export function ExportDialog() {
  const d = useStore((s) => s.dbDialog);
  const open = d?.kind === 'export';
  const close = () => useStore.getState().openDbDialog(null);
  const schema = useSchema(d?.connId ?? '', d?.database ?? '')?.data;
  const [withData, setWithData] = useState<'schema' | 'data'>('schema');
  const [picked, setPicked] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tables = (schema?.tables ?? []).filter((t) => t.type === 'table');

  useEffect(() => {
    if (open) {
      setPicked(d?.table ? [nodeId(d.table)] : null);
      setError(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    if (!d) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.exportScript(d.connId, d.database, { includeData: withData === 'data', tables: picked ?? undefined });
      if (r) {
        useStore.getState().toast(`Saved ${r.tables} tables${withData === 'data' ? `, ${formatNumber(r.rows)} rows` : ''} to ${r.file}`, 'success');
        close();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Generate scripts"
      icon={<FileDown className="size-4" />}
      width={560}
      footer={
        <>
          {error && <span className="mr-auto line-clamp-2 text-xs text-danger">{error}</span>}
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={picked !== null && !picked.length} onClick={() => void run()}>
            Save .sql file
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[13px] text-muted">
          Writes a SQL script that recreates the tables (in dependency order), indexes, foreign keys and views — optionally with all rows
          as INSERT statements. Binary columns are written as hex text.
        </p>
        <Segmented
          layoutId="export-mode"
          value={withData}
          onChange={setWithData}
          options={[
            { value: 'schema', label: 'Schema only' },
            { value: 'data', label: 'Schema and data' },
          ]}
        />
        <Field label="Tables">
          <div className="space-y-1.5">
            <Checkbox checked={picked === null} onChange={(v) => setPicked(v ? null : [])} label={`All tables (${tables.length})`} />
            {picked !== null && (
              <div className="grid max-h-56 grid-cols-2 gap-1.5 overflow-auto rounded-lg border border-line p-2">
                {tables.map((t) => (
                  <Checkbox
                    key={nodeId(t)}
                    checked={picked.includes(nodeId(t))}
                    onChange={(v) => setPicked(v ? [...picked, nodeId(t)] : picked.filter((x) => x !== nodeId(t)))}
                    label={<span className="font-mono text-xs">{nodeId(t)}</span>}
                  />
                ))}
              </div>
            )}
          </div>
        </Field>
      </div>
    </Modal>
  );
}
