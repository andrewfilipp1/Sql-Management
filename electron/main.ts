import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
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
import { setLocalServerEmitter } from '../core/localServer.ts';
import { inspectBak } from '../core/bak.ts';
import { LOCAL_SERVER_EVENT } from '../shared/localServer.ts';

const DEV_URL = process.env.SCHEMASCOPE_DEV_URL;
export const APP_NAME = 'SQL Graphic Tool';
// The app was first released as "SchemaScope": keep using that data folder so connections, notebooks and
// settings survive the rename. (Saved passwords are migrated by legacyDecrypt below.)
const OLD_NAME = 'SchemaScope';
app.setPath('userData', process.env.SCHEMASCOPE_USER_DATA || path.join(app.getPath('appData'), OLD_NAME));
const isMac = process.platform === 'darwin';

let win: BrowserWindow | null = null;

/**
 * macOS: Electron's safeStorage key lives in the keychain item "<app name> Safe Storage", so after the rename
 * secrets saved by "SchemaScope" need that old key. It is read once (macOS asks the user to allow it) and
 * secrets are re-encrypted with the new key. Format (Chromium OSCrypt): "v10" + AES-128-CBC, key from
 * PBKDF2-SHA1(password, "saltysalt", 1003), IV of 16 spaces. Windows (DPAPI) and Linux are unaffected.
 */
let legacyKey: Buffer | null | undefined;
function decryptLegacy(data: Buffer): string | null {
  if (!isMac || data.subarray(0, 3).toString() !== 'v10') return null;
  if (legacyKey === undefined) {
    try {
      const password = execFileSync('/usr/bin/security', ['find-generic-password', '-w', '-s', `${OLD_NAME} Safe Storage`, '-a', `${OLD_NAME} Key`], {
        encoding: 'utf8',
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      legacyKey = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    } catch {
      legacyKey = null; // no old item, or the user denied access: those passwords must be entered again
    }
  }
  if (!legacyKey) return null;
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', legacyKey, Buffer.alloc(16, ' '));
    return Buffer.concat([d.update(data.subarray(3)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

const nativeApi: Pick<Api, NativeMethods> = {
  updateState: async () => updateState(),
  checkForUpdates,
  downloadUpdate,
  async installUpdate() {
    installUpdate();
  },

  async pickBak(connId) {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Open SQL Server backup',
      properties: ['openFile'],
      filters: [{ name: 'SQL Server backup', extensions: ['bak'] }, { name: 'All files', extensions: ['*'] }],
    });
    return r.canceled ? null : inspectBak(connId, { localFile: r.filePaths[0] });
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

  async pickSqliteFile(mode, defaultName) {
    const filters = [
      { name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3', 'db3', 's3db', 'sl3'] },
      { name: 'All files', extensions: ['*'] },
    ];
    if (mode === 'create') {
      const r = await dialog.showSaveDialog(win!, { title: 'Create SQLite database', defaultPath: `${(defaultName || 'database').replace(/[\\/:*?"<>|]+/g, '_')}.sqlite`, filters });
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
    title: APP_NAME,
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
    decryptLegacy,
  });
  try {
    ensureDemoDatabase();
  } catch (e) {
    console.error('Could not create demo database:', e);
  }
  registerIpc();
  setLocalServerEmitter((state) => {
    if (win && !win.isDestroyed()) win.webContents.send(LOCAL_SERVER_EVENT, state);
  });
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
