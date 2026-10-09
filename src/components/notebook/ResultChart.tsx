import { motion } from 'motion/react';
import { useMemo, useState } from 'react';
import type { ChartKind } from '../../../shared/notebook';
import { formatNumber } from '../../lib/utils';

const W = 760;
const H = 260;
const PAD = { l: 56, r: 16, t: 14, b: 46 };
const MAX_POINTS = 120;

export function numericColumns(columns: string[], rows: unknown[][]): string[] {
  return columns.filter((_, c) => {
    const vals = rows.slice(0, 100).map((r) => r[c]).filter((v) => v !== null && v !== undefined && v !== '');
    return vals.length > 0 && vals.every((v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))));
  });
}

/** Bar / line chart of one numeric column against a label column. */
export function ResultChart({ kind, columns, rows, x, y }: { kind: ChartKind; columns: string[]; rows: unknown[][]; x: string; y: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const xi = columns.indexOf(x);
  const yi = columns.indexOf(y);
  const points = useMemo(
    () =>
      rows.slice(0, MAX_POINTS).map((r) => ({
        label: String(r[xi] ?? '∅'),
        value: Number(r[yi] ?? 0) || 0,
      })),
    [rows, xi, yi],
  );
  if (xi < 0 || yi < 0 || !points.length) return <div className="p-4 text-xs text-muted">Pick columns to chart.</div>;

  const max = Math.max(0, ...points.map((p) => p.value));
  const min = Math.min(0, ...points.map((p) => p.value));
  const span = max - min || 1;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const step = iw / points.length;
  const yOf = (v: number) => PAD.t + ih - ((v - min) / span) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + f * span);
  const labelEvery = Math.ceil(points.length / 12);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${PAD.l + step * (i + 0.5)},${yOf(p.value)}`).join(' ');

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[260px] w-full" role="img" aria-label={`${kind} chart of ${y} by ${x}`}>
        <defs>
          <linearGradient id="nb-bar" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#818cf8" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.55" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={yOf(t)} y2={yOf(t)} stroke="rgb(255 255 255 / 0.06)" />
            <text x={PAD.l - 8} y={yOf(t) + 3} textAnchor="end" className="fill-[var(--faint)] text-[10px]">
              {formatNumber(Math.round(t * 100) / 100)}
            </text>
          </g>
        ))}
        {kind === 'bar'
          ? points.map((p, i) => {
              const top = yOf(Math.max(0, p.value));
              const h = Math.abs(yOf(p.value) - yOf(0));
              return (
                // Grow from the zero line. (Plain <rect> attributes: on motion components x/y would mean translate.)
                <motion.g
                  key={i}
                  style={{ originY: p.value >= 0 ? 1 : 0, transformBox: 'fill-box' }}
                  initial={{ scaleY: 0 }}
                  animate={{ scaleY: 1 }}
                  transition={{ type: 'spring', stiffness: 220, damping: 26, delay: Math.min(i * 0.015, 0.6) }}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                >
                  <rect
                    x={PAD.l + step * i + step * 0.15}
                    width={Math.max(1, step * 0.7)}
                    y={top}
                    height={Math.max(0.5, h)}
                    rx={Math.min(4, step * 0.2)}
                    fill="url(#nb-bar)"
                    opacity={hover === null || hover === i ? 1 : 0.45}
                  />
                </motion.g>
              );
            })
          : (
            <>
              <motion.path d={line} fill="none" stroke="#818cf8" strokeWidth={2} initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.9, ease: 'easeOut' }} />
              {points.map((p, i) => (
                <circle
                  key={i}
                  cx={PAD.l + step * (i + 0.5)}
                  cy={yOf(p.value)}
                  r={hover === i ? 4.5 : 2.5}
                  fill="#22d3ee"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              ))}
            </>
          )}
        {points.map((p, i) =>
          i % labelEvery ? null : (
            <text key={i} x={PAD.l + step * (i + 0.5)} y={H - PAD.b + 14} textAnchor="end" transform={`rotate(-30 ${PAD.l + step * (i + 0.5)} ${H - PAD.b + 14})`} className="fill-[var(--muted)] text-[10px]">
              {p.label.length > 14 ? p.label.slice(0, 13) + '…' : p.label}
            </text>
          ),
        )}
      </svg>
      {hover !== null && (
        <div className="glass pointer-events-none absolute top-2 right-3 rounded-lg px-2.5 py-1.5 text-xs">
          <span className="text-muted">{points[hover].label}</span> · <span className="font-medium">{formatNumber(points[hover].value)}</span>
        </div>
      )}
      {rows.length > MAX_POINTS && <div className="px-3 pb-1 text-[11px] text-faint">Showing the first {MAX_POINTS} rows.</div>}
    </div>
  );
}
