/** Auto-update state pushed from the main process (GitHub Releases via electron-updater). */

export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  /** Newer version on GitHub Releases. */
  version?: string;
  /** Release notes as plain text. */
  notes?: string;
  /** Release page, for platforms that cannot install in place. */
  releaseUrl?: string;
  /** Download progress 0–100. */
  percent?: number;
  error?: string;
  /**
   * Whether the app can install the update itself (Windows installer, or the macOS bundle swap).
   * False on macOS when the app cannot replace itself, e.g. it runs from the disk image.
   */
  canInstall: boolean;
  /** Why an in-place install is not possible here (shown with the download link). */
  installBlockedReason?: string;
  /** The user clicked "Update now"; the app restarts as soon as the update is in place. */
  installing?: boolean;
  /** Why updates are off (development build, test run…). */
  disabledReason?: string;
}

export const UPDATE_EVENT = 'schemascope:update';
export const RELEASES_URL = 'https://github.com/andrewfilipp1/Sql-Management/releases';
