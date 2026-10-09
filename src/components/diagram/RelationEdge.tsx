import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';

export interface RelationEdgeData extends Record<string, unknown> {
  active: boolean;
  dimmed: boolean;
  flow: boolean;
  label: string;
  hue: number;
  /** Problem on this relationship (type mismatch, target not a key…). */
  problem?: 'error' | 'warning' | 'info';
  /** Not in the database yet (design mode). */
  draft?: boolean;
  /** Will disappear with a dropped table or column. */
  removed?: boolean;
  /** Large diagram: draw the soft glow only where it matters. */
  lite?: boolean;
}

export type RelationEdgeType = Edge<RelationEdgeData, 'relation'>;

/**
 * SVG markers shared by all edges: crow's foot = "many" (child) side, double bar = "one" (parent) side.
 * With auto-start-reverse, +x points into the node at both ends, so x=18 touches the table.
 */
export function EdgeMarkers() {
  const marker = (id: string, color: string, many: boolean) => (
    <marker id={id} viewBox="0 0 20 20" refX="18" refY="10" markerWidth="16" markerHeight="16" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
      {many ? (
        <path d="M2 10 L18 3 M2 10 L18 10 M2 10 L18 17" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      ) : (
        <path d="M12 3 L12 17 M16 3 L16 17" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      )}
    </marker>
  );
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }}>
      <defs>
        {marker('ss-many', 'rgb(129 140 248 / 0.55)', true)}
        {marker('ss-one', 'rgb(129 140 248 / 0.55)', false)}
        {marker('ss-many-active', '#22d3ee', true)}
        {marker('ss-one-active', '#22d3ee', false)}
        <filter id="ss-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="ss-edge-grad" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function RelationEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<RelationEdgeType>) {
  const self = Math.abs(sourceX - targetX) < 1 && sourcePosition === targetPosition;
  let path: string;
  let labelX: number;
  let labelY: number;
  if (self || (sourcePosition === targetPosition && Math.abs(sourceX - targetX) < 60)) {
    // Self reference (or both ends on the same side): draw a loop outward.
    const dx = sourcePosition === 'left' ? -70 : 70;
    path = `M ${sourceX} ${sourceY} C ${sourceX + dx} ${sourceY}, ${targetX + dx} ${targetY}, ${targetX} ${targetY}`;
    labelX = sourceX + dx * 0.75;
    labelY = (sourceY + targetY) / 2;
  } else {
    [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  }

  const active = !!data?.active;
  const dimmed = !!data?.dimmed;
  const flow = !!data?.flow;
  const problem = data?.problem === 'error' || data?.problem === 'warning' ? data.problem : undefined;
  const alarm = problem === 'error' ? '#fb7185' : problem === 'warning' ? '#fbbf24' : undefined;
  const stroke = data?.removed ? '#fb7185' : alarm ?? (data?.draft ? '#34d399' : active ? '#22d3ee' : `hsl(${data?.hue ?? 235} 80% 72% / 0.55)`);

  return (
    <>
      {/* soft glow underneath (skipped for idle lines in large diagrams: a blur filter per line is costly) */}
      {(!data?.lite || active || alarm) && <path
        d={path}
        fill="none"
        stroke={active ? '#22d3ee' : `hsl(${data?.hue ?? 235} 85% 65%)`}
        strokeWidth={active ? 8 : 5}
        strokeOpacity={dimmed ? 0 : active ? 0.28 : 0.08}
        filter="url(#ss-glow)"
        className="edge-path"
      />}
      {/* problem: a pulsing alarm halo along the line */}
      {alarm && !dimmed && <path d={path} fill="none" stroke={alarm} strokeWidth={7} filter="url(#ss-glow)" className="edge-alarm" />}
      <BaseEdge
        id={id}
        path={path}
        markerStart={active ? 'url(#ss-many-active)' : 'url(#ss-many)'}
        markerEnd={active ? 'url(#ss-one-active)' : 'url(#ss-one)'}
        className="edge-path"
        style={{ stroke, strokeWidth: active || alarm || data?.draft ? 2.2 : 1.4, opacity: dimmed ? 0.08 : data?.removed ? 0.6 : 1, strokeDasharray: data?.draft || data?.removed ? '7 5' : undefined }}
      />
      {/* flowing dashes on top: data "moving" from child to parent */}
      {flow && !dimmed && (
        <path
          d={path}
          fill="none"
          stroke={active ? '#e0f2fe' : `hsl(${data?.hue ?? 235} 90% 80%)`}
          strokeWidth={active ? 2 : 1.2}
          strokeOpacity={active ? 0.9 : 0.45}
          strokeLinecap="round"
          className="edge-flow"
        />
      )}
      {/* travelling light particles */}
      {flow && !dimmed && (
        <>
          <circle r={active || alarm ? 3.5 : 2.4} fill={alarm ?? (data?.draft ? '#6ee7b7' : active ? '#67e8f9' : `hsl(${data?.hue ?? 235} 90% 78%)`)} filter="url(#ss-glow)">
            <animateMotion dur={alarm ? '1.1s' : active ? '1.6s' : '3.2s'} repeatCount="indefinite" path={path} />
          </circle>
          {active && (
            <circle r={2.5} fill="#c7d2fe" filter="url(#ss-glow)">
              <animateMotion dur="1.6s" begin="0.8s" repeatCount="indefinite" path={path} />
            </circle>
          )}
        </>
      )}
      {active && data?.label && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded-md border border-cyan-300/30 bg-[#0a1226]/90 px-1.5 py-0.5 font-mono text-[10px] text-cyan-200 shadow-[0_0_14px_-2px_rgb(34_211_238/0.6)] backdrop-blur"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const RelationEdge = memo(RelationEdgeImpl);
