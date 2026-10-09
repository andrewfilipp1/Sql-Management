import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC_CHANNEL, type Api, type ApiMethod, type IpcResult } from '../shared/ipc.ts';
import { coreApi, errorMessage, type NativeMethods } from '../core/api.ts';
import { checkForUpdates, downloadUpdate, initUpdater, installUpdate, setUpdateWindow, updateState } from './updater.ts';
import { closeAll } from '../core/pool.ts';
import { applyServerSettings, stopServer } from '../core/httpApi.ts';
import { setDataDir, setSecretCodec } from '../core/store.ts';
import { ensureDemoDatabase } from '../core/demo.ts';
import { loadCsv, writeDatabaseScript } from '../core/transfer.ts';
import { backupToFile, restoreFromFile } from '../core/backup.ts';
import { getConnection } from '../core/store.ts';

const DEV_URL = process.env.SCHEMASCOPE_DEV_URL;
// Separate data folder (used by the smoke test so it never touches the user's connections).
if (process.env.SCHEMASCOPE_USER_DATA) app.setPath('userData', process.env.SCHEMASCOPE_USER_DATA);
const isMac = process.platform === 'darwin';

let win: BrowserWindow | null = null;

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

const nativeApi: Pick<Api, NativeMethods> = {
  updateState: async () => updateState(),
  checkForUpdates,
  downloadUpdate,
  async installUpdate() {
    installUpdate();
  },

  async pickCsv() {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Import CSV',
      properties: ['openFile'],
      filters: [{ name: 'CSV / TSV', extensions: ['csv', 'tsv', 'txt'] }],
    });
    return r.canceled ? null : loadCsv(r.filePaths[0]);
  },

  async exportScript(connId, database, opts) {
    const r = await dialog.showSaveDialog(win!, {
      title: opts.includeData ? 'Export schema and data' : 'Export schema',
      defaultPath: `${database}-${opts.includeData ? 'full' : 'schema'}-${stamp()}.sql`,
      filters: [{ name: 'SQL script', extensions: ['sql'] }],
    });
    if (r.canceled || !r.filePath) return null;
    return { file: r.filePath, ...(await writeDatabaseScript(connId, database, opts, r.filePath)) };
  },

  async backup(connId, database, opts) {
    const kind = getConnection(connId)?.kind;
    const ext = kind === 'sqlite' ? 'sqlite' : kind === 'postgres' && opts.format !== 'plain' ? 'dump' : 'sql';
    const r = await dialog.showSaveDialog(win!, { title: 'Save backup', defaultPath: `${database}-backup-${stamp()}.${ext}` });
    if (r.canceled || !r.filePath) return null;
    await backupToFile(connId, database, r.filePath, opts.format);
    return { file: r.filePath };
  },

  async restore(connId, database) {
    const r = await dialog.showOpenDialog(win!, { title: 'Restore from backup', properties: ['openFile'] });
    if (r.canceled) return null;
    await restoreFromFile(connId, database, r.filePaths[0]);
    return { file: r.filePaths[0] };
  },

  async pickSqliteFile(mode) {
    const filters = [
      { name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3', 'db3', 's3db', 'sl3'] },
      { name: 'All files', extensions: ['*'] },
    ];
    if (mode === 'create') {
      const r = await dialog.showSaveDialog(win!, { title: 'Create SQLite database', defaultPath: 'database.sqlite', filters });
      return r.canceled || !r.filePath ? null : r.filePath;
    }
    const r = await dialog.showOpenDialog(win!, { title: 'Open SQLite database', properties: ['openFile'], filters });
    return r.canceled ? null : r.filePaths[0];
  },

  async saveTextFile(defaultName, content) {
    const r = await dialog.showSaveDialog(win!, { defaultPath: defaultName });
    if (r.canceled || !r.filePath) return false;
    await fs.promises.writeFile(r.filePath, content, 'utf8');
    return true;
  },
};

const handlers: Api = { ...coreApi, ...nativeApi };

function registerIpc() {
  ipcMain.handle(IPC_CHANNEL, async (event, method: ApiMethod, ...args: unknown[]): Promise<IpcResult<unknown>> => {
    // Only answer our own window, never content loaded from elsewhere.
    if (event.senderFrame?.url && !isTrustedUrl(event.senderFrame.url)) return { ok: false, error: 'Untrusted sender' };
    const fn = handlers[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
    if (typeof fn !== 'function') return { ok: false, error: `Unknown method: ${String(method)}` };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      const coded = e as { code?: unknown; details?: unknown };
      return {
        ok: false,
        error: errorMessage(e),
        code: typeof coded.code === 'string' ? coded.code : undefined,
        details: coded.details,
      };
    }
  });
}

function isTrustedUrl(url: string): boolean {
  return DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('file://');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    show: false,
    backgroundColor: '#070912',
    title: 'SchemaScope',
    // macOS: traffic lights over our own title bar. Windows/Linux: native buttons drawn over it.
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 14 }, vibrancy: 'under-window' as const, visualEffectState: 'active' as const }
      : { titleBarOverlay: { color: '#00000000', symbolColor: '#c7cbe0', height: 40 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win?.show());
  setUpdateWindow(win);

  // External links open in the user's browser; the app never navigates away from itself.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedUrl(url)) e.preventDefault();
  });

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  setDataDir(app.getPath('userData'));
  setSecretCodec({
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data),
  });
  try {
    ensureDemoDatabase();
  } catch (e) {
    console.error('Could not create demo database:', e);
  }
  registerIpc();
  createWindow();
  initUpdater();
  // Local REST/MCP server, only if the user enabled it in Integrations.
  void applyServerSettings();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

// Close pools on the way out. SQLite closes synchronously; network sessions are released by the server
// either way, so quitting is never blocked on a slow or unreachable database.
app.on('will-quit', () => {
  void stopServer();
  void closeAll();
});
