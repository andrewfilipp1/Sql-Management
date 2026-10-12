import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionConfig } from '../shared/types.ts';
import { createDatabaseSql } from '../shared/dialect.ts';
import {
  databaseNameProblem,
  DEFAULT_INSTANCE,
  DEFAULT_SERVER_COLLATION,
  instanceNameProblem,
  windowsPasswordProblem,
  LOCAL_SERVER_NAME,
  portProblem,
  saPasswordProblem,
  SERVER_COLLATIONS,
  type LocalEdition,
  type LocalServerOptions,
  type LocalServerState,
  type SetupStatus,
  type SetupStep,
} from '../shared/localServer.ts';
import { openDriver } from './pool.ts';
import { decodeSecret, encodeSecret, getDataDir, listConnections, upsertConnection } from './store.ts';
import { HttpError } from './util.ts';

/**
 * One-click local SQL Server.
 * macOS: Rosetta (Apple Silicon) → Docker Desktop → SQL Server 2022 image → container on 127.0.0.1.
 * Windows: SQL Server Express through Microsoft's unattended setup (the current Windows user is the admin;
 *   optionally SQL logins, a named instance, a collation and a fixed TCP port).
 * Every step is checked first and only installed when missing. Installers that need administrator rights
 * show the system's own password / UAC prompt.
 */

// Tests use their own container (SCHEMASCOPE_LOCAL_CONTAINER) so a real local server is never touched.
const CONTAINER = process.env.SCHEMASCOPE_LOCAL_CONTAINER || 'sql-graphic-tool-mssql';
const IMAGE = 'mcr.microsoft.com/mssql/server:2022-latest';
// Microsoft's permanent link to the current SQL Server Express installer (SQL Server 2025 as of late 2026).
// The download is accepted only with a valid Microsoft Authenticode signature.
const EXPRESS_BOOTSTRAPPER = 'https://go.microsoft.com/fwlink/p/?linkid=2216019&clcid=0x409&culture=en-us&country=us';
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

let emit: (s: LocalServerState) => void = () => {};
export function setLocalServerEmitter(fn: (s: LocalServerState) => void) {
  emit = fn;
}

// ---------------------------------------------------------------- state

function initialSteps(): SetupStep[] {
  if (isMac) {
    const steps: SetupStep[] = [];
    if (appleSilicon()) steps.push({ id: 'rosetta', label: 'Rosetta 2 (runs SQL Server’s Intel build)', status: 'pending' });
    steps.push(
      { id: 'docker', label: 'Docker Desktop', status: 'pending' },
      { id: 'docker-running', label: 'Docker engine running', status: 'pending' },
      { id: 'image', label: 'SQL Server 2022 image (~1.5 GB)', status: 'pending' },
      { id: 'container', label: 'Local SQL Server container', status: 'pending' },
      { id: 'connection', label: 'Connection in SQL Graphic Tool', status: 'pending' },
    );
    return steps;
  }
  if (isWin) {
    return [
      { id: 'download', label: 'SQL Server Express installer from Microsoft (~300 MB)', status: 'pending' },
      { id: 'express', label: 'SQL Server Express', status: 'pending' },
      { id: 'service', label: 'SQL Server service running', status: 'pending' },
      { id: 'connection', label: 'Connection in SQL Graphic Tool', status: 'pending' },
    ];
  }
  return [];
}

let state: LocalServerState = {
  platform: process.platform,
  supported: isMac || isWin,
  unsupportedReason: isMac || isWin ? undefined : 'One-click setup is available on macOS and Windows. Install SQL Server or PostgreSQL yourself and add a connection.',
  steps: initialSteps(),
  busy: false,
  ready: false,
};

function publish(patch: Partial<LocalServerState> = {}) {
  state = { ...state, ...patch, steps: state.steps.map((s) => ({ ...s })) };
  emit(state);
}

function step(id: string, status: SetupStatus, detail?: string, percent?: number) {
  const s = state.steps.find((x) => x.id === id);
  if (!s) return;
  s.status = status;
  s.detail = detail;
  s.percent = percent;
  publish();
}

export function localServerState(): LocalServerState {
  return state;
}

/** The local server's sa password, for copying to the clipboard. Never sent over the HTTP API. */
export function localServerPassword(): string | null {
  return (isWin ? readSavedExpress()?.password : readSaved()?.password) ?? null;
}

