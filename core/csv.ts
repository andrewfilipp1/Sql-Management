/** RFC 4180 CSV parsing with delimiter detection (comma, semicolon, tab, pipe). */

export function detectDelimiter(sample: string): string {
  const firstLines = sample.split(/\r?\n/).slice(0, 5);
  let best = ',';
  let bestScore = 0;
  for (const d of [',', ';', '\t', '|']) {
    const counts = firstLines.map((l) => countOutsideQuotes(l, d));
    // A good delimiter appears the same (non-zero) number of times on each line.
    const consistent = counts.every((c) => c === counts[0]);
    const score = counts[0] > 0 ? counts[0] * (consistent ? 2 : 1) : 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) n++;
  }
  return n;
}

export function parseCsv(text: string, delimiter: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM from Excel
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

export type InferredType = 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime' | 'text';

/** Infers a column type from sample values (empty strings ignored). */
export function inferType(values: string[]): InferredType {
  const v = values.filter((x) => x !== '');
  if (!v.length) return 'text';
  if (v.every((x) => /^-?\d{1,15}$/.test(x))) return 'integer';
  if (v.every((x) => /^-?\d+([.,]\d+)?$/.test(x))) return 'decimal';
  if (v.every((x) => /^(true|false|0|1|yes|no)$/i.test(x))) return 'boolean';
  if (v.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x))) return 'date';
  if (v.every((x) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?/.test(x))) return 'datetime';
  return 'text';
}
