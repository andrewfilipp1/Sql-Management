import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  getNodesBounds,
  getViewportForBounds,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore as useFlowStore,
  type Connection,
  ConnectionMode,
  type NodeChange,
} from '@xyflow/react';
import { toPng } from 'html-to-image';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowDownUp,
  ArrowRightLeft,
  Check,
  Download,
  KeyRound,
  LayoutGrid,
  Maximize2,
  PencilRuler,
  RefreshCw,
  Search,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SchemaSnapshot, TableInfo, TableRef } from '../../../shared/types';
import { cn, hueOf, nodeKey as nodeId, relationsOf, type Relation } from '../../lib/utils';
import { addForeignKeySql, COMMON_TYPES } from '../../../shared/dialect';
import { useConnection, useStore } from '../../lib/store';
import { api } from '../../lib/api';
import {
  buildModel,
  compile,
  DRAFT_FK,
  effectiveSchema,
  newColId,
  newTableKey,
  rebaseOps,
  type DesignOp,
  type DesignTable,
  type Step,
} from '../../lib/designer';
import { lintSchema, problemIndex, type Problem } from '../../lib/lint';
import { ChangesPanel, type StepStatus } from './ChangesPanel';
import { COLUMN_TEMPLATES, DesignPalette, DND_TYPE, type PaletteItem } from './DesignPalette';
import { DesignContext, type DesignActions } from './designContext';
import { ProblemsPanel } from './ProblemsPanel';
import { useContextMenu } from '../ui';
import { IconButton, Input, Segmented, Select, softSpring, spring } from '../ui';
import { DataDrawer } from './DataDrawer';
import { computeLayout, NODE_W, visibleColumns, type Direction } from './layout';
import { EdgeMarkers, RelationEdge, type RelationEdgeType } from './RelationEdge';
import { HEADER_HANDLE, TableNode, type ApplyState, type TableNodeType } from './TableNode';

const nodeTypes = { table: TableNode };
const edgeTypes = { relation: RelationEdge };

/** Curated hues (indigo, violet, cyan, teal, pink, sky, fuchsia, amber) for a cohesive palette. */
const HUES = [235, 262, 190, 168, 322, 205, 290, 40];
const tableHue = (id: string) => HUES[hueOf(id) % HUES.length];

interface Props {
  connId: string;
  database: string;
  schema: SchemaSnapshot;
  /** Node id to focus on initially (e.g. opened from the explorer). */
  initialFocus?: string;
  /** Embedded mode: fixed neighbourhood view, no drawer or toolbar. */
  compact?: boolean;
  onOpenTable: (t: TableRef) => void;
  onRefresh?: () => Promise<unknown> | void;
}