/** The optional “create a database” step exists only while an install asked for one. */
function setDatabaseStep(name?: string) {
  state.steps = state.steps.filter((s) => s.id !== 'database');
  if (name) state.steps.push({ id: 'database', label: `Database “${name}”`, status: 'pending' });
  publish();
}

// ---------------------------------------------------------------- saved local server settings

interface Saved {
  port: number;
  password: string; // encrypted
  edition: LocalEdition;
  /** Docker volume holding the databases. SQL Server keeps the sa password of the volume's first start. */
  volume: string;
  /** Server collation chosen at creation. */
  collation?: string;
}
const savedFile = () => path.join(getDataDir(), 'local-sqlserver.json');
function readSaved(): (Omit<Saved, 'password'> & { password: string }) | null {
  try {
    const s = JSON.parse(fs.readFileSync(savedFile(), 'utf8')) as Saved;
    return { ...s, password: decodeSecret(s.password).value };
  } catch {
    return null;
  }
}
function writeSaved(s: { port: number; password: string; edition: LocalEdition; volume: string; collation?: string }) {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(savedFile(), JSON.stringify({ ...s, password: encodeSecret(s.password) }, null, 2), { mode: 0o600 });
}

/** Windows: what was chosen when SQL Server Express was installed by the app. */
interface SavedExpress {
  instance: string;
  mixed: boolean;
  password?: string; // encrypted
  port?: number;
  collation?: string;
}
const savedExpressFile = () => path.join(getDataDir(), 'local-sqlexpress.json');
function readSavedExpress(): (Omit<SavedExpress, 'password'> & { password?: string }) | null {
  try {
    const s = JSON.parse(fs.readFileSync(savedExpressFile(), 'utf8')) as SavedExpress;
    return { ...s, password: s.password ? decodeSecret(s.password).value : undefined };
  } catch {
    return null;
  }
}
function writeSavedExpress(s: Omit<SavedExpress, 'password'> & { password?: string }) {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(savedExpressFile(), JSON.stringify({ ...s, password: s.password ? encodeSecret(s.password) : undefined }, null, 2), { mode: 0o600 });
}
function expressInfo(instance: string, saved: ReturnType<typeof readSavedExpress>) {
  const mine = saved?.instance.toUpperCase() === instance.toUpperCase() ? saved : null;
  return {
    host: `localhost\\${instance}`,
    port: mine?.port,
    user: mine?.mixed ? 'sa' : undefined,
    edition: 'Express' as const,
    collation: mine?.collation,
  };
}

// ---------------------------------------------------------------- process helpers

const EXTRA_PATH = isMac
  ? ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.docker', 'bin'), '/Applications/Docker.app/Contents/Resources/bin']
  : [];
const env = () => ({ ...process.env, PATH: [...EXTRA_PATH, process.env.PATH ?? ''].join(path.delimiter) });

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
function run(cmd: string, args: string[], timeout = 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: env(), timeout, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : '')) });
    });
  });
}

function appleSilicon(): boolean {
  if (!isMac) return false;
  if (process.arch === 'arm64') return true;
  try {
    return os.cpus()[0]?.model.includes('Apple') ?? false;
  } catch {
    return false;
  }
}

/** Runs a fixed shell command as administrator through the standard macOS password prompt. */
function macAdmin(command: string, prompt: string): Promise<RunResult> {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return run('/usr/bin/osascript', ['-e', `do shell script "${esc(command)}" with prompt "${esc(prompt)}" with administrator privileges`], 30 * 60_000);
}
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function dockerBin(): string {
  const found = EXTRA_PATH.map((d) => path.join(d, 'docker')).find((p) => fs.existsSync(p));
  return found ?? 'docker';
}
const docker = (args: string[], timeout?: number) => run(dockerBin(), args, timeout);

const firstLine = (s: string) => s.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 240) ?? '';

// ---------------------------------------------------------------- checks (no changes)

