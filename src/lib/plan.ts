import type { RawPlan } from '../../shared/types';

/** Engine-neutral execution plan node. */
export interface PlanNode {
  id: string;
  label: string;
  detail?: string;
  /** Estimated rows. */
  rows?: number;
  /** Actual rows (ANALYZE / actual plan). */
  actualRows?: number;
  /** Cumulative cost of this subtree (engine units). */
  cost?: number;
  /** Actual time in ms (ANALYZE). */
  timeMs?: number;
  /** Full scan of a table: usually the first thing to look at. */
  fullScan?: boolean;
  extra: [string, string][];
  children: PlanNode[];
}

let seq = 0;
const node = (p: Omit<PlanNode, 'id' | 'children' | 'extra'> & Partial<Pick<PlanNode, 'children' | 'extra'>>): PlanNode => ({
  id: `p${seq++}`,
  children: [],
  extra: [],
  ...p,
});
const num = (v: unknown) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? undefined : Number(v));

// ---- PostgreSQL: EXPLAIN (FORMAT JSON) ----
function fromPg(data: unknown): PlanNode {
  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  const walk = (p: Record<string, any>): PlanNode => {
    const label = [p['Join Type'] && p['Node Type'] !== 'Hash' ? p['Join Type'] : '', p['Node Type']].filter(Boolean).join(' ');
    const detail = [p['Relation Name'] && `${p['Schema'] ? p['Schema'] + '.' : ''}${p['Relation Name']}`, p['Index Name'] && `using ${p['Index Name']}`, p['Alias'] && p['Alias'] !== p['Relation Name'] ? `as ${p['Alias']}` : '']
      .filter(Boolean)
      .join(' ');
    const extra: [string, string][] = [];
    for (const k of ['Filter', 'Index Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Recheck Cond', 'Sort Key', 'Group Key', 'Rows Removed by Filter', 'Shared Hit Blocks', 'Shared Read Blocks']) {
      if (p[k] !== undefined) extra.push([k, Array.isArray(p[k]) ? p[k].join(', ') : String(p[k])]);
    }
    return node({
      label,
      detail,
      rows: num(p['Plan Rows']),
      actualRows: p['Actual Rows'] !== undefined ? Number(p['Actual Rows']) * Number(p['Actual Loops'] ?? 1) : undefined,
      cost: num(p['Total Cost']),
      timeMs: p['Actual Total Time'] !== undefined ? Number(p['Actual Total Time']) * Number(p['Actual Loops'] ?? 1) : undefined,
      fullScan: p['Node Type'] === 'Seq Scan',
      extra,
      children: (p['Plans'] ?? []).map(walk),
    });
  };
  return walk(parsed[0].Plan);
}

// ---- MySQL: EXPLAIN FORMAT=JSON ----
const MYSQL_OPS = new Set(['ordering_operation', 'grouping_operation', 'duplicates_removal', 'windowing', 'buffer_result', 'materialized_from_subquery', 'union_result']);
const ACCESS: Record<string, string> = {
  ALL: 'Full table scan',
  index: 'Full index scan',
  range: 'Index range scan',
  ref: 'Index lookup',
  eq_ref: 'Unique index lookup',
  const: 'Constant lookup',
  system: 'System table',
  fulltext: 'Full-text lookup',
};

function fromMysql(data: unknown): PlanNode {
  const walk = (name: string, o: Record<string, any>): PlanNode => {
    const children: PlanNode[] = [];
    for (const [k, v] of Object.entries(o)) {
      if (k === 'nested_loop' && Array.isArray(v)) children.push(...v.map((x) => walk('table', x.table ?? x)));
      else if (k === 'table' && name !== 'table' && v && typeof v === 'object') children.push(walk('table', v));
      else if (MYSQL_OPS.has(k) && v && typeof v === 'object') children.push(walk(k, v));
      else if (k === 'query_block' && v && typeof v === 'object') children.push(walk('query_block', v));
      else if (Array.isArray(v) && /subqueries|query_specifications/.test(k)) for (const x of v) children.push(walk('subquery', x.query_block ?? x));
    }
    if (name === 'table') {
      const extra: [string, string][] = [];
      if (o.attached_condition) extra.push(['Condition', String(o.attached_condition)]);
      if (o.possible_keys) extra.push(['Possible keys', [].concat(o.possible_keys).join(', ')]);
      if (o.filtered) extra.push(['Filtered', `${o.filtered}%`]);
      return node({
        label: ACCESS[o.access_type] ?? o.access_type ?? 'Table',
        detail: `${o.table_name}${o.key ? ` using ${o.key}` : ''}`,
        rows: num(o.rows_examined_per_scan),
        cost: num(o.cost_info?.prefix_cost),
        fullScan: o.access_type === 'ALL',
        extra,
        children,
      });
    }
    const label = name === 'query_block' ? `Query block${o.select_id ? ' #' + o.select_id : ''}` : name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    // Collapse a query block that only wraps one operation.
    if (name === 'query_block' && children.length === 1 && !o.cost_info) return children[0];
    return node({ label, cost: num(o.cost_info?.query_cost ?? o.cost_info?.sort_cost), children });
  };
  return walk('query_block', (data as Record<string, any>).query_block);
}

