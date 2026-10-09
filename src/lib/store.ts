import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PublicConnection, SchemaSnapshot, TableRef } from '../../shared/types';
import type { SavedEndpoint } from '../../shared/integrations';
import { api, type ConnectionInput } from './api';
import { dbKey, uid } from './utils';

export type TabKind = 'query' | 'table' | 'diagram' | 'dashboard' | 'integrations' | 'activity' | 'security' | 'compare' | 'datacompare';
export type TableView = 'data' | 'structure' | 'relations' | 'ddl';

export type DbDialogKind = 'import' | 'export' | 'backup' | 'mock' | 'docs';

export interface Tab {
  id: string;
  kind: TabKind;
  connId: string;
  database: string;
  title: string;
  table?: TableRef;
  view?: TableView;
  sql?: string;
  focus?: string;
}

export interface Session {
  status: 'connecting' | 'connected' | 'error';
  error?: string;
  databases: string[];
  defaultDatabase: string;
  serverVersion?: string;
}

export interface SchemaState {
  status: 'loading' | 'ready' | 'error';
  data?: SchemaSnapshot;
  error?: string;
}

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  message: string;
}

export interface SqlRequest {
  connId: string;
  database: string;
  title: string;
  description?: string;
  sql: string;
  danger?: boolean;
  onDone?: () => void;
}

export interface PromptRequest {
  title: string;
  label: string;
  initial?: string;
  resolve: (v: string | null) => void;
}

interface State {
  connections: PublicConnection[];
  sessions: Record<string, Session>;
  schemas: Record<string, SchemaState>;
  tabs: Tab[];
  activeTabId: string | null;
  expanded: Record<string, boolean>;
  toasts: Toast[];
  sqlRequest: SqlRequest | null;
  promptRequest: PromptRequest | null;
  connectionDialog: { open: boolean; editing?: PublicConnection };
  designer: { connId: string; database: string } | null;
  /** Endpoint being created/edited in the endpoint dialog. */
  endpointDraft: Partial<SavedEndpoint> | null;
  /** Database-scoped dialogs; `table` preselects a table where relevant. */
  dbDialog: { kind: DbDialogKind; connId: string; database: string; table?: TableRef } | null;

  loadConnections(): Promise<void>;
  saveConnection(c: ConnectionInput): Promise<PublicConnection>;
  deleteConnection(id: string): Promise<void>;
  connect(id: string): Promise<Session | undefined>;
  disconnect(id: string): Promise<void>;
  loadSchema(connId: string, database: string, refresh?: boolean): Promise<SchemaSnapshot | undefined>;
  ensureSchema(connId: string, database: string): void;

  openTab(t: Omit<Tab, 'id'>, opts?: { dedupe?: boolean }): string;
  closeTab(id: string): void;
  closeOtherTabs(id: string): void;
  setActiveTab(id: string): void;
  updateTab(id: string, patch: Partial<Tab>): void;
  newQuery(connId: string, database: string, sql?: string): void;

  toggle(key: string, value?: boolean): void;
  toast(message: string, kind?: Toast['kind']): void;
  dismissToast(id: string): void;
  confirmSql(r: SqlRequest | null): void;
  prompt(title: string, label: string, initial?: string): Promise<string | null>;
  closePrompt(): void;
  openConnectionDialog(editing?: PublicConnection): void;
  closeConnectionDialog(): void;
  openDesigner(v: { connId: string; database: string } | null): void;
  editEndpoint(d: Partial<SavedEndpoint> | null): void;
  openDbDialog(d: State['dbDialog']): void;
  openIntegrations(): void;
}

