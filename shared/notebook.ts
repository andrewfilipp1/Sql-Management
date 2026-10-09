/** SQL notebooks: SQL and Markdown cells with saved results, stored per notebook in userData. */

export type CellKind = 'sql' | 'markdown';
export type ChartKind = 'bar' | 'line';

export interface CellOutput {
  columns: string[];
  /** At most NOTEBOOK_ROWS rows are kept. */
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  messages: string[];
  durationMs: number;
  error?: string;
  ranAt: string;
}

export interface NotebookCell {
  id: string;
  kind: CellKind;
  source: string;
  output?: CellOutput;
  /** Result shown as a chart instead of a grid. */
  chart?: { kind: ChartKind; x: string; y: string };
}

export interface Notebook {
  id: string;
  name: string;
  connId: string;
  database: string;
  cells: NotebookCell[];
  updatedAt: string;
}

export type NotebookSummary = Pick<Notebook, 'id' | 'name' | 'connId' | 'database' | 'updatedAt'> & { cells: number };

export const NOTEBOOK_ROWS = 500;
