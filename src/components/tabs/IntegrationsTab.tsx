import { AnimatePresence, motion } from 'motion/react';
import { Bot, Cable, KeyRound, Pencil, Play, Plus, Radio, ScrollText, Server, Trash2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ApiKeyInfo, IntegrationsState, KeyAccess, RequestLogEntry } from '../../../shared/integrations';
import { api } from '../../lib/api';
import { useStore } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, Button, Checkbox, CopyField, Field, IconButton, Input, Modal, Segmented, Spinner, Switch, softSpring, spring } from '../ui';

function Card({ icon, title, action, children, delay = 0 }: { icon: ReactNode; title: string; action?: ReactNode; children: ReactNode; delay?: number }) {
  return (
    <motion.section initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ ...softSpring, delay }} className="glass rounded-2xl">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <span className="text-accent">{icon}</span>
        <h3 className="flex-1 text-[13.5px] font-semibold">{title}</h3>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </motion.section>
  );
}

export function IntegrationsTab() {
  const [state, setState] = useState<IntegrationsState | null>(null);
  const [log, setLog] = useState<RequestLogEntry[]>([]);
  const [port, setPort] = useState('');
  const [newKey, setNewKey] = useState(false);
  const toast = useStore((s) => s.toast);
  const connections = useStore((s) => s.connections);

  const load = useCallback(async () => {
    const s = await api.integrations();
    setState(s);
    setPort(String(s.server.port));
  }, []);

  useEffect(() => {
    void load();
    const onChange = () => void load();
    window.addEventListener('schemascope:integrations-changed', onChange);
    return () => window.removeEventListener('schemascope:integrations-changed', onChange);
  }, [load]);

  // Request log refresh while the server runs.
  useEffect(() => {
    if (!state?.running) return;
    const tick = () => void api.requestLog().then(setLog).catch(() => {});
    tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, [state?.running]);

  if (!state) return <div className="flex h-full items-center justify-center"><Spinner /></div>;

  const setServer = async (patch: Parameters<typeof api.setServer>[0]) => {
    try {
      const s = await api.setServer(patch);
      setState(s);
      if (s.error) toast(s.error, 'error');
    } catch (e) {
      toast((e as Error).message, 'error');
      void load();
    }
  };

  const connName = (id: string) => connections.find((c) => c.id === id)?.name ?? 'deleted connection';
  const base = state.url;
  const exampleConn = connections[0];

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={softSpring}>
          <h1 className="glow-text text-2xl font-semibold tracking-tight">Integrations</h1>
          <p className="mt-1 text-[13px] text-muted">
            Use your databases from other tools: a local REST API, saved queries published as endpoints, and an MCP server for AI
            assistants. Everything stays on this computer (127.0.0.1) and every request needs an API key.
          </p>
        </motion.div>

        {/* Server */}
        <Card
          icon={<Server className="size-4" />}
          title="Local API server"
          action={<Switch checked={state.server.enabled} onChange={(v) => void setServer({ enabled: v })} label="Enable local API server" />}
        >
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'size-2.5 rounded-full',
                  state.running ? 'bg-emerald-400 shadow-[0_0_10px_rgb(52_211_153)]' : state.error ? 'bg-rose-400' : 'bg-white/25',
                )}
              />
              <span className="text-[13px]">{state.running ? 'Running' : state.error ? state.error : 'Stopped'}</span>
            </div>
            <div className="w-72">{state.running && <CopyField value={base} />}</div>
            <Field label="Port" className="w-28">
              <Input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                onBlur={() => Number(port) !== state.server.port && void setServer({ port: Number(port) })}
                className="h-7"
              />
            </Field>
            <Field label="Requests / min / key" className="w-36">
              <Input
                type="number"
                defaultValue={state.server.rateLimit}
                onBlur={(e) => Number(e.target.value) !== state.server.rateLimit && void setServer({ rateLimit: Number(e.target.value) })}
                className="h-7"
              />
            </Field>
          </div>
          <p className="mt-3 text-[11.5px] text-faint">
            Listens on 127.0.0.1 only. Requests from web pages (with an Origin header) are rejected. OpenAPI description:{' '}
            <span className="font-mono text-muted">{base}/v1/openapi.json</span>
          </p>
        </Card>

        {/* Keys */}
        <Card
          icon={<KeyRound className="size-4" />}
          title="API keys"
          delay={0.05}
          action={
            <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setNewKey(true)}>
              New key
            </Button>
          }
        >
          {state.keys.length ? (
            <div className="divide-y divide-line">
              {state.keys.map((k) => (
                <KeyRow key={k.id} k={k} connName={connName} onRevoke={() => void api.revokeApiKey(k.id).then(load)} />
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-muted">No keys yet. Create one for each tool or person that should have access.</p>
          )}
        </Card>

        {/* Endpoints */}
        <Card
          icon={<Cable className="size-4" />}
          title="Saved query endpoints"
          delay={0.1}
          action={
            <Button size="sm" icon={<Plus className="size-3.5" />} disabled={!connections.length} onClick={() => useStore.getState().editEndpoint({})}>
              New endpoint
            </Button>
          }
        >
          {state.endpoints.length ? (
            <div className="space-y-1.5">
              {state.endpoints.map((e, i) => (
                <motion.div
                  key={e.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ ...spring, delay: i * 0.03 }}
                  className="group flex items-center gap-3 rounded-xl border border-line bg-white/[0.02] px-3 py-2"
                >
                  <Badge tone={e.write ? 'warn' : 'ok'}>{e.write ? 'POST' : 'GET'}</Badge>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12.5px]">/v1/endpoints/{e.slug}</div>
                    <div className="truncate text-[11px] text-faint">
                      {e.name} · {connName(e.connId)} / {e.database}
                      {e.params.length > 0 && ` · params: ${e.params.map((p) => p.name).join(', ')}`}
                    </div>
                  </div>
                  <IconButton label="Edit / test" onClick={() => useStore.getState().editEndpoint(e)}>
                    <Pencil className="size-3.5" />
                  </IconButton>
                  <IconButton label="Delete endpoint" onClick={() => void api.deleteEndpoint(e.id).then(load)}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </motion.div>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-muted">
              Write a query in a query tab and press <span className="text-fg">Publish as API</span>. Use <span className="font-mono">:name</span>{' '}
              for parameters, e.g. <span className="font-mono">WHERE status = :status LIMIT :limit</span>.
            </p>
          )}
        </Card>

        {/* MCP */}
        <Card icon={<Bot className="size-4" />} title="AI assistants (MCP)" delay={0.15}>
          <p className="mb-3 text-[13px] text-muted">
            Lets Claude and other MCP clients read your schema and run queries with the rules of the key you give them. Read keys never
            write, and destructive statements on production connections are always refused.
          </p>
          <div className="space-y-3">
            <Field label="Claude Code">
              <CopyField value={`claude mcp add --transport http schemascope ${base}/mcp --header "Authorization: Bearer <YOUR_KEY>"`} />
            </Field>
            <Field label="Claude Desktop / other clients (claude_desktop_config.json, via mcp-remote)">
              <CopyField
                value={JSON.stringify(
                  { mcpServers: { schemascope: { command: 'npx', args: ['-y', 'mcp-remote', `${base}/mcp`, '--header', 'Authorization: Bearer <YOUR_KEY>'] } } },
                  null,
                  2,
                )}
              />
            </Field>
          </div>
        </Card>

        {/* Examples */}
        <Card icon={<Play className="size-4" />} title="Examples" delay={0.2}>
          <div className="space-y-3">
            <Field label="List tables">
              <CopyField
                value={`curl -H "Authorization: Bearer <YOUR_KEY>" \\\n  ${base}/v1/connections/${exampleConn?.id ?? '<connection-id>'}/databases/<db>/tables`}
              />
            </Field>
            <Field label="Read rows with filters (eq, neq, gt, gte, lt, lte, like, ilike, in, is)">
              <CopyField value={`curl -H "Authorization: Bearer <YOUR_KEY>" \\\n  "${base}/v1/connections/<id>/databases/<db>/tables/orders/rows?status=eq.paid&order=id.desc&limit=50"`} />
            </Field>
            <Field label="Saved endpoint">
              <CopyField value={`curl -H "Authorization: Bearer <YOUR_KEY>" "${base}/v1/endpoints/${state.endpoints[0]?.slug ?? '<slug>'}?param=value"`} />
            </Field>
            <p className="text-[11.5px] text-faint">
              Excel / Power BI: Data → From Web → Advanced, add the header <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>.
            </p>
          </div>
        </Card>

        {/* Log */}
        <Card icon={<ScrollText className="size-4" />} title="Recent requests" delay={0.25} action={state.running ? <Radio className="size-4 animate-pulse text-ok" /> : undefined}>
          {log.length ? (
            <div className="max-h-64 overflow-auto font-mono text-[11.5px]">
              {log.slice(0, 100).map((l, i) => (
                <div key={i} className="flex gap-3 border-b border-line/50 py-1">
                  <span className="text-faint">{new Date(l.at).toLocaleTimeString()}</span>
                  <span className="w-12 text-muted">{l.method}</span>
                  <span className={cn('w-9', l.status < 300 ? 'text-ok' : l.status < 500 ? 'text-warn' : 'text-danger')}>{l.status}</span>
                  <span className="min-w-0 flex-1 truncate">{l.path}</span>
                  <span className="text-faint">{l.key ?? '—'}</span>
                  <span className="w-14 text-right text-faint">{l.ms} ms</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-muted">{state.running ? 'No requests yet.' : 'Start the server to see requests here.'}</p>
          )}
        </Card>
      </div>

      <NewKeyDialog open={newKey} onClose={() => setNewKey(false)} onCreated={() => void load()} />
    </div>
  );
}

function KeyRow({ k, connName, onRevoke }: { k: ApiKeyInfo; connName: (id: string) => string; onRevoke: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex items-center gap-3 py-2">
      <KeyRound className={cn('size-4', k.access === 'write' ? 'text-warn' : 'text-ok')} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px]">
          {k.name}
          <Badge tone={k.access === 'write' ? 'warn' : 'ok'}>{k.access}</Badge>
        </div>
        <div className="truncate text-[11px] text-faint">
          <span className="font-mono">{k.prefix}…</span> · {k.connections === '*' ? 'all connections' : k.connections.map(connName).join(', ')} · last used{' '}
          {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never'}
        </div>
      </div>
      {confirm ? (
        <>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
            Keep
          </Button>
          <Button size="sm" variant="danger" onClick={onRevoke}>
            Revoke
          </Button>
        </>
      ) : (
        <IconButton label="Revoke key" onClick={() => setConfirm(true)}>
          <Trash2 className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}

function NewKeyDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const connections = useStore((s) => s.connections);
  const [name, setName] = useState('');
  const [access, setAccess] = useState<KeyAccess>('read');
  const [all, setAll] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setAccess('read');
      setAll(false);
      setPicked([]);
      setCreated(null);
      setError(null);
    }
  }, [open]);

  const create = async () => {
    try {
      const r = await api.createApiKey({ name, access, connections: all ? '*' : picked });
      setCreated(r.key);
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={created ? 'Key created' : 'New API key'}
      icon={<KeyRound className="size-4" />}
      width={540}
      footer={
        created ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            {error && <span className="mr-auto text-xs text-danger">{error}</span>}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!name.trim() || (!all && !picked.length)} onClick={() => void create()}>
              Create key
            </Button>
          </>
        )
      }
    >
      <AnimatePresence mode="wait">
        {created ? (
          <motion.div key="done" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={spring} className="space-y-3">
            <p className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 p-2.5 text-[12.5px] text-amber-100">
              <TriangleAlert className="mt-px size-4 shrink-0" /> Copy it now — it is stored only as a hash and cannot be shown again.
            </p>
            <CopyField value={created} secret />
          </motion.div>
        ) : (
          <motion.div key="form" className="space-y-4">
            <Field label="Name">
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Power BI report, n8n, Claude…" />
            </Field>
            <Field label="Access">
              <Segmented<KeyAccess>
                layoutId="key-access"
                value={access}
                onChange={setAccess}
                options={[
                  { value: 'read', label: 'Read only' },
                  { value: 'write', label: 'Read & write' },
                ]}
              />
            </Field>
            <Field label="Connections">
              <div className="space-y-1.5">
                <Checkbox checked={all} onChange={setAll} label="All connections (including ones added later)" />
                {!all &&
                  connections.map((c) => (
                    <Checkbox
                      key={c.id}
                      checked={picked.includes(c.id)}
                      onChange={(v) => setPicked(v ? [...picked, c.id] : picked.filter((x) => x !== c.id))}
                      label={
                        <span className="flex items-center gap-1.5">
                          {c.name}
                          {c.environment === 'production' && <Badge tone="danger">PROD</Badge>}
                        </span>
                      }
                    />
                  ))}
              </div>
            </Field>
          </motion.div>
        )}
      </AnimatePresence>
    </Modal>
  );
}