function neighbourhood(rels: Relation[], start: string, depth: number): Set<string> {
  const adj = new Map<string, Set<string>>();
  for (const r of rels) {
    const a = nodeId(r.from);
    const b = nodeId(r.to);
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) for (const n of adj.get(id) ?? []) if (!seen.has(n)) (seen.add(n), next.push(n));
    frontier = next;
  }
  return seen;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function Visualizer({ connId, database, schema, initialFocus, compact, onOpenTable, onRefresh }: Props) {
  const flow = useReactFlow<TableNodeType, RelationEdgeType>();
  const [dir, setDir] = useState<Direction>('LR');
  const [keysOnly, setKeysOnly] = useState(false);
  const [animateFlow, setAnimateFlow] = useState(true);
  const [schemaFilter, setSchemaFilter] = useState('');
  const [search, setSearch] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string; depth: number } | null>(
    initialFocus ? { id: initialFocus, depth: compact ? 1 : 2 } : null,
  );
  const [nodes, setNodes] = useState<TableNodeType[]>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const animRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const moving = useRef(false);
  const conn = useConnection(connId);
  const openMenu = useContextMenu();
  const kind = schema.kind;

  // ---- design mode: draft operations over the live schema ----
  const [editing, setEditing] = useState(false);
  const [ops, setOps] = useState<DesignOp[]>([]);
  const [redo, setRedo] = useState<DesignOp[]>([]);
  const [applying, setApplying] = useState(false);
  const [stepStatus, setStepStatus] = useState<Record<number, StepStatus>>({});
  const [applyMap, setApplyMap] = useState<Record<string, { state: ApplyState; error?: string; tick: number }>>({});
  const [autoEdit, setAutoEdit] = useState<{ key: string; column: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(false);
  /** Positions to keep for tables whose node id changes (created or renamed by Apply). */
  const aliasPos = useRef(new Map<string, { x: number; y: number }>());
  const keepNext = useRef(false);

  const model = useMemo(() => buildModel(schema, ops), [schema, ops]);
  const view = useMemo(() => (ops.length ? effectiveSchema(schema, model) : schema), [schema, model, ops.length]);
  const steps = useMemo(() => compile(kind, model, ops), [kind, model, ops]);
  const problems = useMemo(() => lintSchema(view, kind, steps), [view, kind, steps]);
  const pIndex = useMemo(() => problemIndex(problems), [problems]);
  const blocking = problems.filter((p) => p.severity === 'error' && p.draft).length;
  const errorCount = problems.filter((p) => p.severity === 'error').length;
  const warnCount = problems.filter((p) => p.severity === 'warning').length;

  useEffect(() => {
    if (initialFocus) {
      setFocus({ id: initialFocus, depth: compact ? 1 : 2 });
      if (!compact) setSelected(initialFocus);
    }
  }, [initialFocus, compact]);

  const allRelations = useMemo(() => relationsOf(view), [view]);
  const byId = useMemo(() => new Map(view.tables.map((t) => [nodeId(t), t])), [view]);

  const visibleTables = useMemo(() => {
    let tables = view.tables;
    if (schemaFilter) tables = tables.filter((t) => (t.schema ?? '') === schemaFilter);
    if (focus) {
      const keep = neighbourhood(allRelations, focus.id, focus.depth);
      tables = tables.filter((t) => keep.has(nodeId(t)));
    }
    // Tables created in the draft are always shown, even while focusing.
    if (focus) tables = [...tables, ...view.tables.filter((t) => (t as DesignTable).design?.table === 'new' && !tables.includes(t))];
    return tables;
  }, [view, schemaFilter, focus, allRelations]);

  const visibleIds = useMemo(() => new Set(visibleTables.map(nodeId)), [visibleTables]);
  /** Large schemas: render only what is on screen. */
  const big = visibleTables.length > 80;
  /** Many tables on screen at once (zoomed out on a large schema): skip the costliest effects (blur filters). */
  const [crowded, setCrowded] = useState(true); // large diagrams open zoomed out to fit
  const lite = big && crowded;
  // Level of detail: below this zoom a large diagram draws simple blocks (columns are unreadable anyway).
  const far = useFlowStore((st) => st.transform[2] < 0.4) && big;
  const relations = useMemo(
    () => allRelations.filter((r) => visibleIds.has(nodeId(r.from)) && visibleIds.has(nodeId(r.to))),
    [allRelations, visibleIds],
  );

  // ---- layout, tweened from the current positions ----
  const layoutKey = `${[...visibleIds].join('|')}::${dir}::${keysOnly}::${schema.loadedAt}::${editing}`;
  const layoutParams = useRef('');
  const runLayout = useCallback(
    (fit = true, force = false) => {
      const target = computeLayout(visibleTables, relations, dir, keysOnly);
      const prev = new Map(nodesRef.current.map((n) => [n.id, n.position]));
      // While designing (or right after Apply) tables stay where they are; new ones appear where they were dropped.
      const params = `${dir}|${keysOnly}|${editing}`;
      const keep = !force && layoutParams.current === params && prev.size > 0 && (editing || ops.length > 0 || keepNext.current);
      layoutParams.current = params;
      keepNext.current = false;
      if (keep) {
        const created = new Map(ops.flatMap((o) => (o.t === 'createTable' ? [[o.key, o.position] as const] : [])));
        for (const t of visibleTables) {
          const id = nodeId(t);
          const p = prev.get(id) ?? created.get(id) ?? aliasPos.current.get(id);
          if (p) target.set(id, p);
        }
        fit = false;
      }
      const base: TableNodeType[] = visibleTables.map((t, index) => {
        const id = nodeId(t);
        return {
          id,
          type: 'table',
          position: prev.get(id) ?? target.get(id)!,
          data: { table: t, hue: tableHue(id), keysOnly, index },
          width: NODE_W,
        };
      });
      cancelAnimationFrame(animRef.current);
      const t0 = performance.now();
      const DURATION = prev.size ? 650 : 0;
      const step = (now: number) => {
        const k = DURATION ? easeInOut(Math.min(1, (now - t0) / DURATION)) : 1;
        setNodes((cur) => {
          // Keep React Flow's measured size: a node without it is hidden until re-measured,
          // which made every animation frame hide the nodes (and steal focus from inline editors).
          const measured = new Map(cur.map((c) => [c.id, c.measured]));
          return base.map((n) => {
            const to = target.get(n.id)!;
            return { ...n, measured: measured.get(n.id), position: { x: n.position.x + (to.x - n.position.x) * k, y: n.position.y + (to.y - n.position.y) * k } };
          });
        });
        if (k < 1) animRef.current = requestAnimationFrame(step);
        else if (fit && containerRef.current?.clientWidth) {
          // While designing, keep tables clear of the palette (left) and the changes panel (bottom).
          const padding = editing ? ({ left: '230px', top: '70px', right: '40px', bottom: '170px' } as const) : 0.14;
          setTimeout(() => void flow.fitView({ padding, duration: 700, maxZoom: 1.1 }), 30);
        }
      };
      animRef.current = requestAnimationFrame(step);
    },
    [visibleTables, relations, dir, keysOnly, flow, editing, ops],
  );

  useEffect(() => {
    runLayout();
    return () => cancelAnimationFrame(animRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  // Count the tables inside the visible area; full glass effects come back when zoomed in on a few.
  const measureCrowding = useCallback(() => {
    const el = containerRef.current;
    if (!el || !big) return setCrowded(false);
    const { x, y, zoom } = flow.getViewport();
    const left = -x / zoom;
    const top = -y / zoom;
    const right = left + el.clientWidth / zoom;
    const bottom = top + el.clientHeight / zoom;
    let n = 0;
    for (const node of nodesRef.current) {
      const h = node.measured?.height ?? 200;
      if (node.position.x < right && node.position.x + NODE_W > left && node.position.y < bottom && node.position.y + h > top) n++;
    }
    setCrowded(n > 40);
  }, [big, flow]);

  useEffect(() => {
    const t = setTimeout(measureCrowding, 900); // after the layout tween and fit
    return () => clearTimeout(t);
  }, [layoutKey, measureCrowding]);

  const onNodesChange = useCallback((changes: NodeChange<TableNodeType>[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
  }, []);

  // ---- highlighting ----
  const anchor = hovered ?? selected;
  const activeRelations = useMemo(
    () => (anchor ? relations.filter((r) => nodeId(r.from) === anchor || nodeId(r.to) === anchor) : []),
    [anchor, relations],
  );
  const lit = useMemo(() => {
    const s = new Set<string>();
    if (anchor) s.add(anchor);
    for (const r of activeRelations) (s.add(nodeId(r.from)), s.add(nodeId(r.to)));
    return s;
  }, [anchor, activeRelations]);
  const activeColumns = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (id: string, cols: string[]) => {
      if (!m.has(id)) m.set(id, new Set());
      cols.forEach((c) => m.get(id)!.add(c));
    };
    for (const r of activeRelations) (add(nodeId(r.from), r.fromColumns), add(nodeId(r.to), r.toColumns));
    return m;
  }, [activeRelations]);

  const q = search.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? visibleTables.filter((t) => t.name.toLowerCase().includes(q)).map(nodeId) : []),
    [q, visibleTables],
  );

  const displayNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        className: anchor && !lit.has(n.id) ? 'dimmed' : q && !matches.includes(n.id) ? 'dimmed' : undefined,
        data: {
          ...n.data,
          // The draft changes tables without changing node ids, so always read the current definition.
          table: byId.get(n.id) ?? n.data.table,
          highlighted: hovered === n.id || (!!anchor && lit.has(n.id) && anchor !== n.id),
          selected: selected === n.id,
          matched: matches.includes(n.id),
          activeColumns: activeColumns.get(n.id),
          connectable: !compact && (editing || kind !== 'sqlite'),
          editing,
          design: (byId.get(n.id) as DesignTable | undefined)?.design,
          problems: compact ? undefined : pIndex.byKey.get(n.id)?.filter((p) => p.severity !== 'info'),
          apply: applyMap[n.id],
          dropTarget: dropTarget === n.id,
          lite,
          far,
        },
      })),
    [nodes, anchor, lit, hovered, selected, q, matches, activeColumns, byId, compact, editing, kind, pIndex, applyMap, dropTarget, lite, far],
  );

  const edges = useMemo(() => {
    const pos = new Map(nodes.map((n) => [n.id, n.position]));
    const out: RelationEdgeType[] = [];
    const activeIds = new Set(activeRelations.map((r) => r.id));
    for (const r of relations) {
      const a = nodeId(r.from);
      const b = nodeId(r.to);
      const pa = pos.get(a);
      const pb = pos.get(b);
      if (!pa || !pb) continue;
      const self = a === b;
      const forward = pa.x + NODE_W / 2 <= pb.x + NODE_W / 2;
      const overlapX = Math.abs(pa.x - pb.x) < NODE_W * 0.8;
      const sSide = self || overlapX ? 'R' : forward ? 'R' : 'L';
      const tSide = self || overlapX ? 'R' : forward ? 'L' : 'R';
      const shown = (t: TableInfo, col: string) =>
        !far && visibleColumns(t, keysOnly, editing).columns.some((c) => c.name === col) ? col : HEADER_HANDLE;
      const active = activeIds.has(r.id);
      out.push({
        id: r.id,
        type: 'relation',
        source: a,
        target: b,
        sourceHandle: `${shown(r.from, r.fromColumns[0])}:${sSide}:s`,
        targetHandle: `${shown(r.to, r.toColumns[0])}:${tSide}:t`,
        zIndex: active ? 10 : 0,
        data: {
          active,
          dimmed: !!anchor && !active,
          flow: animateFlow && (active || relations.length <= 160),
          // Labels only stay readable when a handful of relations are lit at once.
          label: active && activeIds.size <= 4 ? `${r.fromColumns.join(', ')} → ${r.to.name}.${r.toColumns.join(', ')}` : '',
          hue: tableHue(b),
          problem: compact ? undefined : pIndex.byRelation.get(r.id),
          draft: r.name.startsWith(DRAFT_FK),
          removed: (r.from as DesignTable).design?.table === 'deleted' || (r.to as DesignTable).design?.table === 'deleted',
          lite,
        },
      });
    }
    return out;
  }, [nodes, relations, activeRelations, anchor, animateFlow, keysOnly, pIndex, compact, editing, lite, far]);

  // ---- drag a column onto another table's column → foreign key ----
  const [connecting, setConnecting] = useState(false);
  const connectFrom = useRef<string | null>(null);
  const onConnect = useCallback(
    (conn: Connection) => {
      // The table the drag started from is always the referencing side (React Flow may report it reversed).
      const c =
        connectFrom.current && conn.target === connectFrom.current && conn.source !== conn.target
          ? { source: conn.target, sourceHandle: conn.targetHandle, target: conn.source, targetHandle: conn.sourceHandle }
          : conn;
      // Handle ids are "<column>:<side>:<s|t>"; the column name itself may contain ':'.
      const col = (h?: string | null) => (h ? h.split(':').slice(0, -2).join(':') : '');
      const from = byId.get(c.source);
      const to = byId.get(c.target);
      const fromCol = col(c.sourceHandle);
      const toCol = col(c.targetHandle);
      if (!from || !to || !fromCol || !toCol || fromCol === HEADER_HANDLE || toCol === HEADER_HANDLE) {
        useStore.getState().toast('Drop the line on a column of the other table', 'info');
        return;
      }
      if (from === to && fromCol === toCol) return;
      if (editing) {
        const fc = model.get(c.source)?.cols.find((x) => x.name === fromCol && !x.deleted);
        const tc = model.get(c.target)?.cols.find((x) => x.name === toCol && !x.deleted);
        if (fc && tc) push([{ t: 'addFk', key: c.source, colId: fc.id, refKey: c.target, refColId: tc.id }]);
        return;
      }
      const sql = addForeignKeySql(schema.kind, from, {
        name: `fk_${from.name}_${fromCol}`.slice(0, 60),
        columns: [fromCol],
        refTable: { schema: to.schema, name: to.name },
        refColumns: [toCol],
      });
      if (!sql) {
        useStore.getState().toast('SQLite cannot add a foreign key to an existing table', 'error');
        return;
      }
      useStore.getState().confirmSql({
        connId,
        database,
        title: `New relationship: ${from.name}.${fromCol} → ${to.name}.${toCol}`,
        description: `Every value of ${from.name}.${fromCol} must exist in ${to.name}.${toCol} (usually its primary key).`,
        sql,
        onDone: onRefresh,
      });
    },
    [byId, schema.kind, connId, database, onRefresh, editing, model], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- design actions ----
  const push = useCallback((add: DesignOp[]) => {
    setOps((o) => [...o, ...add]);
    setRedo([]);
  }, []);

  const colId = (key: string, name: string, deleted = false) => model.get(key)?.cols.find((c) => c.name === name && c.deleted === deleted)?.id;

  const uniqueName = (base: string, taken: string[]) => {
    const set = new Set(taken.map((x) => x.toLowerCase()));
    if (!set.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) if (!set.has(`${base}_${i}`.toLowerCase())) return `${base}_${i}`;
  };

  const design: DesignActions = useMemo(
    () => ({
      editing,
      typesListId: `types-${kind}`,
      autoEdit,
      renameTable: (key, name) => push([{ t: 'renameTable', key, name }]),
      dropTable: (key) => {
        if (model.get(key)?.created) {
          // A table that only exists in the draft simply disappears with everything that refers to it.
          setOps((o) => o.filter((op) => op.key !== key && !(op.t === 'addFk' && op.refKey === key)));
        } else push([{ t: 'dropTable', key }]);
      },
      restoreTable: (key) => setOps((o) => o.filter((op) => !(op.t === 'dropTable' && op.key === key))),
      addColumn: (key) => {
        const t = model.get(key);
        if (!t) return;
        const name = uniqueName('column', t.cols.map((c) => c.name));
        push([{ t: 'addColumn', key, colId: newColId(), col: { name, type: COLUMN_TEMPLATES[2].make(kind).type, nullable: true, pk: false, identity: false } }]);
        setAutoEdit({ key, column: name });
      },
      renameColumn: (key, column, name) => {
        const id = colId(key, column);
        if (id) push([{ t: 'renameColumn', key, colId: id, name }]);
      },
      setType: (key, column, type) => {
        const id = colId(key, column);
        if (id) push([{ t: 'alterColumn', key, colId: id, type }]);
      },
      toggleNullable: (key, column) => {
        const c = model.get(key)?.cols.find((x) => x.name === column && !x.deleted);
        if (c) push([{ t: 'alterColumn', key, colId: c.id, nullable: !c.nullable }]);
      },
      togglePk: (key, column) => {
        const c = model.get(key)?.cols.find((x) => x.name === column && !x.deleted);
        if (c) push([{ t: 'alterColumn', key, colId: c.id, pk: !c.pk, ...(c.pk ? {} : { nullable: false }) }]);
      },
      dropColumn: (key, column) => {
        const id = colId(key, column);
        if (id) push([{ t: 'dropColumn', key, colId: id }]);
      },
      restoreColumn: (key, column) => {
        const id = colId(key, column, true);
        if (id) setOps((o) => o.filter((op) => !(op.t === 'dropColumn' && op.key === key && op.colId === id)));
      },
    }),
    [editing, kind, autoEdit, model, push], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- drag & drop from the palette ----
  const nodeAt = (x: number, y: number) =>
    (document.elementsFromPoint(x, y).find((el) => el.classList.contains('react-flow__node')) as HTMLElement | undefined)?.dataset.id ?? null;

  const onDragOver = (e: React.DragEvent) => {
    if (!editing || !e.dataTransfer.types.includes(DND_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const k = nodeAt(e.clientX, e.clientY);
    if (k !== dropTarget) setDropTarget(k);
  };

  const onDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData(DND_TYPE);
    setDropTarget(null);
    if (!editing || !raw) return;
    e.preventDefault();
    const item = JSON.parse(raw) as PaletteItem;
    const targetKey = nodeAt(e.clientX, e.clientY);
    const target = targetKey ? model.get(targetKey) : undefined;
    const tableNames = [...model.values()].filter((t) => !t.deleted).map((t) => t.name);

    if (item.kind === 'table') {
      const key = newTableKey();
      const name = uniqueName('new_table', tableNames);
      const position = flow.screenToFlowPosition({ x: e.clientX - NODE_W / 2, y: e.clientY - 22 });
      const defaultSchema = kind === 'postgres' ? (schemaFilter || 'public') : kind === 'mssql' ? (schemaFilter || 'dbo') : undefined;
      push([
        { t: 'createTable', key, name, schema: defaultSchema, position },
        { t: 'addColumn', key, colId: newColId(), col: COLUMN_TEMPLATES[0].make(kind) },
      ]);
      setAutoEdit({ key, column: '' });
      return;
    }
    if (!target || target.deleted || target.orig?.type === 'view') {
      useStore.getState().toast('Drop it onto a table', 'info');
      return;
    }
    if (item.kind === 'column') {
      const tpl = COLUMN_TEMPLATES.find((t) => t.id === item.template)!;
      const col = tpl.make(kind);
      if (col.pk && target.cols.some((c) => c.pk && !c.deleted)) {
        useStore.getState().toast(`${target.name} already has a primary key`, 'info');
        return;
      }
      const name = uniqueName(col.name, target.cols.map((c) => c.name));
      push([{ t: 'addColumn', key: target.key, colId: newColId(), col: { ...col, name } }]);
      setAutoEdit({ key: target.key, column: name });
      return;
    }
    // Reference: pick the table it points to, then add <table>_id plus the relationship.
    const candidates = [...model.values()].filter((t) => t.key !== target.key && !t.deleted && t.orig?.type !== 'view' && t.cols.filter((c) => c.pk && !c.deleted).length === 1);
    if (!candidates.length) {
      useStore.getState().toast('No other table with a single-column primary key to point to', 'info');
      return;
    }
    openMenu(
      e,
      candidates.map((ref) => ({
        label: `→ ${ref.name}`,
        onClick: () => {
          const pk = ref.cols.find((c) => c.pk && !c.deleted)!;
          const name = uniqueName(`${ref.name.replace(/s$/i, '')}_id`, target.cols.map((c) => c.name));
          // Same type as the referenced key, without its auto-increment.
          const type = /serial/i.test(pk.type) ? pk.type.replace(/bigserial/i, 'bigint').replace(/serial/i, 'integer') : pk.type;
          const id = newColId();
          push([
            { t: 'addColumn', key: target.key, colId: id, col: { name, type, nullable: true, pk: false, identity: false } },
            { t: 'addFk', key: target.key, colId: id, refKey: ref.key, refColId: pk.id },
          ]);
        },
      })),
    );
  };

  // ---- apply the draft, one statement at a time ----
  const markNode = (key: string, state: ApplyState, error?: string) =>
    setApplyMap((m) => ({ ...m, [key]: { state, error, tick: (m[key]?.tick ?? 0) + 1 } }));

  const applyDraft = async () => {
    if (blocking) {
      setProblemsOpen(true);
      return;
    }
    setApplying(true);
    setStepStatus({});
    setApplyMap({});
    const done: Step[] = [];
    let failure: string | null = null;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      setStepStatus((x) => ({ ...x, [i]: 'running' }));
      markNode(st.key, 'running');
      try {
        // The user reviewed these statements in the Changes panel, so they count as confirmed.
        await api.query(connId, database, st.sql!, { confirmed: true });
        done.push(st);
        setStepStatus((x) => ({ ...x, [i]: 'done' }));
        markNode(st.key, 'done');
        if (st.rebase?.key) markNode(st.rebase.key[1], 'done');
      } catch (err) {
        failure = (err as Error).message;
        setStepStatus((x) => ({ ...x, [i]: 'failed' }));
        markNode(st.key, 'failed', failure);
        break;
      }
    }
    for (const st of done) {
      if (!st.rebase?.key) continue;
      const n = nodesRef.current.find((x) => x.id === st.rebase!.key![0]);
      if (n) aliasPos.current.set(st.rebase.key[1], n.position);
    }
    keepNext.current = true;
    const rest = rebaseOps(ops, done);
    await onRefresh?.();
    skipClear.current = true;
    setOps(rest);
    setRedo([]);
    setApplying(false);
    // The failed step is now the first remaining one; keep it marked until the next edit.
    setStepStatus(failure ? { 0: 'failed' } : {});
    if (failure) {
      useStore.getState().toast(`${done.length} of ${steps.length} change(s) applied — stopped at: ${failure}`, 'error');
    } else {
      useStore.getState().toast(`Applied ${done.length} change(s)`, 'success');
    }
    // Let the success animations finish, keep failures visible until the next edit.
    setTimeout(() => setApplyMap((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v.state === 'failed'))), 2200);
  };

  // Clear a failure highlight as soon as the user changes something (but not for the rebase right after Apply).
  const skipClear = useRef(false);
  useEffect(() => {
    if (skipClear.current) {
      skipClear.current = false;
      return;
    }
    setApplyMap((m) => (Object.keys(m).length ? {} : m));
    setStepStatus((x) => (Object.keys(x).length ? {} : x));
  }, [ops]);

  // Read the latest lists from refs so the state updaters stay pure (StrictMode runs them twice).
  const opsRef = useRef(ops);
  opsRef.current = ops;
  const redoRef = useRef(redo);
  redoRef.current = redo;
  const undo = useCallback(() => {
    const last = opsRef.current[opsRef.current.length - 1];
    if (!last) return;
    skipClear.current = false;
    setOps(opsRef.current.slice(0, -1));
    setRedo([...redoRef.current, last]);
  }, []);
  const redoOp = useCallback(() => {
    const next = redoRef.current[redoRef.current.length - 1];
    if (!next) return;
    setRedo(redoRef.current.slice(0, -1));
    setOps([...opsRef.current, next]);
  }, []);

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) redoOp();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, undo, redoOp]);

  // Shake the problems button when the number of problems grows.
  const prevProblemCount = useRef(errorCount + warnCount);
  const [problemPulse, setProblemPulse] = useState(0);
  useEffect(() => {
    if (errorCount + warnCount > prevProblemCount.current) setProblemPulse((n) => n + 1);
    prevProblemCount.current = errorCount + warnCount;
  }, [errorCount, warnCount]);

  const focusProblem = (p: Problem) => {
    const n = nodesRef.current.find((x) => x.id === p.key);
    if (!n) return;
    setHovered(p.key);
    setTimeout(() => setHovered(null), 1600);
    void flow.setCenter(n.position.x + NODE_W / 2, n.position.y + 120, { zoom: Math.max(flow.getZoom(), 0.9), duration: 600 });
  };

  // ---- actions ----
  const selectTable = useCallback(
    (id: string, center = false) => {
      setSelected(id);
      const n = nodesRef.current.find((x) => x.id === id);
      if (!n || compact) return;
      // Keep the table visible to the left of the drawer (≈620px wide).
      const zoom = center ? Math.max(flow.getZoom(), 0.85) : flow.getZoom();
      const screen = flow.flowToScreenPosition({ x: n.position.x + NODE_W, y: n.position.y });
      const pane = document.querySelector('.schema-flow')?.getBoundingClientRect();
      const hidden = pane ? screen.x > pane.right - 650 : true;
      if (center || hidden) {
        void flow.setCenter(n.position.x + NODE_W / 2 + 330 / zoom, n.position.y + 140 / zoom, { zoom, duration: 650 });
      }
    },
    [flow, compact],
  );

  const exportPng = async () => {
    const el = document.querySelector<HTMLElement>('.schema-flow .react-flow__viewport');
    if (!el) return;
    const bounds = getNodesBounds(flow.getNodes());
    const width = Math.min(8000, Math.max(1200, bounds.width + 160));
    const height = Math.min(8000, Math.max(800, bounds.height + 160));
    const vp = getViewportForBounds(bounds, width, height, 0.2, 2, 0.08);
    const url = await toPng(el, {
      backgroundColor: '#070912',
      width,
      height,
      pixelRatio: 2,
      style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
    });
    const a = document.createElement('a');
    a.href = url;
    a.download = `${database}-schema.png`;
    a.click();
  };

  // A diagram laid out while its tab was hidden (zero-sized) needs a refit once it becomes visible.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let wasHidden = el.clientWidth === 0;
    const ro = new ResizeObserver(() => {
      const hidden = el.clientWidth === 0;
      if (wasHidden && !hidden) requestAnimationFrame(() => void flow.fitView({ padding: 0.14, maxZoom: 1.1 }));
      wasHidden = hidden;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [flow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selectedTable = selected ? byId.get(selected) : undefined;

  return (
    <DesignContext.Provider value={design}>
    <div
      ref={containerRef}
      className={cn('schema-flow relative h-full w-full', connecting && 'is-connecting')}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
      }}
    >
      <EdgeMarkers />
      <datalist id={`types-${kind}`}>
        {COMMON_TYPES[kind].map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <ReactFlow
        nodes={displayNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeMouseEnter={(_, n) => !moving.current && setHovered(n.id)}
        onNodeMouseLeave={() => !moving.current && setHovered(null)}
        // While the canvas pans/zooms the pointer sweeps across tables; re-highlighting every node and
        // line on each crossing made large diagrams stutter.
        onMoveStart={() => {
          moving.current = true;
          setHovered(null);
        }}
        onMoveEnd={() => {
          moving.current = false;
          measureCrowding();
        }}
        onNodeClick={(_, n) => (compact ? onOpenTable(byId.get(n.id)!) : !editing && selectTable(n.id))}
        onNodeDoubleClick={(_, n) => !editing && !n.id.startsWith('new:') && onOpenTable(byId.get(n.id)!)}
        deleteKeyCode={null}
        onlyRenderVisibleElements={big}
        onPaneClick={() => setSelected(null)}
        nodesConnectable={!compact}
        connectionMode={ConnectionMode.Loose}
        onConnectStart={(_, params) => {
          setConnecting(true);
          connectFrom.current = params.nodeId;
        }}
        onConnectEnd={(event, state) => {
          setConnecting(false);
          // Dropping anywhere on a column row counts, not only on its (invisible) handle at the table edge.
          if (state.isValid || !state.fromNode || !state.fromHandle?.id) return;
          const pt = 'changedTouches' in event ? event.changedTouches[0] : event;
          const row = document.elementFromPoint(pt.clientX, pt.clientY)?.closest<HTMLElement>('[data-column]');
          const nodeEl = row?.closest<HTMLElement>('.react-flow__node');
          if (!row || !nodeEl?.dataset.id) return;
          onConnect({ source: state.fromNode.id, sourceHandle: state.fromHandle.id, target: nodeEl.dataset.id, targetHandle: `${row.dataset.column}:L:t` });
        }}
        connectionRadius={28}
        onConnect={onConnect}
        minZoom={0.08}
        maxZoom={2}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--grid-dot)" />
        {!compact && <Controls position="bottom-left" showInteractive={false} />}
        {!compact && !selectedTable && (
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            maskColor="rgb(7 9 18 / 0.7)"
            nodeColor={(n) => `hsl(${(n.data as { hue: number }).hue} 80% 62% / 0.85)`}
            nodeBorderRadius={6}
          />
        )}
      </ReactFlow>

      {/* Toolbar */}
      {!compact && (
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={softSpring}
          className="glass absolute top-3 left-3 z-10 flex items-center gap-1.5 rounded-xl p-1.5 shadow-[var(--shadow)]"
        >
          <div className="w-56">
            <Input
              icon={<Search className="size-3.5" />}
              placeholder="Find table…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && matches[0]) selectTable(matches[0], true);
                if (e.key === 'Escape') setSearch('');
              }}
              className="h-7"
            />
          </div>
          <Segmented
            layoutId="diagram-dir"
            value={dir}
            onChange={setDir}
            options={[
              { value: 'LR', label: '', icon: <ArrowRightLeft className="size-3.5" /> },
              { value: 'TB', label: '', icon: <ArrowDownUp className="size-3.5" /> },
            ]}
          />
          <IconButton label="Show keys only" active={keysOnly} onClick={() => setKeysOnly((v) => !v)}>
            <KeyRound className="size-4" />
          </IconButton>
          <IconButton label="Animated relationship flow" active={animateFlow} onClick={() => setAnimateFlow((v) => !v)}>
            <Sparkles className="size-4" />
          </IconButton>
          <IconButton label="Re-arrange" onClick={() => runLayout(true, true)}>
            <LayoutGrid className="size-4" />
          </IconButton>
          <IconButton label="Fit to screen" onClick={() => void flow.fitView({ padding: 0.14, duration: 600 })}>
            <Maximize2 className="size-4" />
          </IconButton>
          <IconButton label="Export as PNG" onClick={() => void exportPng()}>
            <Download className="size-4" />
          </IconButton>
          {onRefresh && (
            <IconButton label="Reload schema" onClick={() => void onRefresh()}>
              <RefreshCw className="size-4" />
            </IconButton>
          )}
          <div className="mx-0.5 h-5 w-px bg-line" />
          <motion.button
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            transition={spring}
            disabled={!!conn?.readOnly}
            title={conn?.readOnly ? 'This connection is read-only' : editing ? 'Finish editing (changes stay pending until you apply them)' : 'Design the schema: drag tables and columns, edit in place'}
            onClick={() => {
              setEditing((v) => !v);
              setSelected(null);
            }}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-[background-color,box-shadow,color] disabled:opacity-40',
              editing
                ? 'bg-emerald-400/20 text-emerald-100 shadow-[0_0_0_1px_rgb(52_211_153/0.5),0_0_18px_-4px_rgb(52_211_153/0.8)]'
                : 'text-muted hover:bg-white/6 hover:text-fg',
            )}
          >
            {editing ? <Check className="size-3.5" /> : <PencilRuler className="size-3.5" />}
            {editing ? 'Done' : 'Edit'}
          </motion.button>
          <button
            key={problemPulse}
            onClick={() => setProblemsOpen((v) => !v)}
            title="Schema problems"
            className={cn(
              'flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors hover:bg-white/6',
              problemPulse > 0 && 'badge-shake',
              problemsOpen && 'bg-white/6',
            )}
          >
            {errorCount > 0 && (
              <span className="flex items-center gap-0.5 text-danger">
                <XCircle className="size-3.5" /> {errorCount}
              </span>
            )}
            <span className={cn('flex items-center gap-0.5', warnCount ? 'text-warn' : 'text-muted')}>
              <AlertTriangle className="size-3.5" /> {warnCount}
            </span>
          </button>
          {schema.schemas.length > 1 && (
            <Select value={schemaFilter} onChange={(e) => setSchemaFilter(e.target.value)} className="h-7 text-xs">
              <option value="">All schemas</option>
              {schema.schemas.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          )}
        </motion.div>
      )}

      {/* Stats / focus chip */}
      {!compact && (
        <div className="pointer-events-none absolute top-3 right-3 z-10">
          <AnimatePresence mode="popLayout">
            {focus ? (
              <motion.div
                key="focus"
                initial={{ opacity: 0, y: -10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10 }}
                transition={spring}
                className="glass glow pointer-events-auto flex items-center gap-2 rounded-full py-1 pr-1 pl-3 text-xs"
              >
                <span className="text-muted">Focus</span>
                <span className="font-semibold">{byId.get(focus.id)?.name ?? focus.id}</span>
                <span className="text-muted">depth</span>
                {[1, 2, 3].map((d) => (
                  <button
                    key={d}
                    onClick={() => setFocus({ ...focus, depth: d })}
                    className={cn(
                      'size-5 rounded-full text-[11px] transition-colors',
                      focus.depth === d ? 'bg-accent text-white shadow-[0_0_12px_rgb(129_140_248/0.8)]' : 'text-muted hover:bg-white/10',
                    )}
                  >
                    {d}
                  </button>
                ))}
                <IconButton label="Clear focus" onClick={() => setFocus(null)} className="size-6">
                  <X className="size-3.5" />
                </IconButton>
              </motion.div>
            ) : (
              <motion.div
                key="stats"
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="glass rounded-full px-3 py-1 text-xs text-muted"
              >
                <span className="font-semibold text-fg">{visibleTables.length}</span> tables ·{' '}
                <span className="font-semibold text-fg">{relations.length}</span> relationships
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Data drawer */}
      <AnimatePresence>
        {!compact && selectedTable && (
          <DataDrawer
            key="drawer"
            connId={connId}
            database={database}
            schema={schema}
            table={selectedTable}
            hue={tableHue(selected!)}
            onClose={() => setSelected(null)}
            onSelect={(t) => {
              const id = nodeId(t);
              if (!visibleIds.has(id)) setFocus(null);
              setTimeout(() => selectTable(id, true), 0);
            }}
            onFocus={() => setFocus({ id: selected!, depth: 1 })}
            onOpen={() => onOpenTable(selectedTable)}
            problems={pIndex.byKey.get(selected!)}
            onFix={(p) =>
              useStore.getState().confirmSql({ connId, database, title: p.fix!.label, description: p.title, sql: p.fix!.sql, onDone: () => void onRefresh?.() })
            }
          />
        )}
      </AnimatePresence>

      {/* Design mode */}
      <AnimatePresence>{editing && !compact && <DesignPalette key="palette" />}</AnimatePresence>
      <AnimatePresence>
        {!compact && (ops.length > 0 || applying) && (
          <ChangesPanel
            key="changes"
            kind={kind}
            steps={steps}
            status={stepStatus}
            blockingErrors={blocking}
            applying={applying}
            production={conn?.environment === 'production'}
            canUndo={ops.length > 0}
            canRedo={redo.length > 0}
            onUndo={undo}
            onRedo={redoOp}
            onRemove={(st) => setOps((o) => o.filter((_, i) => !st.ops.includes(i)))}
            onDiscard={() => (setOps([]), setRedo([]))}
            onApply={() => void applyDraft()}
            onShowProblems={() => setProblemsOpen(true)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {problemsOpen && !compact && (
          <ProblemsPanel
            key="problems"
            problems={problems}
            onClose={() => setProblemsOpen(false)}
            onSelect={focusProblem}
            onFix={(p) =>
              useStore.getState().confirmSql({ connId, database, title: p.fix!.label, description: p.title, sql: p.fix!.sql, onDone: () => void onRefresh?.() })
            }
          />
        )}
      </AnimatePresence>
    </div>
    </DesignContext.Provider>
  );
}

export function SchemaVisualizer(props: Props) {
  return (
    <ReactFlowProvider>
      <Visualizer {...props} />
    </ReactFlowProvider>
  );
}
