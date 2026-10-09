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
   * In-place install works for the Windows installer. macOS only installs signed apps,
   * so unsigned builds link to the release page instead.
   */
  canInstall: boolean;
  /** Why updates are off (development build, test run…). */
  disabledReason?: string;
}

export const UPDATE_EVENT = 'schemascope:update';
export const RELEASES_URL = 'https://github.com/andrewfilipp1/Sql-Management/releases';