async function checkRosetta(): Promise<boolean> {
  return (await run('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], 15_000)).code === 0;
}
async function dockerInstalled(): Promise<boolean> {
  return fs.existsSync('/Applications/Docker.app') || (await docker(['--version'], 10_000)).code === 0;
}
async function dockerRunning(): Promise<boolean> {
  return (await docker(['info', '--format', '{{.ServerVersion}}'], 20_000)).code === 0;
}
async function imagePresent(): Promise<boolean> {
  return (await docker(['image', 'inspect', IMAGE, '--format', '{{.Id}}'], 20_000)).code === 0;
}
async function containerState(): Promise<string | null> {
  const r = await docker(['ps', '-a', '--filter', `name=^/${CONTAINER}$`, '--format', '{{.State}}'], 20_000);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
function localConnection(kind: 'docker' | 'express'): ConnectionConfig | undefined {
  return listConnections().find((c) => c.localServer === kind);
}
async function expressService(instance: string): Promise<'running' | 'stopped' | null> {
  const r = await run('sc.exe', ['query', `MSSQL$${instance}`], 15_000);
  if (r.code !== 0 || !/STATE/.test(r.stdout)) return null;
  return /RUNNING/.test(r.stdout) ? 'running' : 'stopped';
}

/** Checks every step without installing anything. */
export async function checkLocalServer(): Promise<LocalServerState> {
  if (!state.supported || state.busy) return state;
  publish({ busy: true, error: undefined });
  setDatabaseStep();
  try {
    if (isMac) {
      if (appleSilicon()) step('rosetta', (await checkRosetta()) ? 'ok' : 'missing');
      const installed = await dockerInstalled();
      step('docker', installed ? 'ok' : 'missing');
      const running = installed && (await dockerRunning());
      step('docker-running', running ? 'ok' : installed ? 'missing' : 'pending', running ? undefined : installed ? 'Will be started' : undefined);
      if (running) {
        step('image', (await imagePresent()) ? 'ok' : 'missing');
        const cs = await containerState();
        step('container', cs === 'running' ? 'ok' : cs ? 'missing' : 'missing', cs && cs !== 'running' ? `Stopped (${cs}) — will be started` : undefined);
      } else {
        step('image', 'pending');
        step('container', 'pending');
      }
      const conn = localConnection('docker');
      step('connection', conn ? 'ok' : 'missing', conn?.name);
      const saved = running && (await containerState()) ? readSaved() : null;
      publish({
        ready: state.steps.every((s) => s.status === 'ok'),
        connId: conn?.id,
        server: saved ? { host: 'localhost', port: saved.port, user: 'sa', edition: saved.edition, collation: saved.collation ?? DEFAULT_SERVER_COLLATION } : undefined,
        suggestedPort: saved ? undefined : await freePort([1433, 14330, 14331, 14332, 14333]),
      });
    } else if (isWin) {
      const saved = readSavedExpress();
      const instance = saved?.instance ?? DEFAULT_INSTANCE;
      const svc = await expressService(instance);
      step('download', svc ? 'ok' : 'missing', svc ? 'Not needed' : undefined);
      step('express', svc ? 'ok' : 'missing', svc ? `Instance ${instance}` : undefined);
      step('service', svc === 'running' ? 'ok' : svc ? 'missing' : 'pending', svc === 'stopped' ? 'Stopped — will be started' : undefined);
      const conn = localConnection('express');
      step('connection', conn ? 'ok' : 'missing', conn?.name);
      publish({ ready: state.steps.every((s) => s.status === 'ok'), connId: conn?.id, server: svc ? expressInfo(instance, saved) : undefined, suggestedPort: svc ? undefined : await freePort([1433, 14330, 14331, 14332, 14333]) });
    }
  } catch (e) {
    publish({ error: (e as Error).message });
  } finally {
    publish({ busy: false });
  }
  return state;
}

// ---------------------------------------------------------------- install

/** Checks the user's choices; throws a 400 with a message the UI can show. */
function validate(opts: LocalServerOptions) {
  const name = opts.name?.trim();
  if (name !== undefined && (!name || name.length > 100)) throw new HttpError(400, 'Enter a server name (up to 100 characters)');
  if (opts.port !== undefined) {
    const p = portProblem(opts.port);
    if (p) throw new HttpError(400, p);
  }
  if (opts.password) {
    const p = isWin ? windowsPasswordProblem(opts.password) : saPasswordProblem(opts.password);
    if (p) throw new HttpError(400, `sa password: ${p}`);
  }
  if (opts.serverCollation && !SERVER_COLLATIONS.includes(opts.serverCollation)) throw new HttpError(400, 'Unknown server collation');
  if (opts.instance !== undefined) {
    const p = instanceNameProblem(opts.instance);
    if (p) throw new HttpError(400, `Instance name: ${p}`);
  }
  if (opts.authMode && opts.authMode !== 'windows' && opts.authMode !== 'mixed') throw new HttpError(400, 'Unknown authentication mode');
  if (opts.database) {
    const p = databaseNameProblem(opts.database.name);
    if (p) throw new HttpError(400, `Database name: ${p}`);
    if (opts.database.collation && !/^[A-Za-z0-9_]+$/.test(opts.database.collation)) throw new HttpError(400, 'Unknown database collation');
  }
}

export async function installLocalServer(opts: LocalServerOptions): Promise<LocalServerState> {
  if (!state.supported) throw new HttpError(400, state.unsupportedReason ?? 'Not supported on this computer');
  if (!opts.acceptLicenses) throw new HttpError(400, 'Accept the license terms first');
  validate(opts);
  if (state.busy) return state;
  const database = opts.database ? { name: opts.database.name.trim(), collation: opts.database.collation || undefined } : undefined;
  publish({ busy: true, error: undefined, database: undefined });
  setDatabaseStep(database?.name);
  try {
    const cfg = isMac ? await installMac(opts) : await installWindows(opts);
    if (database) await createFirstDatabase(cfg, database);
    publish({ ready: true, database: database?.name });
  } catch (e) {
    const failed = state.steps.find((s) => s.status === 'working' || s.status === 'checking');
    if (failed) step(failed.id, 'failed', (e as Error).message);
    publish({ error: (e as Error).message, ready: false });
  } finally {
    publish({ busy: false });
  }
  return state;
}

async function installMac(opts: LocalServerOptions): Promise<ConnectionConfig> {
  const edition: LocalEdition = opts.edition === 'Developer' ? 'Developer' : 'Express';
  // 1. Rosetta
  if (appleSilicon()) {
    step('rosetta', 'checking');
    if (await checkRosetta()) step('rosetta', 'ok', 'Already installed');
    else {
      step('rosetta', 'working', 'Installing — enter your Mac password when asked');
      const r = await macAdmin('/usr/sbin/softwareupdate --install-rosetta --agree-to-license', 'SQL Graphic Tool wants to install Rosetta 2 (needed to run SQL Server).');
      if (r.code !== 0 || !(await checkRosetta())) throw new Error(/cancel/i.test(r.stderr) ? 'Cancelled' : `Rosetta install failed: ${firstLine(r.stderr || r.stdout)}`);
      step('rosetta', 'done', 'Installed');
    }
  }

  // 2. Docker Desktop
  step('docker', 'checking');
  if (await dockerInstalled()) step('docker', 'ok', 'Already installed');
  else await installDockerDesktop();

  // 3. Engine running
  step('docker-running', 'checking');
  if (await dockerRunning()) step('docker-running', 'ok', 'Already running');
  else {
    step('docker-running', 'working', 'Starting Docker…');
    await run('/usr/bin/open', ['-a', 'Docker'], 20_000);
    const started = Date.now();
    while (!(await dockerRunning())) {
      if (Date.now() - started > 240_000) throw new Error('Docker did not start. Open Docker Desktop once, finish its setup, then press Install again.');
      step('docker-running', 'working', `Starting Docker… ${Math.round((Date.now() - started) / 1000)} s`);
      await sleep(3000);
    }
    step('docker-running', 'done', 'Running');
  }

  // 4. Image
  step('image', 'checking');
  if (await imagePresent()) step('image', 'ok', 'Already downloaded');
  else await pullImage();

  // 5. Container
  step('container', 'checking');
  let saved = readSaved();
  let created = false;
  const cs = await containerState();
  if (cs === 'running' && saved) step('container', 'ok', `Already running on port ${saved.port}`);
  else if (cs && saved) {
    step('container', 'working', 'Starting…');
    const r = await docker(['start', CONTAINER], 60_000);
    if (r.code !== 0) throw new Error(firstLine(r.stderr));
    step('container', 'done', `Started on port ${saved.port}`);
  } else {
    if (cs && !saved) {
      // A container from an earlier setup whose password we no longer have: replace it. Its volume is left
      // untouched (never deleted automatically) and the new server gets a fresh volume, since SQL Server keeps
      // the password of a volume's first start.
      await docker(['rm', '-f', CONTAINER], 60_000);
    }
    const password = opts.password || strongPassword();
    const volume = `${CONTAINER}-${crypto.randomBytes(4).toString('hex')}`;
    const collation = opts.serverCollation || DEFAULT_SERVER_COLLATION;
    let port: number;
    if (opts.port) {
      if (!(await portFree(opts.port))) throw new Error(`Port ${opts.port} is already in use — choose another one`);
      port = opts.port;
    } else port = await freePort([1433, 14330, 14331, 14332, 14333]);
    step('container', 'working', `Creating SQL Server ${edition} on port ${port}…`);
    const r = await docker(
      [
        'run', '-d', '--name', CONTAINER,
        '--platform', 'linux/amd64',
        '--restart', 'unless-stopped',
        '-e', 'ACCEPT_EULA=Y',
        '-e', `MSSQL_PID=${edition}`,
        '-e', `MSSQL_SA_PASSWORD=${password}`,
        '-e', `MSSQL_COLLATION=${collation}`,
        '-p', `127.0.0.1:${port}:1433`,
        '-v', `${volume}:/var/opt/mssql`,
        IMAGE,
      ],
      120_000,
    );
    if (r.code !== 0) throw new Error(`Could not create the container: ${firstLine(r.stderr)}`);
    saved = { port, password, edition, volume, collation };
    writeSaved(saved);
    created = true;
    step('container', 'done', `Created on port ${port}`);
  }

  // 6. Ready + connection
  step('connection', 'working', 'Waiting for SQL Server to accept connections…');
  const cfg: ConnectionConfig = {
    id: '',
    name: LOCAL_SERVER_NAME,
    kind: 'mssql',
    host: '127.0.0.1',
    port: saved!.port,
    user: 'sa',
    password: saved!.password,
    trustServerCertificate: true,
    environment: 'development',
    localServer: 'docker',
  };
  await waitForServer(cfg, 'connection');
  if (created && saved!.collation && saved!.collation !== DEFAULT_SERVER_COLLATION) {
    // On first start SQL Server accepts connections, then rebuilds its system databases with the new
    // collation and restarts. Anything created before that finishes is left broken, so wait for it.
    await waitForCollationChange();
    await waitForServer(cfg, 'connection');
  }
  const existing = localConnection('docker');
  const conn = upsertConnection({ ...cfg, id: existing?.id ?? '', name: opts.name?.trim() || existing?.name || cfg.name });
  step('connection', existing ? 'ok' : 'done', existing ? `Updated “${conn.name}”` : `Added “${conn.name}”`);
  publish({ connId: conn.id, server: { host: 'localhost', port: saved!.port, user: 'sa', edition: saved!.edition, collation: saved!.collation ?? DEFAULT_SERVER_COLLATION } });
  return cfg;
}

async function installDockerDesktop() {
  const arch = appleSilicon() ? 'arm64' : 'amd64';
  const url = `https://desktop.docker.com/mac/main/${arch}/Docker.dmg`;
  const dir = path.join(getDataDir(), 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  const dmg = path.join(dir, 'Docker.dmg');
  step('docker', 'working', 'Downloading Docker Desktop…', 0);
  await download(url, dmg, (p, mb) => step('docker', 'working', `Downloading Docker Desktop… ${mb} MB`, p));
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-dmg-'));
  step('docker', 'working', 'Installing — enter your Mac password when asked');
  const att = await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], 180_000);
  if (att.code !== 0) throw new Error(`Could not open Docker.dmg: ${firstLine(att.stderr)}`);
  try {
    const user = os.userInfo().username;
    if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error('Unexpected user name');
    // Docker's documented command-line install (copies Docker.app to /Applications and sets up its helper).
    const r = await macAdmin(`${shq(path.join(mount, 'Docker.app/Contents/MacOS/install'))} --accept-license --user=${shq(user)}`, 'SQL Graphic Tool wants to install Docker Desktop (runs the local SQL Server).');
    if (r.code !== 0) throw new Error(/cancel/i.test(r.stderr) ? 'Cancelled' : `Docker install failed: ${firstLine(r.stderr || r.stdout)}`);
  } finally {
    await run('/usr/bin/hdiutil', ['detach', mount, '-force'], 60_000);
    fs.rmSync(dmg, { force: true });
  }
  if (!(await dockerInstalled())) throw new Error('Docker Desktop was not installed');
  step('docker', 'done', 'Installed');
}

function pullImage(): Promise<void> {
  step('image', 'working', 'Downloading SQL Server…', 0);
  return new Promise((resolve, reject) => {
    const p = spawn(dockerBin(), ['pull', '--platform', 'linux/amd64', IMAGE], { env: env() });
    const layers = new Map<string, boolean>();
    let tail = '';
    const onData = (b: Buffer) => {
      const text = b.toString();
      tail = (tail + text).slice(-2000);
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^([0-9a-f]{12}): (.*)$/);
        if (!m) continue;
        if (/Pull complete|Already exists/.test(m[2])) layers.set(m[1], true);
        else if (!layers.has(m[1])) layers.set(m[1], false);
      }
      const total = layers.size || 1;
      const done = [...layers.values()].filter(Boolean).length;
      step('image', 'working', `Downloading SQL Server… ${done}/${layers.size || '?'} parts`, Math.round((done / total) * 100));
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) {
        step('image', 'done', 'Downloaded', 100);
        resolve();
      } else reject(new Error(`Download failed: ${firstLine(tail)}`));
    });
  });
}

