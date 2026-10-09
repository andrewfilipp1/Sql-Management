import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NOTEBOOK_ROWS, type Notebook, type NotebookSummary } from '../shared/notebook.ts';
import { getDataDir } from './store.ts';
import { HttpError } from './util.ts';

const dir = () => path.join(getDataDir(), 'notebooks');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 8 * 1024 * 1024;

/** Ids become file names, so only accept the UUIDs we generate. */
function fileOf(id: string) {
  if (!UUID.test(id)) throw new HttpError(400, 'Invalid notebook id');
  return path.join(dir(), `${id}.json`);
}

export function listNotebooks(): NotebookSummary[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: NotebookSummary[] = [];
  for (const f of names) {
    try {
      const nb = JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8')) as Notebook;
      out.push({ id: nb.id, name: nb.name, connId: nb.connId, database: nb.database, updatedAt: nb.updatedAt, cells: nb.cells.length });
    } catch {
      /* skip unreadable files */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getNotebook(id: string): Notebook {
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')) as Notebook;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(404, 'Notebook not found');
  }
}

export function saveNotebook(nb: Notebook): Notebook {
  if (!nb.name?.trim()) throw new HttpError(400, 'Notebook name is required');
  if (!Array.isArray(nb.cells)) throw new HttpError(400, 'Invalid notebook');
  const saved: Notebook = {
    id: nb.id || crypto.randomUUID(),
    name: nb.name.trim().slice(0, 200),
    connId: String(nb.connId ?? ''),
    database: String(nb.database ?? ''),
    updatedAt: new Date().toISOString(),
    cells: nb.cells.map((c) => ({
      id: String(c.id),
      kind: c.kind === 'markdown' ? 'markdown' : 'sql',
      source: String(c.source ?? ''),
      ...(c.chart ? { chart: c.chart } : {}),
      ...(c.output ? { output: { ...c.output, rows: c.output.rows.slice(0, NOTEBOOK_ROWS) } } : {}),
    })),
  };
  const json = JSON.stringify(saved);
  if (json.length > MAX_BYTES) throw new HttpError(413, 'Notebook is too large to save — clear some results');
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(fileOf(saved.id), json, { mode: 0o600 });
  return saved;
}

export function deleteNotebook(id: string) {
  fs.rmSync(fileOf(id), { force: true });
}
