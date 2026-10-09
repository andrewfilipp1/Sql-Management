import { AnimatePresence, motion } from 'motion/react';
import { Crown, KeyRound, Plus, Shield, ShieldCheck, Trash2, UserPlus, Users, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addRoleMemberSql,
  createLoginSql,
  createRoleSql,
  dropPrincipalSql,
  grantSql,
  passwordProblem,
  TABLE_PRIVILEGES,
} from '../../../shared/dialect';
import type { Principal, SecurityInfo } from '../../../shared/types';
import { api } from '../../lib/api';
import { useConnection, useSchema, useStore, type Tab } from '../../lib/store';
import { cn, nodeId } from '../../lib/utils';
import { Badge, Button, Checkbox, EmptyState, Field, IconButton, Input, Modal, Segmented, Select, Spinner, spring } from '../ui';

const pkey = (p: Principal) => `${p.kind}:${p.name}@${p.host ?? ''}`;

export function SecurityTab({ tab }: { tab: Tab }) {
  const conn = useConnection(tab.connId);
  const schema = useSchema(tab.connId, tab.database)?.data;
  const ensureSchema = useStore((s) => s.ensureSchema);
  const [info, setInfo] = useState<SecurityInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [grantTable, setGrantTable] = useState('');
  const [privs, setPrivs] = useState<string[]>(['SELECT']);
  const [addRole, setAddRole] = useState('');

  useEffect(() => ensureSchema(tab.connId, tab.database), [tab.connId, tab.database, ensureSchema]);
  const load = useCallback(async () => {
    try {
      setInfo(await api.security(tab.connId, tab.database));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tab.connId, tab.database]);
  useEffect(() => void load(), [load]);

  const principal = info?.principals.find((p) => pkey(p) === selected);
  // MySQL grantees come back as user@host.
  const principalGrants = useMemo(() => {
    if (!info || !principal) return [];
    const names = new Set([principal.name, `${principal.name}@${principal.host ?? ''}`]);
    return info.grants.filter((g) => names.has(g.principal));
  }, [info, principal]);

  if (error) return <EmptyState icon={<Shield className="size-6" />} title="Security is not available">{error}</EmptyState>;
  if (!info || !conn) return <div className="flex h-full items-center justify-center"><Spinner /></div>;

  const kind = conn.kind;
  const runSql = (title: string, sql: string, danger = false, description?: string) =>
    useStore.getState().confirmSql({ connId: tab.connId, database: tab.database, title, sql, danger, description, onDone: () => void load() });
  const tables = (schema?.tables ?? []).filter((t) => t.type === 'table');
  const groups: [string, Principal[]][] = [
    ['Users', info.principals.filter((p) => p.kind === 'user')],
    ['Roles', info.principals.filter((p) => p.kind === 'role')],
    ['Logins', info.principals.filter((p) => p.kind === 'login')],
  ];

  return (
    <div className="flex h-full">
      {/* Principals */}
      <div className="flex w-72 shrink-0 flex-col border-r border-line">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Shield className="size-4 text-accent" />
          <div className="flex-1">
            <div className="text-[14px] font-semibold">Security</div>
            <div className="text-[11px] text-muted">
              {conn.name} · {tab.database}
            </div>
          </div>
          <IconButton label="New user or role" onClick={() => setCreating(true)} disabled={!!conn.readOnly}>
            <UserPlus className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {groups.map(([title, list]) =>
            list.length ? (
              <div key={title} className="mb-3">
                <div className="px-2 pb-1 text-[10.5px] font-semibold tracking-wider text-faint uppercase">{title}</div>
                {list.map((p) => (
                  <button
                    key={pkey(p)}
                    onClick={() => setSelected(pkey(p))}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors',
                      selected === pkey(p) ? 'bg-accent-soft text-fg' : 'text-fg/85 hover:bg-white/5',
                    )}
                  >
                    {p.superuser ? <Crown className="size-3.5 text-pk" /> : p.kind === 'role' ? <Users className="size-3.5 text-violet-300" /> : <KeyRound className="size-3.5 text-cyan-300" />}
                    <span className="min-w-0 flex-1 truncate">
                      {p.name}
                      {p.host && <span className="text-faint">@{p.host}</span>}
                    </span>
                    {!p.canLogin && p.kind === 'user' && <Badge>no login</Badge>}
                  </button>
                ))}
              </div>
            ) : null,
          )}
          {info.notes && <p className="px-2 text-[11px] text-faint">{info.notes}</p>}
        </div>
      </div>

      {/* Detail */}
      <div className="min-w-0 flex-1 overflow-auto p-5">
        <AnimatePresence mode="wait">
          {!principal ? (
            <EmptyState key="none" icon={<ShieldCheck className="size-6" />} title="Choose a user or role">
              See its role memberships and table permissions, grant or revoke access, or create a new login.
            </EmptyState>
          ) : (
            <motion.div key={selected} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={spring} className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent shadow-[0_0_20px_-6px_rgb(129_140_248/0.9)]">
                  {principal.kind === 'role' ? <Users className="size-5" /> : <KeyRound className="size-5" />}
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold">
                    {principal.name}
                    {principal.host && <span className="text-muted">@{principal.host}</span>}
                  </h2>
                  <div className="flex gap-1.5">
                    <Badge tone="accent">{principal.kind}</Badge>
                    {principal.superuser && <Badge tone="pk">superuser</Badge>}
                    {principal.canLogin && <Badge tone="ok">can log in</Badge>}
                  </div>
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  icon={<Trash2 className="size-3.5" />}
                  disabled={!!conn.readOnly}
                  onClick={() => runSql(`Drop ${principal.kind} ${principal.name}`, dropPrincipalSql(kind, principal), true, 'Objects owned by it may need to be reassigned first.')}
                >
                  Drop
                </Button>
              </div>

              <section className="glass rounded-2xl p-4">
                <h3 className="mb-2 text-[13px] font-semibold">Member of</h3>
                <div className="flex flex-wrap items-center gap-1.5">
                  {principal.memberOf.map((r) => (
                    <span key={r} className="flex items-center gap-1 rounded-md border border-violet-300/25 bg-violet-400/10 px-1.5 py-0.5 text-[12px] text-violet-100">
                      {r}
                      <button aria-label={`Remove from ${r}`} onClick={() => runSql(`Remove from ${r}`, addRoleMemberSql(kind, r, principal, true))} className="text-violet-200/70 hover:text-white">
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                  {!principal.memberOf.length && <span className="text-xs text-faint">No role memberships.</span>}
                  <div className="ml-auto flex items-center gap-1.5">
                    <Select value={addRole} onChange={(e) => setAddRole(e.target.value)} className="h-7 text-xs">
                      <option value="">Add to role…</option>
                      {info.roles.filter((r) => r !== principal.name && !principal.memberOf.includes(r)).map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </Select>
                    <Button size="sm" disabled={!addRole} onClick={() => (runSql(`Add to ${addRole}`, addRoleMemberSql(kind, addRole, principal)), setAddRole(''))}>
                      Add
                    </Button>
                  </div>
                </div>
              </section>

              <section className="glass rounded-2xl p-4">
                <h3 className="mb-2 text-[13px] font-semibold">Permissions</h3>
                {principalGrants.length ? (
                  <div className="mb-3 divide-y divide-line">
                    {principalGrants.map((g, i) => (
                      <div key={i} className="group flex items-center gap-3 py-1.5 text-[12.5px]">
                        <span className="font-mono">{g.object}</span>
                        <Badge tone={/DENY/.test(g.privilege) ? 'danger' : 'ok'}>{g.privilege}</Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mb-3 text-xs text-faint">No object permissions granted directly.</p>
                )}
                <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  <Select value={grantTable} onChange={(e) => setGrantTable(e.target.value)} className="h-7 text-xs">
                    <option value="">Table…</option>
                    {tables.map((t) => (
                      <option key={nodeId(t)}>{nodeId(t)}</option>
                    ))}
                  </Select>
                  {TABLE_PRIVILEGES.map((p) => (
                    <Checkbox key={p} checked={privs.includes(p)} onChange={(v) => setPrivs(v ? [...privs, p] : privs.filter((x) => x !== p))} label={<span className="text-xs">{p}</span>} />
                  ))}
                  <div className="flex-1" />
                  {(['grant', 'revoke'] as const).map((action) => (
                    <Button
                      key={action}
                      size="sm"
                      variant={action === 'revoke' ? 'danger' : 'secondary'}
                      disabled={!grantTable || !privs.length || !!conn.readOnly}
                      onClick={() => {
                        const t = tables.find((x) => nodeId(x) === grantTable)!;
                        runSql(`${action === 'grant' ? 'Grant' : 'Revoke'} on ${t.name}`, grantSql(kind, privs, t, tab.database, principal, action === 'revoke'));
                      }}
                    >
                      {action === 'grant' ? 'Grant' : 'Revoke'}
                    </Button>
                  ))}
                </div>
              </section>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <CreatePrincipalDialog open={creating} onClose={() => setCreating(false)} kind={kind} onSql={runSql} />
    </div>
  );
}

function CreatePrincipalDialog({
  open,
  onClose,
  kind,
  onSql,
}: {
  open: boolean;
  onClose: () => void;
  kind: 'postgres' | 'mysql' | 'mssql' | 'sqlite';
  onSql: (title: string, sql: string) => void;
}) {
  const [what, setWhat] = useState<'user' | 'role'>('user');
  const [name, setName] = useState('');
  const [host, setHost] = useState('%');
  const [pw, setPw] = useState('');
  useEffect(() => {
    if (open) {
      setName('');
      setPw('');
      setHost('%');
    }
  }, [open]);
  const pwProblem = what === 'user' ? passwordProblem(pw) : null;
  const valid = /^[\p{L}\p{N}_.-]{1,63}$/u.test(name) && !pwProblem;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New user or role"
      icon={<Plus className="size-4" />}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() => {
              onSql(what === 'user' ? `Create login ${name}` : `Create role ${name}`, what === 'user' ? createLoginSql(kind, name, pw, host) : createRoleSql(kind, name));
              onClose();
            }}
          >
            Review SQL
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented
          layoutId="principal-kind"
          value={what}
          onChange={setWhat}
          options={[
            { value: 'user', label: 'User (can log in)' },
            { value: 'role', label: 'Role (group of permissions)' },
          ]}
        />
        <Field label="Name" hint="Letters, digits, _ . -">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {kind === 'mysql' && what === 'user' && (
          <Field label="Host" hint="% = from anywhere, localhost = this server only">
            <Input value={host} onChange={(e) => setHost(e.target.value)} className="font-mono" />
          </Field>
        )}
        {what === 'user' && (
          <Field label="Password" hint={pw && pwProblem ? <span className="text-warn">{pwProblem}</span> : 'Shown in the SQL review; it is not saved by SchemaScope.'}>
            <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
          </Field>
        )}
      </div>
    </Modal>
  );
}