async function installWindows(opts: LocalServerOptions): Promise<ConnectionConfig> {
  const instance = (opts.instance || DEFAULT_INSTANCE).toUpperCase();
  const mixed = opts.authMode === 'mixed';

  step('download', 'checking');
  step('express', 'checking');
  const existing0 = await expressService(instance);
  if (existing0) {
    step('download', 'ok', 'Not needed');
    step('express', 'ok', `Instance ${instance} already installed`);
  } else {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-graphic-tool-express-'));
    try {
      const setupExe = await downloadExpress(work);
      const password = mixed ? opts.password || strongPassword() : undefined;
      const port = opts.tcp ? opts.port || (await freePort([1433, 14330, 14331, 14332, 14333])) : undefined;
      if (port && !(await portFree(port))) throw new Error(`Port ${port} is already in use — choose another one`);
      step('express', 'working', 'Installing — allow the Windows prompt. This takes several minutes…');
      await runExpressSetup(work, setupExe, { instance, password, collation: opts.serverCollation || undefined, port });
      writeSavedExpress({ instance, mixed, password, port, collation: opts.serverCollation || undefined });
      step('express', 'done', `Installed (instance ${instance})`);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  step('service', 'checking');
  if ((await expressService(instance)) === 'running') step('service', 'ok', 'Running');
  else {
    step('service', 'working', 'Starting — allow the Windows prompt');
    await runElevated(`Start-Service -Name ${psQuote(`MSSQL$${instance}`)}`, 120_000);
    const started = Date.now();
    while ((await expressService(instance)) !== 'running') {
      if (Date.now() - started > 60_000) throw new Error('The SQL Server service did not start');
      await sleep(2000);
    }
    step('service', 'done', 'Running');
  }

  step('connection', 'working', 'Connecting…');
  const cfg: ConnectionConfig = {
    id: '',
    name: 'Local SQL Server Express',
    kind: 'mssql',
    host: 'localhost',
    instance,
    authType: 'windows',
    trustServerCertificate: true,
    environment: 'development',
    localServer: 'express',
  };
  await waitForServer(cfg, 'connection');
  const existing = localConnection('express');
  const conn = upsertConnection({ ...cfg, id: existing?.id ?? '', name: opts.name?.trim() || existing?.name || cfg.name });
  step('connection', existing ? 'ok' : 'done', existing ? `Updated “${conn.name}”` : `Added “${conn.name}”`);
  publish({ connId: conn.id, server: expressInfo(instance, readSavedExpress()) });
  return cfg;
}

// ---------------------------------------------------------------- SQL Server Express (Windows)

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Runs PowerShell code as administrator (one UAC prompt) and waits for it. */
async function runElevated(code: string, timeout: number): Promise<RunResult> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-graphic-tool-ps-'));
  const script = path.join(work, 'run.ps1');
  fs.writeFileSync(script, `\ufeff$ErrorActionPreference = 'Stop'\r\n${code}\r\n`, 'utf8');
  const outer =
    `$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden ` +
    `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + ${psQuote(script)} + '"')); exit $p.ExitCode`;
  try {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(outer, 'utf16le').toString('base64')], timeout);
    if (r.code !== 0 && /cancel/i.test(r.stderr)) throw new Error('Cancelled — the Windows permission prompt was declined');
    return r;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function microsoftSigned(file: string): Promise<boolean> {
  const r = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `$s = Get-AuthenticodeSignature -LiteralPath ${psQuote(file)}; if ($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match 'O=Microsoft Corporation') { 'ok' }`],
    60_000,
  );
  return r.stdout.trim() === 'ok';
}

