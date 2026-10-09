/** Make driver values JSON-safe and readable in the grid. */
export function serializeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString();
  }
  if (v instanceof Date) {
    // Drivers that return Dates (SQL Server) are configured to read stored values as UTC, so print the
    // UTC wall-clock time as the database shows it, without a time-zone shift or marker.
    if (isNaN(v.getTime())) return String(v);
    return v.toISOString().replace('T', ' ').replace(/(\.000)?Z$/, '');
  }
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v).toString('hex');
    return '0x' + (hex.length > 200 ? hex.slice(0, 200) + '…' : hex).toUpperCase();
  }
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return v;
}

export function serializeRows(rows: unknown[][]): unknown[][] {
  return rows.map((r) => r.map(serializeValue));
}

/**
 * Split a SQL script into statements on `;`, honouring quotes, comments,
 * dollar-quoted strings (PostgreSQL) and BEGIN…END blocks in triggers.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let blockDepth = 0;
  const n = sql.length;
  const flush = () => {
    const s = cur.trim();
    if (s && !/^(--[^\n]*\n?|\/\*[\s\S]*?\*\/|\s)*$/.test(s)) out.push(s);
    cur = '';
  };
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end + 1;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === close) {
          if (sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]))) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))!;
      const word = m[0].toUpperCase();
      if (word === 'BEGIN' && /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(cur)) blockDepth++;
      else if (word === 'CASE' && blockDepth > 0) blockDepth++;
      else if (word === 'END' && blockDepth > 0) blockDepth--;
      cur += m[0];
      i += m[0].length;
      continue;
    }
    if (ch === ';' && blockDepth === 0) {
      cur += ';';
      flush();
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  flush();
  return out;
}

/** Split a T-SQL script into batches on lines that contain only GO. */
export function splitGoBatches(sql: string): string[] {
  return sql
    .split(/^\s*GO\s*(?:--.*)?$/gim)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isReadStatement(sql: string): boolean {
  const s = sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '');
  return /^(SELECT|WITH|PRAGMA|EXPLAIN|VALUES|SHOW|DESCRIBE|DESC)\b/i.test(s);
}

export const MAX_RESULT_ROWS = 10_000;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const stripComments = (s: string) => s.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');

/** Top-level WHERE present? Ignores text inside parentheses (subqueries) and strings. */
function hasTopLevelWhere(stmt: string): boolean {
  const s = stripComments(stmt).replace(/'(?:[^']|'')*'/g, "''");
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /w/i.test(ch) && /^where\b/i.test(s.slice(i)) && !/[A-Za-z0-9_]/.test(s[i - 1] ?? ' ')) return true;
  }
  return false;
}

export interface StatementRisk {
  /** Statements that change data or structure. */
  writes: number;
  /** Human-readable reasons a production connection should ask first. */
  dangerous: string[];
}

/**
 * Classifies a script for safety checks. This is a guard rail for people, not a security boundary:
 * read-only connections are also enforced by the database session where the engine supports it.
 */
export function classifyScript(sql: string, mssql = false): StatementRisk {
  const batches = mssql ? splitGoBatches(sql) : [sql];
  const statements = batches.flatMap((b) => splitStatements(b));
  const risk: StatementRisk = { writes: 0, dangerous: [] };
  for (const raw of statements) {
    const st = stripComments(raw).trim();
    const short = st.replace(/\s+/g, ' ').slice(0, 80);
    if (!isReadStatement(st)) risk.writes++;
    if (/^(WITH\b[\s\S]*?\)\s*)?DELETE\b/i.test(st) && !hasTopLevelWhere(st)) risk.dangerous.push(`DELETE without WHERE: ${short}`);
    else if (/^(WITH\b[\s\S]*?\)\s*)?UPDATE\b/i.test(st) && !hasTopLevelWhere(st)) risk.dangerous.push(`UPDATE without WHERE: ${short}`);
    else if (/^DROP\b/i.test(st)) risk.dangerous.push(short);
    else if (/^TRUNCATE\b/i.test(st)) risk.dangerous.push(short);
    else if (/^ALTER\b[\s\S]*\bDROP\b/i.test(st)) risk.dangerous.push(short);
    // A CTE can hide a write behind WITH … (DELETE …); treat any data-modifying keyword in a WITH as a write.
    else if (/^WITH\b/i.test(st) && /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(st)) risk.writes++;
  }
  return risk;
}

/** Error the renderer can act on (e.g. ask for confirmation and retry). */
export class CodedError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
