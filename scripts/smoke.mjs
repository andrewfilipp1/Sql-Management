// Smoke test of the packaged app (run after `electron-builder --dir`), used by CI on Windows and macOS.
// Launches SchemaScope with a throw-away data folder and checks, through the DevTools protocol:
// window + preload security, SQLite (native module) through IPC, schema introspection and the local API server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const candidates = {
  win32: [path.join(root, 'release', 'win-unpacked', 'SchemaScope.exe')],
  darwin: ['mac-arm64', 'mac', 'mac-universal'].map((d) => path.join(root, 'release', d, 'SchemaScope.app', 'Contents', 'MacOS', 'SchemaScope')),
  linux: [path.join(root, 'release', 'linux-unpacked', 'schemascope')],
}[process.platform] ?? [];
const exe = process.argv[2] ?? candidates.find((p) => fs.existsSync(p));
if (!exe) {
  console.error('Packaged app not found. Run `npm run build && npx electron-builder --dir` first.');
  process.exit(2);
}

const port = 9400 + Math.floor(Math.random() * 400);
const apiPort = 48000 + Math.floor(Math.random() * 1000);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'schemascope-smoke-'));
const child = spawn(exe, [`--remote-debugging-port=${port}`], { env: { ...process.env, SCHEMASCOPE_USER_DATA: userData, SCHEMASCOPE_NO_UPDATE: '1' }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
};

let ws;
try {
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    await sleep(500);
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    } catch {}
  }
  if (!page) throw new Error('the app window did not open');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) pending.get(m.id)?.(m);
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const ipc = (m, ...a) => evaluate(`window.schemascope.invoke(${JSON.stringify(m)}, ...${JSON.stringify(a)})`);

  for (let i = 0; i < 40 && !(await evaluate(`document.body?.innerText.includes('SchemaScope')`)); i++) await sleep(250);
  check('window renders the UI', await evaluate(`document.body.innerText.includes('SchemaScope')`));
  const sec = await evaluate(`({ bridge: typeof window.schemascope?.invoke, require: typeof window.require, process: typeof window.process })`);
  check('renderer has the bridge and no Node.js access', sec.bridge === 'function' && sec.require === 'undefined' && sec.process === 'undefined', JSON.stringify(sec));

  const conns = await ipc('listConnections');
  const demo = conns.ok && conns.data.find((c) => c.kind === 'sqlite');
  check('demo connection created in the fresh data folder', !!demo);
  const connect = await ipc('connect', demo.id);
  check('SQLite native module loads (connect)', connect.ok, connect.ok ? connect.data.serverVersion : connect.error);
  const q = await ipc('query', demo.id, 'main', 'SELECT COUNT(*) FROM orders');
  check('query runs through IPC', q.ok && q.data.results[0].rows[0][0] === 240, q.ok ? `orders = ${q.data.results[0].rows[0][0]}` : q.error);
  const schema = await ipc('schema', demo.id, 'main', true);
  check('schema introspection', schema.ok && schema.data.tables.length >= 16, schema.ok ? `${schema.data.tables.length} tables` : schema.error);

  const srv = await ipc('setServer', { enabled: true, port: apiPort });
  check('local API server starts', srv.ok && srv.data.running, srv.ok ? srv.data.url : srv.error);
  const health = await fetch(`http://127.0.0.1:${apiPort}/v1/health`).then((r) => r.json()).catch((e) => ({ error: e.message }));
  check('API health endpoint answers', health.ok === true, JSON.stringify(health));
  const unauth = await fetch(`http://127.0.0.1:${apiPort}/v1/connections`).then((r) => r.status).catch(() => 0);
  check('API rejects requests without a key', unauth === 401, `status ${unauth}`);
  await ipc('setServer', { enabled: false });

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const up = await ipc('updateState');
  check('updater wired (checks off for this run)', up.ok && up.data.phase === 'disabled' && up.data.currentVersion === pkg.version, up.ok ? `${up.data.phase} v${up.data.currentVersion}` : up.error);
  const ai = await ipc('aiState');
  check('AI settings load (no key yet)', ai.ok && ai.data.hasKey === false, ai.ok ? ai.data.settings.model : ai.error);
  const nb = await ipc('saveNotebook', { id: '', name: 'Smoke', connId: demo.id, database: 'main', updatedAt: '', cells: [{ id: 'c1', kind: 'sql', source: 'SELECT 1' }] });
  const list = await ipc('listNotebooks');
  check('notebook saves and lists', nb.ok && list.ok && list.data.some((n) => n.id === nb.data.id), nb.ok ? '' : nb.error);

  check('no page exceptions', exceptions.length === 0, exceptions.slice(0, 2).join(' / '));
} catch (e) {
  check('smoke test ran', false, e.message);
} finally {
  ws?.close();
  child.kill();
  await sleep(500);
  fs.rmSync(userData, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed on ${process.platform}`);
process.exit(failed ? 1 : 0);
