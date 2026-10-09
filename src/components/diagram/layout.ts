import dagre from '@dagrejs/dagre';
import type { ColumnInfo, TableInfo } from '../../../shared/types';
import { nodeKey as nodeId, type Relation } from '../../lib/utils';

export const NODE_W = 264;
export const HEADER_H = 46;
export const ROW_H = 26;
export const MAX_ROWS = 16;

export type Direction = 'LR' | 'TB';

export function fkColumnSet(t: TableInfo): Set<string> {
  return new Set(t.foreignKeys.flatMap((f) => f.columns));
}

/** Columns a node renders: keys only, or everything (capped, keys first). */
export function visibleColumns(t: TableInfo, keysOnly: boolean, all = false): { columns: ColumnInfo[]; hidden: number } {
  const fks = fkColumnSet(t);
  const isKey = (c: ColumnInfo) => c.isPrimaryKey || fks.has(c.name);
  // Edit mode shows every column so each one can be changed.
  if (all) return { columns: t.columns, hidden: 0 };
  if (keysOnly) {
    const cols = t.columns.filter(isKey);
    return { columns: cols, hidden: t.columns.length - cols.length };
  }
  if (t.columns.length <= MAX_ROWS) return { columns: t.columns, hidden: 0 };
  const keys = t.columns.filter(isKey);
  const rest = t.columns.filter((c) => !isKey(c)).slice(0, Math.max(0, MAX_ROWS - keys.length));
  const keep = new Set([...keys, ...rest]);
  const cols = t.columns.filter((c) => keep.has(c));
  return { columns: cols, hidden: t.columns.length - cols.length };
}

export function nodeHeight(t: TableInfo, keysOnly: boolean): number {
  const { columns, hidden } = visibleColumns(t, keysOnly);
  return HEADER_H + columns.length * ROW_H + (hidden ? 24 : 0) + 8;
}

/** Above this many tables a single dagre run gets a very tall (LR) or wide (TB) strip; we reshape it. */
const RESHAPE_ABOVE = 60;
/** Width / height the reshaped layout aims for (a typical screen). */
const TARGET_ASPECT = 1.6;

type Box = { id: string; w: number; h: number };
type Placed = Map<string, { x: number; y: number }>;

function dagreLayout(boxes: Box[], edges: [string, string][], dir: Direction): Placed {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: dir, nodesep: dir === 'LR' ? 36 : 56, ranksep: dir === 'LR' ? 130 : 90, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const b of boxes) g.setNode(b.id, { width: b.w, height: b.h });
  // Parent → child, so referenced tables sit upstream.
  for (const [parent, child] of edges) if (g.hasNode(parent) && g.hasNode(child)) g.setEdge(parent, child);
  dagre.layout(g);
  const pos: Placed = new Map();
  for (const id of g.nodes()) {
    const n = g.node(id);
    pos.set(id, { x: n.x - n.width / 2, y: n.y - n.height / 2 });
  }
  return pos;
}

/**
 * Reshape one component's dagre result towards TARGET_ASPECT, keeping dagre's rank order
 * (data still flows left→right / top→bottom) and its in-rank order (fewer crossings):
 *  1. ranks that are too long are split into side-by-side sub-columns;
 *  2. if the result is still far too wide, the sequence of ranks wraps into bands.
 */
function reshape(boxes: Box[], pos: Placed, dir: Direction): Placed {
  // Try a few column budgets and keep the shape closest to the target aspect (pure arithmetic, cheap).
  let best: Placed = pos;
  let bestScore = Infinity;
  for (const scale of [1, 0.75, 0.55, 0.4, 0.3]) {
    const out = reshapeWith(boxes, pos, dir, scale);
    const { w, h } = normalise(out, boxes);
    const score = Math.abs(Math.log(w / h / TARGET_ASPECT));
    if (score < bestScore) {
      best = out;
      bestScore = score;
    }
  }
  return best;
}

