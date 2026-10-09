import { app, type BrowserWindow } from 'electron';
import electronUpdater, { type UpdateInfo } from 'electron-updater';
import { RELEASES_URL, UPDATE_EVENT, type UpdateState } from '../shared/update.ts';

// electron-updater is CommonJS; this form works when bundled to CJS as well.
const { autoUpdater } = electronUpdater;

/**
 * Updates come from GitHub Releases (see "publish" in package.json and .github/workflows/release.yml).
 * Nothing is downloaded without the user asking. Windows installs in place; macOS needs a signed
 * app for that, so there the user gets a link to the release page.
 */
let state: UpdateState = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  canInstall: process.platform === 'win32',
};
let window: BrowserWindow | null = null;

function set(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  if (window && !window.isDestroyed()) window.webContents.send(UPDATE_EVENT, state);
}

function notesText(info: UpdateInfo): string | undefined {
  const raw = Array.isArray(info.releaseNotes) ? info.releaseNotes.map((n) => n.note ?? '').join('\n\n') : info.releaseNotes;
  if (!raw) return undefined;
  // GitHub sends HTML; the UI shows plain text only.
  return raw
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|li|h\d)>|<br\s*\/?>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

/** The window that receives status events (re-set when macOS re-creates it). */
export function setUpdateWindow(win: BrowserWindow) {
  window = win;
}

export function initUpdater() {
  const reason = !app.isPackaged ? 'Development build' : process.env.SCHEMASCOPE_NO_UPDATE ? 'Disabled for this run' : undefined;
  if (reason) {
    set({ phase: 'disabled', disabledReason: reason });
    return;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  // Test hook: read the update feed from a local server instead of GitHub (used by the e2e tests).
  if (process.env.SCHEMASCOPE_UPDATE_FEED) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.SCHEMASCOPE_UPDATE_FEED });

  autoUpdater.on('checking-for-update', () => set({ phase: 'checking', error: undefined }));
  autoUpdater.on('update-not-available', () => set({ phase: 'none' }));
  autoUpdater.on('update-available', (info) =>
    set({ phase: 'available', version: info.version, notes: notesText(info), releaseUrl: `${RELEASES_URL}/tag/v${info.version}` }),
  );
  autoUpdater.on('download-progress', (p) => set({ phase: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', () => set({ phase: 'ready', percent: 100 }));
  autoUpdater.on('error', (e) => set({ phase: 'error', error: friendly(e) }));

  // Quietly check once shortly after start.
  setTimeout(() => void checkForUpdates().catch(() => undefined), 15_000);
}

function friendly(e: Error): string {
  const m = e?.message ?? String(e);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(m)) return 'Could not reach GitHub';
  if (/404|latest.*\.yml/i.test(m)) return 'No published release found yet';
  return m.split('\n')[0].slice(0, 200);
}

export function updateState(): UpdateState {
  return state;
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (state.phase === 'disabled' || state.phase === 'downloading') return state;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    set({ phase: 'error', error: friendly(e as Error) });
  }
  return state;
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (state.phase !== 'available' && state.phase !== 'error') return state;
  if (!state.canInstall) return state;
  set({ phase: 'downloading', percent: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    set({ phase: 'error', error: friendly(e as Error) });
  }
  return state;
}

export function installUpdate() {
  if (state.phase === 'ready') setImmediate(() => autoUpdater.quitAndInstall());
}
