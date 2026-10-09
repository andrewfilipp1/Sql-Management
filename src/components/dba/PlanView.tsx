import dagre from '@dagrejs/dagre';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { motion } from 'motion/react';
import { AlertTriangle } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { compactNumber, cn, formatMs } from '../../lib/utils';
import { flatten, ownCost, type PlanNode } from '../../lib/plan';
import { spring } from '../ui';

const W = 250;
const H = 96;

interface PlanNodeData extends Record<string, unknown> {
  n: PlanNode;
  share: number; // 0..1 of total own-cost
  hottest: boolean;
  index: number;
  analyzed: boolean;
}

/** Green → amber → red as a node takes a larger share of the plan's cost. */
const heat = (share: number) => `hsl(${Math.round(140 - Math.min(1, share * 1.6) * 140)} 85% 60%)`;

const PlanCard = memo(function PlanCard({ data }: NodeProps<Node<PlanNodeData>>) {
  const { n, share, hottest, index, analyzed } = data;
  const color = heat(share);
  const misestimate = analyzed && !!n.rows && n.actualRows !== undefined && (n.actualRows / Math.max(1, n.rows) > 10 || n.rows / Math.max(1, n.actualRows) > 10);
  return (
    <div className="node-in" style={{ animationDelay: `${Math.min(index * 45, 900)}ms` }}>
      <Handle type="target" position={Position.Right} isConnectable={false} />
      <motion.div
        whileHover={{ scale: 1.03 }}
        transition={spring}
        className="relative overflow-hidden rounded-xl border bg-[linear-gradient(180deg,rgb(22_27_50/0.95),rgb(12_15_30/0.95))] px-3 py-2"
        style={{
          width: W,
          minHeight: H - 10,
          borderColor: hottest ? color : 'rgb(255 255 255 / 0.1)',
          boxShadow: hottest ? `0 0 0 1px ${color}, 0 0 30px -6px ${color}` : '0 12px 30px -16px rgb(0 0 0 / 0.8)',
        }}
      >
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-white">{n.label}</span>
          {n.fullScan && (
            <span title="Reads the whole table" className="flex items-center gap-0.5 rounded bg-amber-400/15 px-1 text-[9.5px] font-semibold text-amber-200">
              <AlertTriangle className="size-2.5" /> SCAN
            </span>
          )}
          <span className="font-mono text-[10.5px]" style={{ color }}>
            {Math.round(share * 100)}%
          </span>
        </div>
        {n.detail && <div className="truncate font-mono text-[10.5px] text-cyan-200/80" title={n.detail}>{n.detail}</div>}
        <div className="mt-1 flex gap-3 font-mono text-[10.5px] text-white/55">
          {n.rows !== undefined && <span>est {compactNumber(n.rows)}</span>}
          {n.actualRows !== undefined && <span className={cn(misestimate && 'text-amber-300')}>act {compactNumber(n.actualRows)}</span>}
          {n.timeMs !== undefined && <span>{formatMs(n.timeMs)}</span>}
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/5">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${Math.max(2, share * 100)}%` }}
            transition={{ duration: 0.8, delay: 0.2 + index * 0.04 }}
            className="h-full rounded-full"
            style={{ background: color, boxShadow: `0 0 8px ${color}` }}
          />
        </div>
      </motion.div>
      <Handle type="source" position={Position.Left} isConnectable={false} />
    </div>
  );
});

function FlowUpEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: EdgeProps) {
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 12 });
  return (
    <>
      <path id={id} d={path} fill="none" stroke="rgb(129 140 248 / 0.35)" strokeWidth={1.5} />
      <path d={path} fill="none" stroke="rgb(165 180 252 / 0.7)" strokeWidth={1.4} className="edge-flow" />
      <circle r={2.5} fill="#a5b4fc">
        <animateMotion dur="1.8s" repeatCount="indefinite" path={path} />
      </circle>
    </>
  );
}

const nodeTypes = { plan: PlanCard };
const edgeTypes = { up: FlowUpEdge };

function Inner({ root, analyzed }: { root: PlanNode; analyzed: boolean }) {
  const [selected, setSelected] = useState<PlanNode | null>(null);
  const { nodes, edges } = useMemo(() => {
    const all = flatten(root);
    const costs = all.map((n) => ownCost(n) ?? 0);
    const total = costs.reduce((a, b) => a + b, 0) || 1;
    const hottest = costs.indexOf(Math.max(...costs));
    const g = new dagre.graphlib.Graph();
    // Root on the left, as in SSMS: rows flow right-to-left from the leaves. Fits the wide, short result pane.
    g.setGraph({ rankdir: 'LR', nodesep: 18, ranksep: 56 });
    g.setDefaultEdgeLabel(() => ({}));
    all.forEach((n) => g.setNode(n.id, { width: W, height: H }));
    const edges: Edge[] = [];
    all.forEach((n) =>
      n.children.forEach((c) => {
        g.setEdge(n.id, c.id);
        edges.push({ id: `${c.id}-${n.id}`, source: c.id, target: n.id, type: 'up' });
      }),
    );
    dagre.layout(g);
    const nodes: Node<PlanNodeData>[] = all.map((n, i) => {
      const p = g.node(n.id);
      return {
        id: n.id,
        type: 'plan',
        position: { x: p.x - W / 2, y: p.y - H / 2 },
        data: { n, share: (costs[i] ?? 0) / total, hottest: i === hottest && costs[i] > 0, index: i, analyzed },
      };
    });
    return { nodes, edges };
  }, [root, analyzed]);

  return (
    <div className="relative h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesConnectable={false}
        nodesDraggable={false}
        onNodeClick={(_, n) => setSelected((n.data as PlanNodeData).n)}
        onPaneClick={() => setSelected(null)}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--grid-dot)" />
        <Controls position="bottom-left" showInteractive={false} />
      </ReactFlow>
      {selected && selected.extra.length > 0 && (
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={spring}
          className="glass-strong absolute top-3 right-3 z-10 max-h-[80%] w-80 overflow-auto rounded-xl p-3 text-xs"
        >
          <div className="mb-2 font-semibold">{selected.label}</div>
          {selected.extra.map(([k, v]) => (
            <div key={k} className="mb-1.5">
              <div className="text-[10.5px] text-muted uppercase">{k}</div>
              <div className="font-mono break-words text-fg/90">{v}</div>
            </div>
          ))}
        </motion.div>
      )}
    </div>
  );
}

export function PlanView({ root, analyzed }: { root: PlanNode; analyzed: boolean }) {
  return (
    <ReactFlowProvider>
      <Inner root={root} analyzed={analyzed} />
    </ReactFlowProvider>
  );
}
