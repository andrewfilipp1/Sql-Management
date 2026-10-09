import type { DbKind } from '../../shared/types';
import { cn } from '../lib/utils';

const LABEL: Record<DbKind, string> = { sqlite: 'SL', postgres: 'PG', mysql: 'MY', mssql: 'MS' };

export const KIND_COLOR: Record<DbKind, string> = {
  sqlite: '#38bdf8',
  postgres: '#818cf8',
  mysql: '#f5b83d',
  mssql: '#f472b6',
};

export function DbIcon({ kind, color, size = 'md' }: { kind: DbKind; color?: string; size?: 'md' | 'lg' }) {
  const c = color ?? KIND_COLOR[kind];
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg font-mono font-bold tracking-tight',
        size === 'lg' ? 'size-10 text-[13px]' : 'size-7 text-[10px]',
      )}
      style={{
        color: c,
        background: `color-mix(in srgb, ${c} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${c} 35%, transparent), 0 0 16px -6px ${c}`,
      }}
    >
      {LABEL[kind]}
    </span>
  );
}