function folderSize(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? folderSize(p) : fs.statSync(p).size;
  }
  return n;
}

/** Downloads Microsoft's bootstrapper, lets it fetch the Express package, and unpacks setup.exe. */
async function downloadExpress(work: string): Promise<string> {
  step('download', 'working', 'Downloading the installer…');
  const boot = path.join(work, 'SQL-SSEI-Expr.exe');
  await download(EXPRESS_BOOTSTRAPPER, boot, (pct) => step('download', 'working', 'Downloading the installer…', pct));
  if (!(await microsoftSigned(boot))) throw new Error('The downloaded installer is not signed by Microsoft; it was not run');

  const media = path.join(work, 'media');
  fs.mkdirSync(media);
  const job = run(boot, ['/ACTION=Download', `/MEDIAPATH=${media}`, '/MEDIATYPE=Core', '/QUIET'], 60 * 60_000);
  let done = false;
  void job.finally(() => (done = true));
  while (!done) {
    await sleep(1500);
    try {
      step('download', 'working', `Downloading SQL Server Express… ${Math.round(folderSize(media) / 1e6)} MB`);
    } catch {}
  }
  const r = await job;
  const pkg = fs.readdirSync(media).find((n) => /^SQLEXPR.*\.exe$/i.test(n));
  if (!pkg) throw new Error(`The SQL Server Express download failed: ${firstLine(r.stderr || r.stdout) || `exit code ${r.code}`}`);
  const pkgPath = path.join(media, pkg);
  if (!(await microsoftSigned(pkgPath))) throw new Error('The SQL Server Express package is not signed by Microsoft; it was not run');

  step('download', 'working', 'Unpacking…');
  const unpacked = path.join(work, 'setup');
  await run(pkgPath, ['/q', `/x:${unpacked}`], 30 * 60_000);
  const setupExe = path.join(unpacked, 'SETUP.EXE');
  if (!fs.existsSync(setupExe)) throw new Error('Could not unpack the SQL Server Express package');
  step('download', 'done', 'Downloaded and verified (signed by Microsoft)');
  return setupExe;
}