function reshapeWith(boxes: Box[], pos: Placed, dir: Direction, scale: number): Placed {
  const lr = dir === 'LR';
  // Work in (along, across): along = rank axis, across = the stacking axis inside a rank.
  const along = (b: Box) => (lr ? b.w : b.h);
  const across = (b: Box) => (lr ? b.h : b.w);
  const gapAcross = lr ? 36 : 56;
  const gapAlong = lr ? 130 : 90;
  const subGap = lr ? 40 : 60;

  const ranks = new Map<number, { box: Box; o: number }[]>();
  for (const b of boxes) {
    const p = pos.get(b.id)!;
    const key = Math.round(lr ? p.x : p.y);
    if (!ranks.has(key)) ranks.set(key, []);
    ranks.get(key)!.push({ box: b, o: lr ? p.y : p.x });
  }
  const area = boxes.reduce((a, b) => a + (b.w + gapAcross) * (b.h + gapAcross), 0);
  // Across-size budget so that the whole thing is roughly TARGET_ASPECT.
  const acrossBudget = Math.max(...boxes.map(across), scale * Math.sqrt(area / (lr ? TARGET_ASPECT : 1 / TARGET_ASPECT)));

  // 1. split long ranks into sub-columns
  type Group = { width: number; height: number; items: { id: string; a: number; c: number }[] };
  const groups: Group[] = [];
  for (const key of [...ranks.keys()].sort((a, b) => a - b)) {
    const items = ranks.get(key)!.sort((x, y) => x.o - y.o);
    const cols: { boxes: Box[]; size: number }[] = [{ boxes: [], size: 0 }];
    for (const { box } of items) {
      let col = cols[cols.length - 1];
      if (col.boxes.length && col.size + across(box) > acrossBudget) cols.push((col = { boxes: [], size: 0 }));
      col.boxes.push(box);
      col.size += across(box) + gapAcross;
    }
    const group: Group = { width: 0, height: 0, items: [] };
    let a = 0;
    for (const col of cols) {
      const colAlong = Math.max(...col.boxes.map(along));
      let c = (acrossBudget - (col.size - gapAcross)) / 2; // centre each sub-column
      for (const b of col.boxes) {
        group.items.push({ id: b.id, a, c });
        c += across(b) + gapAcross;
      }
      a += colAlong + subGap;
      group.height = Math.max(group.height, col.size - gapAcross);
    }
    group.width = a - subGap;
    groups.push(group);
  }

  // 2. wrap the sequence of ranks into bands when it runs far too long along the rank axis
  const totalAlong = groups.reduce((s, g) => s + g.width + gapAlong, 0) - gapAlong;
  const targetRatio = lr ? TARGET_ASPECT : 1 / TARGET_ASPECT; // along / across
  const bandAlong = totalAlong / acrossBudget > targetRatio * 1.6 ? Math.sqrt(area * targetRatio) / scale : Infinity;
  const out: Placed = new Map();
  let a0 = 0;
  let c0 = 0;
  for (const g of groups) {
    if (a0 > 0 && a0 + g.width > bandAlong) {
      a0 = 0;
      c0 += acrossBudget + gapAlong * 1.5;
    }
    for (const it of g.items) {
      const a = a0 + it.a;
      const c = c0 + it.c;
      out.set(it.id, lr ? { x: a, y: c } : { x: c, y: a });
    }
    a0 += g.width + gapAlong;
  }
  return out;
}

/** Shelf-pack blocks (each a laid-out component) into rows of roughly TARGET_ASPECT. */
function packBlocks(blocks: { pos: Placed; w: number; h: number }[], gap: number): Placed {
  const area = blocks.reduce((a, b) => a + (b.w + gap) * (b.h + gap), 0);
  const rowWidth = Math.max(...blocks.map((b) => b.w), Math.sqrt(area * TARGET_ASPECT));
  const out: Placed = new Map();
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const b of [...blocks].sort((p, q) => q.h - p.h)) {
    if (x > 0 && x + b.w > rowWidth) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    for (const [id, p] of b.pos) out.set(id, { x: p.x + x, y: p.y + y });
    x += b.w + gap;
    rowH = Math.max(rowH, b.h);
  }
  return out;
}

function normalise(pos: Placed, boxes: Box[]): { pos: Placed; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    const p = pos.get(b.id)!;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + b.w);
    maxY = Math.max(maxY, p.y + b.h);
  }
  const out: Placed = new Map();
  for (const b of boxes) {
    const p = pos.get(b.id)!;
    out.set(b.id, { x: p.x - minX, y: p.y - minY });
  }
  return { pos: out, w: maxX - minX, h: maxY - minY };
}

