import { AnimatePresence, motion } from 'motion/react';
import { Cable, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { EndpointParam, ParamType, SavedEndpoint } from '../../shared/integrations';
import { detectParams } from '../../core/sqlParams';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { DataGrid } from './DataGrid';
import { SqlEditor } from './SqlEditor';
import { Badge, Button, Checkbox, Field, Input, Modal, Select, spring } from './ui';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

type TestResult = Awaited<ReturnType<typeof api.testEndpoint>>;

export function EndpointDialog() {
  const draft = useStore((s) => s.endpointDraft);
  const connections = useStore((s) => s.connections);
  const sessions = useStore((s) => s.sessions);
  const close = () => useStore.getState().editEndpoint(null);
  const [ep, setEp] = useState<SavedEndpoint | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const [testValues, setTestValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);

  useEffect(() => {
    if (!draft) return;
    const conn = connections.find((c) => c.id === draft.connId) ?? connections[0];
    setEp({
      id: draft.id ?? '',
      slug: draft.slug ?? '',
      name: draft.name ?? '',
      description: draft.description ?? '',
      connId: conn?.id ?? '',
      database: draft.database ?? (conn?.kind === 'sqlite' ? 'main' : (sessions[conn?.id ?? '']?.defaultDatabase ?? '')),
      sql: draft.sql ?? '',
      params: draft.params ?? [],
      write: draft.write ?? false,
    });
    setSlugTouched(!!draft.slug);
    setTestValues({});
    setResult(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // Keep the parameter list in sync with the :names used in the SQL, preserving settings.
  const names = useMemo(() => (ep ? detectParams(ep.sql) : []), [ep?.sql]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ep) return;
    const params: EndpointParam[] = names.map(
      (n) => ep.params.find((p) => p.name === n) ?? { name: n, type: /limit|count|id$|offset/i.test(n) ? 'number' : 'string', required: true },
    );
    if (JSON.stringify(params) !== JSON.stringify(ep.params)) setEp({ ...ep, params });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names]);

  if (!ep) return null;
  const conn = connections.find((c) => c.id === ep.connId);
  const dbs = conn?.kind === 'sqlite' ? ['main'] : (sessions[ep.connId]?.databases ?? (ep.database ? [ep.database] : []));
  const patch = (p: Partial<SavedEndpoint>) => setEp({ ...ep, ...p });
  const patchParam = (i: number, p: Partial<EndpointParam>) => patch({ params: ep.params.map((x, j) => (j === i ? { ...x, ...p } : x)) });

  const test = async () => {
    setBusy('test');
    setError(null);
    try {
      setResult(await api.testEndpoint(ep, testValues));
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      const saved = await api.saveEndpoint(ep);
      useStore.getState().toast(`Endpoint /v1/endpoints/${saved.slug} saved`, 'success');
      window.dispatchEvent(new Event('schemascope:integrations-changed'));
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const columns = result?.rows[0] ? Object.keys(result.rows[0]) : [];

  return (
    <Modal
      open={!!draft}
      onClose={close}
      title={ep.id ? 'Edit endpoint' : 'Publish query as endpoint'}
      icon={<Cable className="size-4" />}
      width={860}
      footer={
        <>
          {error && <span className="mr-auto line-clamp-2 font-mono text-xs text-danger">{error}</span>}
          <Button icon={<Play className="size-3.5" />} loading={busy === 'test'} onClick={() => void test()} disabled={!ep.sql.trim()}>
            Test
          </Button>
          <Button variant="primary" loading={busy === 'save'} onClick={() => void save()} disabled={!ep.slug || !ep.sql.trim() || !ep.connId}>
            Save endpoint
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-6 gap-3">
        <Field label="Name" className="col-span-3">
          <Input
            autoFocus
            value={ep.name}
            onChange={(e) => patch({ name: e.target.value, slug: slugTouched ? ep.slug : slugify(e.target.value) })}
            placeholder="Top customers"
          />
        </Field>
        <Field label="URL slug" className="col-span-3" hint={<span className="font-mono">GET /v1/endpoints/{ep.slug || '…'}</span>}>
          <Input
            value={ep.slug}
            onChange={(e) => {
              setSlugTouched(true);
              patch({ slug: slugify(e.target.value) });
            }}
            placeholder="top-customers"
            className="font-mono text-xs"
          />
        </Field>
        <Field label="Connection" className="col-span-3">
          <Select value={ep.connId} onChange={(e) => patch({ connId: e.target.value, database: '' })}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Database" className="col-span-3">
          {dbs.length ? (
            <Select value={ep.database} onChange={(e) => patch({ database: e.target.value })}>
              <option value="">Choose…</option>
              {dbs.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </Select>
          ) : (
            <Input value={ep.database} onChange={(e) => patch({ database: e.target.value })} placeholder="database name" />
          )}
        </Field>
        <Field label="Description" className="col-span-6">
          <Input value={ep.description ?? ''} onChange={(e) => patch({ description: e.target.value })} placeholder="Shown in the OpenAPI document" />
        </Field>
      </div>

      <div className="mt-4 mb-1.5 flex items-center gap-2">
        <span className="flex-1 text-[11px] font-semibold tracking-wider text-muted uppercase">SQL — one statement, parameters as :name</span>
        <Checkbox checked={ep.write} onChange={(v) => patch({ write: v })} label="Modifies data (write keys only)" />
      </div>
      <div className="h-40 overflow-hidden rounded-xl border border-line bg-black/30">
        {conn && <SqlEditor value={ep.sql} onChange={(v) => patch({ sql: v })} kind={conn.kind} />}
      </div>

      <AnimatePresence initial={false}>
        {ep.params.length > 0 && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
            <div className="mt-4 mb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">Parameters</div>
            <div className="space-y-1.5">
              {ep.params.map((p, i) => (
                <div key={p.name} className="grid grid-cols-[1fr_110px_90px_1fr_1fr] items-center gap-2">
                  <span className="font-mono text-[12.5px] text-accent">:{p.name}</span>
                  <Select value={p.type} onChange={(e) => patchParam(i, { type: e.target.value as ParamType })} className="h-7 text-xs">
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                  </Select>
                  <Checkbox checked={p.required} onChange={(v) => patchParam(i, { required: v })} label="required" />
                  <Input value={p.default ?? ''} onChange={(e) => patchParam(i, { default: e.target.value || undefined })} placeholder="default" className="h-7 text-xs" />
                  <Input
                    value={testValues[p.name] ?? ''}
                    onChange={(e) => setTestValues({ ...testValues, [p.name]: e.target.value })}
                    placeholder="test value"
                    className="h-7 border-cyan-400/20 text-xs"
                  />
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {result && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring} className="mt-4">
            <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted">
              <Badge tone="ok">{result.affected !== undefined ? `${result.affected} affected` : `${result.rowCount} rows`}</Badge>
              {result.truncated && <Badge tone="warn">capped at 1000 rows</Badge>}
              <span>{result.durationMs} ms</span>
            </div>
            {columns.length > 0 && (
              <div className="h-48 overflow-hidden rounded-xl border border-line">
                <DataGrid columns={columns} rowCount={result.rows.length} getValue={(r, c) => result.rows[r][columns[c]]} />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </Modal>
  );
}
