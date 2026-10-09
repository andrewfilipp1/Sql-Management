import { useEffect } from 'react';
import { useStore } from '../lib/store';
import { Select } from './ui';

export interface DbTarget {
  connId: string;
  database: string;
}

/** Connection + database selector; connects on demand to list databases. */
export function DbPicker({ value, onChange, label }: { value: DbTarget; onChange: (v: DbTarget) => void; label: string }) {
  const connections = useStore((s) => s.connections);
  const session = useStore((s) => s.sessions[value.connId]);
  const connect = useStore((s) => s.connect);
  const conn = connections.find((c) => c.id === value.connId);

  useEffect(() => {
    if (!value.connId) return;
    void connect(value.connId).then((s) => {
      if (s && !value.database) onChange({ connId: value.connId, database: conn?.kind === 'sqlite' ? 'main' : s.defaultDatabase });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.connId]);

  const dbs = conn?.kind === 'sqlite' ? ['main'] : (session?.databases ?? []);
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 text-[11px] font-semibold tracking-wider text-muted uppercase">{label}</span>
      <Select value={value.connId} onChange={(e) => onChange({ connId: e.target.value, database: '' })} className="h-8 w-52 text-xs" aria-label={`${label} connection`}>
        <option value="">Connection…</option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      <Select value={value.database} onChange={(e) => onChange({ ...value, database: e.target.value })} className="h-8 w-40 text-xs" disabled={!dbs.length} aria-label={`${label} database`}>
        <option value="">Database…</option>
        {dbs.map((d) => (
          <option key={d}>{d}</option>
        ))}
      </Select>
    </div>
  );
}
