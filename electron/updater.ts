import { app, type BrowserWindow } from 'electron';
import electronUpdater, { type UpdateInfo } from 'electron-updater';
import { RELEASES_URL, UPDATE_EVENT, type UpdateState } from '../shared/update.ts';
import { downloadMacUpdate, installMacUpdate, installProblem } from './macUpdater.ts';

// electron-updater is CommonJS; this form works when bundled to CJS as well.
const { autoUpdater } = electronUpdater;

/**
 * Updates come from GitHub Releases (see "publish" in package.json and .github/workflows/release.yml).
 * A newer release is downloaded quietly in the background, but nothing is installed until the user
 * clicks "Update now" (the notification bell). Windows installs in place through electron-updater;
 * the unsigned macOS build uses macUpdater.ts, which swaps the app bundle itself.
 */
const isMac = process.platform === 'darwin';
let state: UpdateState = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  canInstall: process.platform === 'win32' || isMac,
};
let available: UpdateInfo | null = null;
/** The user clicked "Update now" before the background download finished. */
let installWhenReady = false;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
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
  if (isMac) {
    const problem = installProblem();
    if (problem) set({ canInstall: false, installBlockedReason: problem });
  }
  // Test hook: read the update feed from a local server instead of GitHub (used by the e2e tests).
  if (process.env.SCHEMASCOPE_UPDATE_FEED) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.SCHEMASCOPE_UPDATE_FEED });

  autoUpdater.on('checking-for-update', () => set({ phase: 'checking', error: undefined }));
  autoUpdater.on('update-not-available', () => set({ phase: 'none' }));
  autoUpdater.on('update-available', (info) => {
    available = info;
    set({ phase: 'available', version: info.version, notes: notesText(info), releaseUrl: `${RELEASES_URL}/tag/v${info.version}` });
    if (state.canInstall) void downloadUpdate();
  });
  autoUpdater.on('download-progress', (p) => set({ phase: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', () => {
    set({ phase: 'ready', percent: 100 });
    if (installWhenReady) installUpdate();
  });
  autoUpdater.on('error', (e) => {
    installWhenReady = false;
    set({ phase: 'error', installing: false, error: friendly(e) });
  });

  // Quietly check shortly after start, then every few hours while the app stays open.
  setTimeout(() => void checkForUpdates().catch(() => undefined), 15_000);
  setInterval(() => void checkForUpdates().catch(() => undefined), CHECK_EVERY_MS).unref();
}

function friendly(e: Error): string {
  const m = e?.message ?? String(e);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(m)) return 'Could not reach GitHub';
  if (/404|latest.*\.yml/i.test(m)) return 'No published release found yet';
  if (/EACCES|EPERM/i.test(m)) return 'No permission to write the update';
  return m.split('\n')[0].slice(0, 200);
}

export function updateState(): UpdateState {
  return state;
}

export async function checkForUpdates(): Promise<UpdateState> {
  // An update already downloaded (or downloading) stays as it is until the user installs it.
  if (state.phase === 'disabled' || state.phase === 'downloading' || state.phase === 'ready') return state;
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
    if (isMac) {
      if (!available) throw new Error('Check for updates first');
      const base = process.env.SCHEMASCOPE_UPDATE_FEED || `${RELEASES_URL}/download/v${available.version}`;
      await downloadMacUpdate(available, base, (percent) => set({ phase: 'downloading', percent }));
      set({ phase: 'ready', percent: 100 });
      if (installWhenReady) installUpdate();
      return state;
    }
    await autoUpdater.downloadUpdate();
  } catch (e) {
    installWhenReady = false;
    set({ phase: 'error', installing: false, error: friendly(e as Error) });
  }
  return state;
}

/**
 * "Update now": installs and restarts. If the background download has not finished (or failed),
 * it is finished first and the install follows on its own.
 */
export function installUpdate() {
  if (state.phase !== 'ready') {
    if (!state.version || !state.canInstall) return;
    installWhenReady = true;
    set({ installing: true });
    if (state.phase !== 'downloading') void downloadUpdate();
    return;
  }
  set({ installing: true });
  setImmediate(() => {
    // Silent install, then start the new version.
    if (!isMac) return autoUpdater.quitAndInstall(true, true);
    try {
      installMacUpdate();
    } catch (e) {
      installWhenReady = false;
      set({ phase: 'error', installing: false, error: friendly(e as Error) });
    }
  });
}