/**
 * Microsoft's unattended setup with the user's choices. The sa password goes through a configuration file
 * in this user's temp folder (not the command line) and is deleted right after setup.
 */
async function runExpressSetup(work: string, setupExe: string, o: { instance: string; password?: string; collation?: string; port?: number }) {
  const ini = path.join(work, 'config.ini');
  const lines = [
    '[OPTIONS]',
    'ACTION="Install"',
    'QUIET="True"',
    'IACCEPTSQLSERVERLICENSETERMS="True"',
    'SUPPRESSPRIVACYSTATEMENTNOTICE="True"',
    'ENU="True"',
    'FEATURES=SQLENGINE',
    `INSTANCENAME="${o.instance}"`,
    `INSTANCEID="${o.instance}"`,
    'SQLSVCSTARTUPTYPE="Automatic"',
    `TCPENABLED="${o.port ? 1 : 0}"`,
    'UPDATEENABLED="False"',
    ...(o.collation ? [`SQLCOLLATION="${o.collation}"`] : []),
    ...(o.password ? ['SECURITYMODE="SQL"', `SAPWD="${o.password}"`] : []),
  ];
  fs.writeFileSync(ini, lines.join('\r\n') + '\r\n', { mode: 0o600 });
  // The installing (elevated) account may differ from the signed-in user; make the signed-in user the admin.
  const me = `${process.env.USERDOMAIN ?? os.hostname()}\\${process.env.USERNAME ?? os.userInfo().username}`;
  const result = path.join(work, 'result.txt');
  const portScript = o.port
    ? [
        `$id = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL').PSObject.Properties[${psQuote(o.instance)}].Value`,
        `$k = "HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\$id\\MSSQLServer\\SuperSocketNetLib\\Tcp\\IPAll"`,
        `Set-ItemProperty -Path $k -Name TcpDynamicPorts -Value ''`,
        `Set-ItemProperty -Path $k -Name TcpPort -Value ${psQuote(String(o.port))}`,
        `Restart-Service -Name ${psQuote(`MSSQL$${o.instance}`)} -Force`,
      ].join('\r\n')
    : '';
  const code = [
    'try {',
    `  $p = Start-Process -FilePath ${psQuote(setupExe)} -ArgumentList @(${psQuote(`/CONFIGURATIONFILE="${ini}"`)}, ${psQuote(`/SQLSYSADMINACCOUNTS="${me}"`)}) -Wait -PassThru -WindowStyle Hidden`,
    `  Remove-Item -LiteralPath ${psQuote(ini)} -Force -ErrorAction SilentlyContinue`,
    `  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { "setup:$($p.ExitCode)" | Set-Content -LiteralPath ${psQuote(result)}; exit 2 }`,
    portScript,
    `  "ok:$($p.ExitCode)" | Set-Content -LiteralPath ${psQuote(result)}`,
    '} catch {',
    `  Remove-Item -LiteralPath ${psQuote(ini)} -Force -ErrorAction SilentlyContinue`,
    `  ("error:" + $_.Exception.Message) | Set-Content -LiteralPath ${psQuote(result)}; exit 3`,
    '}',
  ].join('\r\n');
  try {
    await runElevated(code, 90 * 60_000);
  } finally {
    fs.rmSync(ini, { force: true });
  }
  const out = fs.existsSync(result) ? fs.readFileSync(result, 'utf8').trim() : '';
  if (out.startsWith('ok:')) return;
  if (out.startsWith('setup:')) throw new Error(`SQL Server setup failed (code ${out.slice(6)}). Details: C:\\Program Files\\Microsoft SQL Server\\*\\Setup Bootstrap\\Log\\Summary.txt`);
  if (out.startsWith('error:')) throw new Error(`SQL Server setup failed: ${out.slice(6)}`);
  throw new Error('SQL Server setup did not run — the Windows permission prompt may have been declined');
}