const inflightSchemas = new Map<string, Promise<SchemaSnapshot | undefined>>();
const inflightConnects = new Map<string, Promise<Session | undefined>>();

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      connections: [],
      sessions: {},
      schemas: {},
      tabs: [],
      activeTabId: null,
      expanded: {},
      toasts: [],
      sqlRequest: null,
      promptRequest: null,
      connectionDialog: { open: false },
      designer: null,
      endpointDraft: null,
      dbDialog: null,

      async loadConnections() {
        try {
          set({ connections: await api.listConnections() });
        } catch (e) {
          get().toast(`Cannot load connections: ${(e as Error).message}`, 'error');
        }
      },

      async saveConnection(c) {
        const saved = await api.saveConnection(c);
        set((s) => {
          const exists = s.connections.some((x) => x.id === saved.id);
          const sessions = { ...s.sessions };
          delete sessions[saved.id];
          const schemas = Object.fromEntries(Object.entries(s.schemas).filter(([k]) => !k.startsWith(saved.id + '::')));
          return {
            connections: exists ? s.connections.map((x) => (x.id === saved.id ? saved : x)) : [...s.connections, saved],
            sessions,
            schemas,
          };
        });
        return saved;
      },

      async deleteConnection(id) {
        await api.deleteConnection(id);
        set((s) => ({
          connections: s.connections.filter((c) => c.id !== id),
          tabs: s.tabs.filter((t) => t.connId !== id),
          activeTabId: s.tabs.find((t) => t.id === s.activeTabId)?.connId === id ? null : s.activeTabId,
        }));
      },

      connect(id) {
        const existing = get().sessions[id];
        if (existing?.status === 'connected') return Promise.resolve(existing);
        let p = inflightConnects.get(id);
        if (p) return p;
        set((s) => ({ sessions: { ...s.sessions, [id]: { status: 'connecting', databases: [], defaultDatabase: '' } } }));
        p = api
          .connect(id)
          .then((r) => {
            const session: Session = { status: 'connected', ...r };
            set((s) => ({
              sessions: { ...s.sessions, [id]: session },
              expanded: { ...s.expanded, [id]: true, [dbKey(id, r.defaultDatabase)]: true },
            }));
            return session;
          })
          .catch((e: Error) => {
            set((s) => ({ sessions: { ...s.sessions, [id]: { status: 'error', error: e.message, databases: [], defaultDatabase: '' } } }));
            get().toast(e.message, 'error');
            return undefined;
          })
          .finally(() => inflightConnects.delete(id));
        inflightConnects.set(id, p);
        return p;
      },

      async disconnect(id) {
        await api.disconnect(id).catch(() => {});
        set((s) => {
          const sessions = { ...s.sessions };
          delete sessions[id];
          const schemas = Object.fromEntries(Object.entries(s.schemas).filter(([k]) => !k.startsWith(id + '::')));
          return { sessions, schemas, expanded: { ...s.expanded, [id]: false } };
        });
      },

      loadSchema(connId, database, refresh = false) {
        const key = dbKey(connId, database);
        const pending = inflightSchemas.get(key);
        if (pending && !refresh) return pending;
        set((s) => ({ schemas: { ...s.schemas, [key]: { ...s.schemas[key], status: 'loading' } } }));
        const p = (async () => {
          const session = await get().connect(connId);
          if (!session) {
            set((s) => ({ schemas: { ...s.schemas, [key]: { status: 'error', error: 'Not connected' } } }));
            return undefined;
          }
          try {
            const data = await api.schema(connId, database, refresh);
            set((s) => ({ schemas: { ...s.schemas, [key]: { status: 'ready', data } } }));
            return data;
          } catch (e) {
            set((s) => ({ schemas: { ...s.schemas, [key]: { status: 'error', error: (e as Error).message } } }));
            return undefined;
          } finally {
            inflightSchemas.delete(key);
          }
        })();
        inflightSchemas.set(key, p);
        return p;
      },

      ensureSchema(connId, database) {
        const st = get().schemas[dbKey(connId, database)];
        if (!st || st.status === 'error') void get().loadSchema(connId, database);
      },

      openTab(t, opts = { dedupe: true }) {
        if (opts.dedupe !== false) {
          const found = get().tabs.find(
            (x) =>
              x.kind === t.kind &&
              x.kind !== 'query' &&
              x.connId === t.connId &&
              x.database === t.database &&
              (x.table?.name ?? '') === (t.table?.name ?? '') &&
              (x.table?.schema ?? '') === (t.table?.schema ?? ''),
          );
          if (found) {
            set((s) => ({
              activeTabId: found.id,
              tabs: s.tabs.map((x) => (x.id === found.id ? { ...x, view: t.view ?? x.view, focus: t.focus ?? x.focus } : x)),
            }));
            return found.id;
          }
        }
        const id = uid();
        set((s) => {
          const idx = s.tabs.findIndex((x) => x.id === s.activeTabId);
          const tabs = [...s.tabs];
          tabs.splice(idx + 1, 0, { ...t, id });
          return { tabs, activeTabId: id };
        });
        return id;
      },

      closeTab(id) {
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          const tabs = s.tabs.filter((t) => t.id !== id);
          let activeTabId = s.activeTabId;
          if (activeTabId === id) activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
          return { tabs, activeTabId };
        });
      },

      closeOtherTabs(id) {
        set((s) => ({ tabs: s.tabs.filter((t) => t.id === id), activeTabId: id }));
      },

      setActiveTab(id) {
        set({ activeTabId: id });
      },

      updateTab(id, patch) {
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
      },

      newQuery(connId, database, sql = '') {
        const n = get().tabs.filter((t) => t.kind === 'query').length + 1;
        get().openTab({ kind: 'query', connId, database, title: `Query ${n}`, sql }, { dedupe: false });
      },

      toggle(key, value) {
        set((s) => ({ expanded: { ...s.expanded, [key]: value ?? !s.expanded[key] } }));
      },

      toast(message, kind = 'info') {
        const id = uid();
        set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message }] }));
        setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 3500);
      },

      dismissToast(id) {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      },

      confirmSql(r) {
        set({ sqlRequest: r });
      },

      prompt(title, label, initial) {
        return new Promise((resolve) => set({ promptRequest: { title, label, initial, resolve } }));
      },

      closePrompt() {
        set({ promptRequest: null });
      },

      openConnectionDialog(editing) {
        set({ connectionDialog: { open: true, editing } });
      },

      closeConnectionDialog() {
        set({ connectionDialog: { open: false } });
      },

      openDesigner(v) {
        set({ designer: v });
      },

      editEndpoint(d) {
        set({ endpointDraft: d });
      },

      openDbDialog(d) {
        set({ dbDialog: d });
      },

      openIntegrations() {
        // Not tied to a connection: connId/database stay empty.
        get().openTab({ kind: 'integrations', connId: '', database: '', title: 'Integrations' });
      },
    }),
    {
      name: 'schemascope',
      partialize: (s) => ({ tabs: s.tabs, activeTabId: s.activeTabId, expanded: s.expanded }),
    },
  ),
);

export function useSchema(connId: string, database: string): SchemaState | undefined {
  return useStore((s) => s.schemas[dbKey(connId, database)]);
}

export function useConnection(connId: string): PublicConnection | undefined {
  return useStore((s) => s.connections.find((c) => c.id === connId));
}
