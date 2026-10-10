import {
  Activity,
  Archive,
  BookOpen,
  Code2,
  Columns2,
  Columns3,
  DatabaseBackup,
  Dices,
  Eraser,
  FileCode,
  FileDown,
  FileUp,
  GitCompareArrows,
  GitFork,
  NotebookPen,
  Pencil,
  Play,
  Plus,
  Rows3,
  Shield,
  Trash2,
  Waypoints,
} from 'lucide-react';
import type { DbKind, RoutineInfo, TableInfo } from '../../shared/types';
import {
  dropTableSql,
  insertTemplateSql,
  joinSql,
  renameTableSql,
  selectSql,
  truncateTableSql,
  updateTemplateSql,
} from '../../shared/dialect';
import type { MenuItem } from '../components/ui';
import { api } from './api';
import { useStore } from './store';
import { uid } from './utils';
import { dbKey, nodeId } from './utils';

const S = useStore.getState;

export function openTable(connId: string, database: string, t: { schema?: string; name: string }, view: 'data' | 'structure' | 'relations' | 'ddl' = 'data') {
  S().openTab({ kind: 'table', connId, database, title: t.name, table: { schema: t.schema, name: t.name }, view });
}

export function openDiagram(connId: string, database: string, focus?: string) {
  S().openTab({ kind: 'diagram', connId, database, title: `${database} · Diagram`, focus });
}

export function openDashboard(connId: string, database: string) {
  S().openTab({ kind: 'dashboard', connId, database, title: `${database} · Overview` });
}

export function openActivity(connId: string, database: string) {
  S().openTab({ kind: 'activity', connId, database, title: `${database} · Activity` });
}

export function openSecurity(connId: string, database: string) {
  S().openTab({ kind: 'security', connId, database, title: `${database} · Security` });
}

export function openCompare(connId: string, database: string) {
  S().openTab({ kind: 'compare', connId, database, title: 'Schema compare' }, { dedupe: false });
}

export function openDataCompare(connId: string, database: string, table?: { schema?: string; name: string }) {
  S().openTab({ kind: 'datacompare', connId, database, title: `Data compare${table ? ' · ' + table.name : ''}`, table }, { dedupe: false });
}

/** Database-level tools for the explorer's context menu. */
export function databaseToolsMenu(connId: string, database: string, kind: DbKind): MenuItem[] {
  const icon = (I: typeof Play) => <I className="size-3.5" />;
  const server = kind !== 'sqlite';
  return [
    ...(server
      ? [
          { label: 'Activity monitor', icon: icon(Activity), onClick: () => openActivity(connId, database) },
          { label: 'Users & permissions', icon: icon(Shield), onClick: () => openSecurity(connId, database) },
        ]
      : []),
    { label: 'Import CSV as new table…', icon: icon(FileUp), onClick: () => S().openDbDialog({ kind: 'import', connId, database }) },
    { label: 'Generate scripts…', icon: icon(FileDown), onClick: () => S().openDbDialog({ kind: 'export', connId, database }) },
    { label: 'Backup & restore…', icon: icon(DatabaseBackup), onClick: () => S().openDbDialog({ kind: 'backup', connId, database }) },
    { label: 'Documentation…', icon: icon(BookOpen), onClick: () => S().openDbDialog({ kind: 'docs', connId, database }) },
    { label: 'Schema compare', icon: icon(GitCompareArrows), onClick: () => openCompare(connId, database) },
    { label: 'New notebook', icon: icon(NotebookPen), onClick: () => void newNotebook(connId, database) },
    ...(kind === 'mssql' ? [{ label: 'Restore .bak as new database…', icon: icon(Archive), onClick: () => S().openRestoreBak(connId) }] : []),
  ];
}

export function openNotebook(nb: { id: string; name: string; connId: string; database: string }) {
  const open = S().tabs.find((t) => t.kind === 'notebook' && t.notebookId === nb.id);
  if (open) return S().setActiveTab(open.id);
  S().openTab({ kind: 'notebook', connId: nb.connId, database: nb.database, title: nb.name, notebookId: nb.id }, { dedupe: false });
}

export async function newNotebook(connId: string, database: string) {
  try {
    const n = (await api.listNotebooks()).length + 1;
    const nb = await api.saveNotebook({
      id: '',
      name: `Notebook ${n}`,
      connId,
      database,
      updatedAt: '',
      cells: [
        { id: uid(), kind: 'markdown', source: '## Notes\nDescribe what this notebook is for.' },
        { id: uid(), kind: 'sql', source: '' },
      ],
    });
    openNotebook(nb);
  } catch (e) {
    S().toast((e as Error).message, 'error');
  }
}