/** Creates the first database (or leaves an existing one with that name alone). */
async function createFirstDatabase(cfg: ConnectionConfig, db: { name: string; collation?: string }) {
  step('database', 'working', 'Creating…');
  const d = await openDriver(cfg, 'master');
  try {
    const exists = await d.exec('SELECT DB_ID(@p1)', [db.name]);
    if (exists.rows[0]?.[0] != null) {
      step('database', 'ok', 'Already exists');
      return;
    }
    await d.exec(createDatabaseSql('mssql', db.name, { collation: db.collation }));
    step('database', 'done', db.collation ? `Created (${db.collation})` : 'Created');
  } finally {
    await d.close();
  }
}

// ---------------------------------------------------------------- utilities

async function waitForServer(cfg: ConnectionConfig, stepId: string) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 180_000) {
    try {
      const d = await openDriver(cfg, 'master');
      await d.close();
      return;
    } catch (e) {
      last = (e as Error).message;
      step(stepId, 'working', `Waiting for SQL Server to start… ${Math.round((Date.now() - started) / 1000)} s`);
      await sleep(3000);
    }
  }
  throw new Error(`SQL Server did not accept connections: ${last}`);
}

async function waitForCollationChange() {
  const started = Date.now();
  while (Date.now() - started < 300_000) {
    const r = await docker(['logs', CONTAINER], 30_000);
    const log = r.stdout + r.stderr;
    if (/default collation was successfully changed/i.test(log)) return;
    if (/collation .*(failed|could not)/i.test(log)) throw new Error('SQL Server could not apply the chosen collation');
    step('connection', 'working', `Applying the server collation… ${Math.round((Date.now() - started) / 1000)} s`);
    await sleep(2000);
  }
  throw new Error('SQL Server did not finish applying the collation');
}

