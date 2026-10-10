import { app, net } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { UpdateInfo } from 'electron-updater';

/**
 * In-place updates for the unsigned macOS build. Squirrel.Mac (what electron-updater uses) only
 * accepts Apple-signed apps, so this downloads the release .zip itself, checks it against the
 * SHA-512 published in latest-mac.yml, and swaps the .app bundle after the app quits.
 */

const run = promisify(execFile);
const MAX_BYTES = 1024 ** 3;

/** The running .app bundle, e.g. /Applications/SQL Graphic Tool.app. */
export function currentBundle(): string {
  return path.resolve(process.execPath, '../../..');
}

/** Why the app cannot replace itself here, or undefined when it can. */
export function installProblem(): string | undefined {
  const bundle = currentBundle();
  if (!bundle.endsWith('.app')) return 'Not running from an app bundle';
  if (bundle.startsWith('/Volumes/')) return 'Move SQL Graphic Tool to the Applications folder first (it is running from the disk image).';
  if (bundle.includes('/AppTranslocation/')) return 'Move SQL Graphic Tool to the Applications folder and open it from there.';
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
  } catch {
    return `No permission to replace the app in ${path.dirname(bundle)}.`;
  }
  return undefined;
}

function updateDir() {
  return path.join(app.getPath('temp'), 'sql-graphic-tool-update');
}

/** The release asset for this Mac: the .zip for this CPU architecture. */
function pickZip(info: UpdateInfo) {
  const zips = info.files.filter((f) => f.url.endsWith('.zip'));
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return zips.find((f) => f.url.includes(`-${arch}.`)) ?? (arch === 'x64' ? zips.find((f) => !/arm64/.test(f.url)) : undefined);
}

let staged: string | null = null;

/**
 * Downloads and unpacks the update. `baseUrl` is where release assets live
 * (GitHub: …/releases/download/v<version>). Resolves to the unpacked .app, ready to install.
 */
export async function downloadMacUpdate(info: UpdateInfo, baseUrl: string, onProgress: (percent: number) => void): Promise<string> {
  const file = pickZip(info);
  if (!file) throw new Error(`This release has no download for ${process.arch} Macs`);
  if (!file.sha512) throw new Error('The release has no checksum; not installing it');
  const name = path.basename(file.url);
  const url = /^https?:\/\//.test(file.url) ? file.url : `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(name)}`;
  if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error('Refusing to download an update over plain http');

  const dir = updateDir();
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  const zip = path.join(dir, 'update.zip');

  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || file.size || 0;
  if (total > MAX_BYTES) throw new Error('Update is unexpectedly large');
  const hash = createHash('sha512');
  const out = fs.createWriteStream(zip);
  let got = 0;
  let last = -1;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > MAX_BYTES) throw new Error('Update is unexpectedly large');
      hash.update(value);
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      const pct = total ? Math.min(99, Math.floor((got / total) * 100)) : 0;
      if (pct !== last) onProgress((last = pct));
    }
  } finally {
    await new Promise<void>((r) => out.end(r));
  }
  if (hash.digest('base64') !== file.sha512) {
    await fs.promises.rm(dir, { recursive: true, force: true });
    throw new Error('The download does not match the published checksum; it was discarded');
  }

  const unpacked = path.join(dir, 'app');
  await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
  await fs.promises.rm(zip, { force: true });
  const apps = (await fs.promises.readdir(unpacked)).filter((n) => n.endsWith('.app'));
  if (apps.length !== 1) throw new Error('The update archive does not contain the app');
  const next = path.join(unpacked, apps[0]);

  // Same app, and the version the feed promised.
  const plist = async (bundle: string, key: string) =>
    (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist')])).stdout.trim();
  const [id, nextId, nextVersion] = await Promise.all([
    plist(currentBundle(), 'CFBundleIdentifier'),
    plist(next, 'CFBundleIdentifier'),
    plist(next, 'CFBundleShortVersionString'),
  ]);
  if (nextId !== id) throw new Error('The update is for a different app; not installing it');
  if (nextVersion !== info.version) throw new Error(`The update contains version ${nextVersion}, expected ${info.version}`);
  await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', next]).catch(() => undefined);

  onProgress(100);
  staged = next;
  return next;
}

/**
 * Quits, swaps the bundle and reopens the app. A detached shell waits for this process to exit
 * so the running app is never modified; if the swap fails the old version is put back.
 */
export function installMacUpdate() {
  if (!staged || !fs.existsSync(staged)) throw new Error('No downloaded update');
  const problem = installProblem();
  if (problem) throw new Error(problem);
  const script = path.join(updateDir(), 'install.sh');
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      'PID="$1"; OLD="$2"; NEW="$3"; BAK="$OLD.previous"',
      'while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done',
      'rm -rf "$BAK"',
      'if mv "$OLD" "$BAK"; then',
      '  if mv "$NEW" "$OLD"; then rm -rf "$BAK"; else mv "$BAK" "$OLD"; fi',
      'fi',
      // Test runs use a separate data folder; keep it after the relaunch.
      'if [ -n "$SCHEMASCOPE_USER_DATA" ]; then open --env "SCHEMASCOPE_USER_DATA=$SCHEMASCOPE_USER_DATA" "$OLD"; else open "$OLD"; fi',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  spawn('/bin/sh', [script, String(process.pid), currentBundle(), staged], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}