export function computeLayout(
  tables: TableInfo[],
  relations: Relation[],
  dir: Direction,
  keysOnly: boolean,
): Map<string, { x: number; y: number }> {
  const ids = new Set(tables.map(nodeId));
  const edges: [string, string][] = [];
  const connected = new Set<string>();
  for (const r of relations) {
    const a = nodeId(r.from);
    const b = nodeId(r.to);
    if (a !== b && ids.has(a) && ids.has(b)) {
      connected.add(a);
      connected.add(b);
      edges.push([b, a]);
    }
  }
  const box = (t: TableInfo): Box => ({ id: nodeId(t), w: NODE_W, h: nodeHeight(t, keysOnly) });

  if (tables.length > RESHAPE_ABOVE) return computeLargeLayout(tables.map(box), edges, connected, dir);

  const pos = dagreLayout(tables.filter((t) => connected.has(nodeId(t))).map(box), edges, dir);
  let maxY = 0;
  let maxX = 0;
  for (const t of tables) {
    const p = pos.get(nodeId(t));
    if (!p) continue;
    maxY = Math.max(maxY, p.y + nodeHeight(t, keysOnly));
    maxX = Math.max(maxX, p.x + NODE_W);
  }

  // Tables without relations: pack them into a grid next to (or below) the graph.
  const isolated = tables.filter((t) => !connected.has(nodeId(t)));
  if (isolated.length) {
    const cols = Math.max(2, Math.min(6, Math.ceil(Math.sqrt(isolated.length * 1.6))));
    const gap = 36;
    const originX = dir === 'LR' && pos.size ? maxX + 140 : 40;
    const originY = dir === 'LR' || !pos.size ? 40 : maxY + 120;
    const colHeights = new Array(cols).fill(0);
    isolated.forEach((t) => {
      const c = colHeights.indexOf(Math.min(...colHeights));
      pos.set(nodeId(t), { x: originX + c * (NODE_W + gap), y: originY + colHeights[c] });
      colHeights[c] += nodeHeight(t, keysOnly) + gap;
    });
  }
  return pos;
}

/** Large schemas: lay out each group of related tables on its own, reshape it, then pack the groups. */
function computeLargeLayout(boxes: Box[], edges: [string, string][], connected: Set<string>, dir: Direction): Placed {
  // Connected components (union-find).
  const parent = new Map(boxes.map((b) => [b.id, b.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const n = parent.get(x)!;
      parent.set(x, r);
      x = n;
    }
    return r;
  };
  for (const [a, b] of edges) parent.set(find(a), find(b));
  const comps = new Map<string, Box[]>();
  const isolated: Box[] = [];
  for (const b of boxes) {
    if (!connected.has(b.id)) {
      isolated.push(b);
      continue;
    }
    const r = find(b.id);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r)!.push(b);
  }

  const blocks: { pos: Placed; w: number; h: number }[] = [];
  for (const compBoxes of comps.values()) {
    const set = new Set(compBoxes.map((b) => b.id));
    const compEdges = edges.filter(([a, b]) => set.has(a) && set.has(b));
    let pos = dagreLayout(compBoxes, compEdges, dir);
    if (compBoxes.length > 12) pos = reshape(compBoxes, pos, dir);
    blocks.push(normalise(pos, compBoxes));
  }
  if (isolated.length) {
    // A tidy grid block of stand-alone tables.
    const cols = Math.max(2, Math.ceil(Math.sqrt(isolated.length * TARGET_ASPECT)));
    const colHeights = new Array(cols).fill(0);
    const pos: Placed = new Map();
    for (const b of isolated) {
      const c = colHeights.indexOf(Math.min(...colHeights));
      pos.set(b.id, { x: c * (NODE_W + 36), y: colHeights[c] });
      colHeights[c] += b.h + 36;
    }
    blocks.push(normalise(pos, isolated));
  }
  const packed = packBlocks(blocks, 160);
  for (const [id, p] of packed) packed.set(id, { x: p.x + 40, y: p.y + 40 });
  return packed;
}