function strongPassword(): string {
  // SQL Server policy: 8+ chars with upper, lower, digit and symbol.
  return `Sgt-${crypto.randomBytes(18).toString('base64url')}-9a!`;
}

async function freePort(candidates: number[]): Promise<number> {
  for (const p of candidates) if (await portFree(p)) return p;
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function download(url: string, file: string, progress: (percent: number, mb: number) => void) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(file);
  let got = 0;
  let lastReport = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (Date.now() - lastReport > 400) {
        lastReport = Date.now();
        progress(total ? Math.round((got / total) * 100) : 0, Math.round(got / 1048576));
      }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (total && got !== total) throw new Error('Download was interrupted');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- used by .bak restore

/** Copies a file into the local container and returns its path there. */
export async function copyIntoContainer(file: string): Promise<string> {
  const dir = '/var/opt/mssql/backup';
  await docker(['exec', '-u', '0', CONTAINER, 'mkdir', '-p', dir], 30_000);
  const target = `${dir}/${crypto.randomUUID()}.bak`;
  const r = await docker(['cp', file, `${CONTAINER}:${target}`], 30 * 60_000);
  if (r.code !== 0) throw new HttpError(500, `Could not copy the backup into the local server: ${firstLine(r.stderr)}`);
  // Readable by the mssql user inside the container.
  await docker(['exec', '-u', '0', CONTAINER, 'chmod', '644', target], 30_000);
  return target;
}

export async function removeFromContainer(target: string) {
  if (target.startsWith('/var/opt/mssql/backup/')) await docker(['exec', '-u', '0', CONTAINER, 'rm', '-f', target], 30_000);
}
