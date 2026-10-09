import type { Api, ApiMethod, Bridge } from '../../shared/ipc';

export type { ConnectionInput } from '../../shared/ipc';

declare global {
  interface Window {
    schemascope?: Bridge;
  }
}

/** Error from the main process; `code` is set for errors the UI can act on (e.g. CONFIRM_REQUIRED). */
export type ApiError = Error & { code?: string; details?: unknown };

export const platform = window.schemascope?.platform ?? 'web';

/**
 * Typed proxy over the preload bridge: `api.query(...)` becomes an IPC call
 * to the main process, with the signature taken from `shared/ipc.ts`.
 */
export const api = new Proxy({} as Api, {
  get(_target, method: string) {
    return async (...args: unknown[]) => {
      const bridge = window.schemascope;
      if (!bridge) throw new Error('SchemaScope must run inside its desktop app (window.schemascope is missing).');
      const r = await bridge.invoke(method as ApiMethod, ...args);
      if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code, details: r.details });
      return r.data;
    };
  },
});