/** Saved notebooks for the sidebar menu. */
export async function notebooksMenu(): Promise<MenuItem[]> {
  const list = await api.listNotebooks().catch(() => []);
  const conns = S().connections;
  if (!list.length) return [{ label: 'No notebooks yet — use a database’s Tools menu', disabled: true }];
  return list.slice(0, 20).map((nb) => ({
    label: nb.name,
    hint: conns.find((c) => c.id === nb.connId)?.name ?? 'missing connection',
    icon: <NotebookPen className="size-3.5" />,
    onClick: () => openNotebook(nb),
  }));
}

export function refreshSchema(connId: string, database: string) {
  return S().loadSchema(connId, database, true);
}

export async function openDdl(connId: string, database: string, t: TableInfo) {
  try {
    const ddl = await api.ddl(connId, database, { schema: t.schema, name: t.name });
    S().newQuery(connId, database, ddl);
  } catch (e) {
    S().toast((e as Error).message, 'error');
  }
}

export async function openRoutine(connId: string, database: string, r: RoutineInfo) {
  try {
    const ddl = await api.routine(connId, database, r);
    S().newQuery(connId, database, ddl);
  } catch (e) {
    S().toast((e as Error).message, 'error');
  }
}

export function tableMenu(connId: string, database: string, kind: DbKind, t: TableInfo): MenuItem[] {
  const ref = { schema: t.schema, name: t.name };
  const schema = S().schemas[dbKey(connId, database)]?.data;
  const isView = t.type === 'view';
  const icon = (I: typeof Play) => <I className="size-3.5" />;
  const done = () => void refreshSchema(connId, database);
  return [
    { label: 'Open data', icon: icon(Rows3), onClick: () => openTable(connId, database, ref, 'data') },
    { label: 'Structure', icon: icon(Columns3), onClick: () => openTable(connId, database, ref, 'structure') },
    { label: 'Show in diagram', icon: icon(Waypoints), onClick: () => openDiagram(connId, database, nodeId(t)) },
    { separator: true },
    { label: 'Query: SELECT', icon: icon(Play), onClick: () => S().newQuery(connId, database, selectSql(kind, ref)) },
    {
      label: 'Query: JOIN related',
      icon: icon(GitFork),
      disabled: !t.foreignKeys.length,
      onClick: () => S().newQuery(connId, database, joinSql(kind, t, schema?.tables ?? [])),
    },
    { label: 'Script INSERT', icon: icon(Plus), disabled: isView, onClick: () => S().newQuery(connId, database, insertTemplateSql(kind, t)) },
    { label: 'Script UPDATE', icon: icon(Pencil), disabled: isView, onClick: () => S().newQuery(connId, database, updateTemplateSql(kind, t)) },
    { label: isView ? 'Script CREATE VIEW' : 'Script CREATE TABLE', icon: icon(FileCode), onClick: () => void openDdl(connId, database, t) },
    { separator: true },
    { label: 'Import CSV…', icon: icon(FileUp), disabled: isView, onClick: () => S().openDbDialog({ kind: 'import', connId, database, table: ref }) },
    { label: 'Generate test data…', icon: icon(Dices), disabled: isView, onClick: () => S().openDbDialog({ kind: 'mock', connId, database, table: ref }) },
    { label: 'Export with data…', icon: icon(FileDown), disabled: isView, onClick: () => S().openDbDialog({ kind: 'export', connId, database, table: ref }) },
    { label: 'Compare data…', icon: icon(Columns2), disabled: isView, onClick: () => openDataCompare(connId, database, ref) },
    { separator: true },
    {
      label: 'Rename…',
      icon: icon(Code2),
      disabled: isView,
      onClick: async () => {
        const name = await S().prompt(`Rename ${t.name}`, 'New name', t.name);
        if (name && name !== t.name) {
          S().confirmSql({ connId, database, title: `Rename table`, sql: renameTableSql(kind, ref, name), onDone: done });
        }
      },
    },
    {
      label: 'Empty table…',
      icon: icon(Eraser),
      danger: true,
      disabled: isView,
      onClick: () =>
        S().confirmSql({
          connId,
          database,
          title: `Delete all rows from ${t.name}`,
          description: 'Every row in this table will be removed. This cannot be undone.',
          sql: truncateTableSql(kind, ref),
          danger: true,
          onDone: done,
        }),
    },
    {
      label: isView ? 'Drop view…' : 'Drop table…',
      icon: icon(Trash2),
      danger: true,
      onClick: () =>
        S().confirmSql({
          connId,
          database,
          title: `Drop ${t.name}`,
          description: `The ${isView ? 'view' : 'table and all of its data'} will be permanently deleted.`,
          sql: dropTableSql(kind, ref, isView),
          danger: true,
          onDone: () => {
            useStore.setState((s) => ({
              tabs: s.tabs.filter((x) => !(x.kind === 'table' && x.connId === connId && x.database === database && x.table?.name === t.name && (x.table?.schema ?? '') === (t.schema ?? ''))),
            }));
            done();
          },
        }),
    },
  ];
}