// ---- MySQL: EXPLAIN ANALYZE (tree text) ----
function fromMysqlTree(text: string): PlanNode {
  const root = node({ label: 'Query' });
  const stack: { indent: number; n: PlanNode }[] = [{ indent: -1, n: root }];
  for (const line of String(text).split('\n')) {
    const m = /^(\s*)-> (.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const body = m[2];
    const est = /\(cost=([\d.e+]+)(?:\.\.([\d.e+]+))? rows=([\d.e+]+)\)/.exec(body);
    const act = /\(actual time=([\d.]+)\.\.([\d.]+) rows=([\d.e+]+) loops=(\d+)\)/.exec(body);
    const label = body.replace(/\s*\(cost=.*$/, '').replace(/\s*\(actual.*$/, '');
    const [op, ...rest] = label.split(/ on | using /);
    const n = node({
      label: op.trim(),
      detail: rest.join(' · ') || undefined,
      cost: est ? Number(est[2] ?? est[1]) : undefined,
      rows: est ? Number(est[3]) : undefined,
      actualRows: act ? Number(act[3]) * Number(act[4]) : undefined,
      timeMs: act ? Number(act[2]) * Number(act[4]) : undefined,
      fullScan: /^Table scan/i.test(op),
    });
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].n.children.push(n);
    stack.push({ indent, n });
  }
  return root.children.length === 1 ? root.children[0] : root;
}

// ---- SQL Server: SHOWPLAN_XML / STATISTICS XML ----
function fromMssql(xml: string): PlanNode {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const isRelOp = (e: Element) => e.localName === 'RelOp';
  const directRelOps = (e: Element): Element[] => {
    const out: Element[] = [];
    const visit = (x: Element) => {
      for (const c of Array.from(x.children)) {
        if (isRelOp(c)) out.push(c);
        else visit(c);
      }
    };
    visit(e);
    return out;
  };
  const ownObject = (e: Element): string | undefined => {
    const find = (x: Element): Element | undefined => {
      for (const c of Array.from(x.children)) {
        if (isRelOp(c)) continue;
        if (c.localName === 'Object') return c;
        const f = find(c);
        if (f) return f;
      }
    };
    const o = find(e);
    if (!o) return undefined;
    const strip = (s: string | null) => (s ?? '').replace(/^\[|\]$/g, '');
    return [strip(o.getAttribute('Table')), o.getAttribute('Index') ? `using ${strip(o.getAttribute('Index'))}` : ''].filter(Boolean).join(' ');
  };
  const walk = (e: Element): PlanNode => {
    const phys = e.getAttribute('PhysicalOp') ?? 'Operator';
    const logical = e.getAttribute('LogicalOp');
    let actualRows: number | undefined;
    const counters = Array.from(e.children).find((c) => c.localName === 'RunTimeInformation');
    if (counters) actualRows = Array.from(counters.children).reduce((a, c) => a + Number(c.getAttribute('ActualRows') ?? 0), 0);
    const extra: [string, string][] = [];
    if (logical && logical !== phys) extra.push(['Logical', logical]);
    const warn = Array.from(e.children).find((c) => c.localName === 'Warnings');
    if (warn) extra.push(['Warnings', Array.from(warn.children).map((w) => w.localName).join(', ')]);
    return node({
      label: phys,
      detail: ownObject(e),
      rows: num(e.getAttribute('EstimateRows')),
      actualRows,
      cost: num(e.getAttribute('EstimatedTotalSubtreeCost')),
      fullScan: /Table Scan|Clustered Index Scan/.test(phys),
      extra,
      children: directRelOps(e).map(walk),
    });
  };
  const first = doc.getElementsByTagNameNS('*', 'RelOp')[0];
  if (!first) throw new Error('No operators found in the plan');
  return walk(first);
}

// ---- SQLite: EXPLAIN QUERY PLAN rows (id, parent, notused, detail) ----
function fromSqlite(rows: unknown[][]): PlanNode {
  const root = node({ label: 'Query' });
  const byId = new Map<number, PlanNode>([[0, root]]);
  for (const [id, parent, , detail] of rows) {
    const text = String(detail);
    const [, op, rest] = /^(\S+(?: \S+)?)\s*(.*)$/.exec(text) ?? [, text, ''];
    const n = node({ label: op ?? text, detail: rest || undefined, fullScan: /^SCAN\b/.test(text) && !/USING (COVERING )?INDEX/.test(text) });
    byId.set(Number(id), n);
    (byId.get(Number(parent)) ?? root).children.push(n);
  }
  return root.children.length === 1 ? root.children[0] : root;
}

export function normalizePlan(p: RawPlan): PlanNode {
  seq = 0;
  switch (p.format) {
    case 'pg-json':
      return fromPg(p.data);
    case 'mysql-json':
      return fromMysql(p.data);
    case 'mysql-tree':
      return fromMysqlTree(String(p.data));
    case 'mssql-xml':
      return fromMssql(String(p.data));
    case 'sqlite-rows':
      return fromSqlite(p.data as unknown[][]);
  }
}

/** Own cost = subtree cost minus children's subtree costs (for engines that report cumulative cost). */
export function ownCost(n: PlanNode): number | undefined {
  if (n.cost === undefined) return undefined;
  const kids = n.children.reduce((a, c) => a + (c.cost ?? 0), 0);
  return Math.max(0, n.cost - kids);
}

export function flatten(n: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(n);
  n.children.forEach((c) => flatten(c, out));
  return out;
}
