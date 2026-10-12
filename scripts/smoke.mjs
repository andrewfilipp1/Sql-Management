// Smoke test of the packaged app (run after `electron-builder --dir`), used by CI on Windows and macOS.
// Launches SQL Graphic Tool with a throw-away data folder and checks, through the DevTools protocol:
// window + preload security, SQLite (native module) through IPC, schema introspection and the local API server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const candidates = {
  win32: [path.join(root, 'release', 'win-unpacked', 'SQL Graphic Tool.exe')],
  darwin: ['mac-arm64', 'mac', 'mac-universal'].map((d) => path.join(root, 'release', d, 'SQL Graphic Tool.app', 'Contents', 'MacOS', 'SQL Graphic Tool')),
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
const names = [];
const check = (name, ok, info = '') => {
  results.push(ok);
  names.push(`${ok ? '✓' : '✗'} ${name}${ok || !info ? '' : ` — ${String(info).replace(/[\r\n]+/g, ' ').slice(0, 400)}`}`);
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
  // A call that gets no answer in 2 minutes resolves empty, so a hung app is reported instead of stalling the run.
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      const t = setTimeout(() => (pending.delete(i), r({ result: { result: { value: { ok: false, error: `no answer to ${method} in 2 min` } } } })), 120_000);
      pending.set(i, (m) => (clearTimeout(t), r(m)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const ipc = (m, ...a) => evaluate(`window.schemascope.invoke(${JSON.stringify(m)}, ...${JSON.stringify(a)})`);

  for (let i = 0; i < 40 && !(await evaluate(`document.body?.innerText.includes('SQL Graphic Tool')`)); i++) await sleep(250);
  check('window renders the UI', await evaluate(`document.body.innerText.includes('SQL Graphic Tool')`));
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

  // Windows CI: integrated Windows authentication against SQL Server LocalDB (through msnodesqlv8 / ODBC).
  if (process.env.SMOKE_MSSQL_LOCALDB) {
    const saved = await ipc('saveConnection', { name: 'LocalDB (smoke)', kind: 'mssql', host: '(localdb)\\MSSQLLocalDB', authType: 'windows' });
    const c = saved.ok && (await ipc('connect', saved.data.id));
    check('Windows auth: connects to LocalDB', !!c?.ok, c?.ok ? c.data.serverVersion : saved.error ?? c?.error);
    if (c?.ok) {
      const who = await ipc('query', saved.data.id, 'master', 'SELECT SUSER_SNAME() AS login');
      const login = who.ok ? String(who.data.results[0].rows[0][0]) : who.error;
      check('Windows auth: signed in as the Windows user', who.ok && login.includes('\\'), login);
      const db = 'schemascope_smoke';
      const script = `IF DB_ID('${db}') IS NULL CREATE DATABASE ${db}`;
      await ipc('query', saved.data.id, 'master', script, { confirmed: true });
      const t = await ipc('query', saved.data.id, db, "CREATE TABLE t (id INT IDENTITY PRIMARY KEY, name NVARCHAR(50), amount DECIMAL(10,2)); INSERT INTO t (name, amount) VALUES (N'Μαρία', 12.5), (N'Nikos', 3); SELECT COUNT(*) AS n, SUM(amount) AS s FROM t;", { confirmed: true });
      check('Windows auth: DDL, Unicode insert and query', t.ok && Number(t.data.results.at(-1).rows[0][0]) === 2 && Number(t.data.results.at(-1).rows[0][1]) === 15.5, t.ok ? JSON.stringify(t.data.results.at(-1).rows[0]) : t.error);
      const sch = await ipc('schema', saved.data.id, db, true);
      check('Windows auth: schema introspection', sch.ok && sch.data.tables.some((x) => x.name === 't' && x.columns.length === 3), sch.ok ? `${sch.data.tables.length} tables` : sch.error);
      const filtered = await ipc('rows', saved.data.id, db, { table: { schema: 'dbo', name: 't' }, offset: 0, limit: 10, filters: [{ column: 'name', op: 'eq', value: 'Nikos' }] });
      check('Windows auth: parameterised read (filters)', filtered.ok && filtered.data.rows.length === 1, filtered.ok ? `${filtered.data.rows.length} row(s)` : filtered.error);
      const created = await ipc('createDatabase', saved.data.id, 'smoke_created', { collation: 'Greek_CI_AS' });
      check('New database on SQL Server (Greek collation)', created.ok && created.data.databases.includes('smoke_created'), created.ok ? '' : created.error);
      const bak = path.join(os.tmpdir(), `smoke-${Date.now()}.bak`);
      const bk = await ipc('query', saved.data.id, 'master', `BACKUP DATABASE ${db} TO DISK = N'${bak.replace(/'/g, "''")}' WITH INIT`, { confirmed: true });
      const info = bk.ok ? await ipc('inspectBakOnServer', saved.data.id, bak) : bk;
      const restored = info.ok ? await ipc('restoreBak', info.data.token, 'smoke_restored') : info;
      const n = restored.ok ? await ipc('query', saved.data.id, 'smoke_restored', 'SELECT COUNT(*) FROM t') : restored;
      check('.bak restored as a new database (Windows paths)', n.ok && Number(n.data.results[0].rows[0][0]) === 2, n.ok ? '' : n.error);
      await ipc('disconnect', saved.data.id);
    }
  }

  const ls = await ipc('checkLocalServer');
  check('local server check runs', ls.ok && ls.data.steps.length > 0 && !ls.data.busy, ls.ok ? ls.data.steps.map((x) => `${x.id}=${x.status}`).join(' ') : ls.error);

  // The setup form shows the platform's own settings (Windows: instance, authentication, TCP).
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Local SQL Server')?.click()`);
  for (let i = 0; i < 40 && !(await evaluate(`!!document.querySelector('[data-testid=ls-settings]')`)); i++) await sleep(250);
  const formIds = await evaluate(`[...document.querySelectorAll('[data-testid^=ls-]')].map((e) => e.dataset.testid).join(' ')`);
  const expected = process.platform === 'win32' ? ['ls-name', 'ls-instance', 'ls-mixed', 'ls-collation', 'ls-db-name'] : ['ls-name', 'ls-port', 'ls-own-pw', 'ls-collation', 'ls-db-name'];
  check('local server settings form', expected.every((id) => formIds?.split(' ').includes(id)), formIds);

  // Full SQL Server Express install with the user's choices (separate CI job: it takes several minutes).
  if (process.env.SMOKE_SQL_EXPRESS) {
    const pw = 'Smoke_Pass123!';
    // Start the install without waiting on it, and print every step change, so a hang shows where it stopped.
    await evaluate(`window.__inst = window.schemascope.invoke('installLocalServer', ${JSON.stringify({
      acceptLicenses: true,
      name: 'Express (smoke)',
      instance: 'SGTSMOKE',
      authMode: 'mixed',
      password: pw,
      serverCollation: 'Greek_CI_AS',
      tcp: true,
      port: 14333,
      database: { name: 'Πελάτες' },
    })}).then((r) => (window.__instDone = r)); 0`);
    const fmt = (x) => x.steps.map((t) => `${t.id}=${t.status}${t.detail ? `(${t.detail})` : ''}`).join(' ');
    const started = Date.now();
    const history = [];
    // Last resort if even the timeouts above never return: report what is known and stop.
    const watchdog = setTimeout(() => {
      if (process.env.GITHUB_ACTIONS) console.log(`::error title=Express smoke watchdog::${history.slice(-8).join('%0A') || 'no state received'}`);
      process.exit(1);
    }, 75 * 60_000);
    let inst = null;
    while (!inst) {
      await sleep(20_000);
      const d = await evaluate('window.__instDone ?? null');
      if (d && String(d.error ?? '').startsWith('no answer')) history.push(`renderer: ${d.error}`);
      else inst = d;
      const live = await ipc('localServerState');
      const line = live.ok ? fmt(live.data).replace(/ \d+ MB/g, ' n MB') : live.error;
      if (line !== history.at(-1)) {
        history.push(line);
        console.log(`[${Math.round((Date.now() - started) / 60_000)} min] ${live.ok ? fmt(live.data) : live.error}`);
        if (process.env.GITHUB_ACTIONS && history.length <= 9) console.log(`::notice title=Express ${Math.round((Date.now() - started) / 60_000)} min::${line}`);
      }
      if (!inst && Date.now() - started > 70 * 60_000) {
        if (process.env.GITHUB_ACTIONS) console.log(`::error title=Express install timed out::${history.slice(-8).join('%0A')}`);
        throw new Error(`Express install did not finish in 70 minutes; last: ${history.at(-1)}`);
      }
    }
    clearTimeout(watchdog);
    const st = inst.ok ? inst.data : null;
    check('Express: installed and ready', !!st?.ready, st ? `${st.error ?? ''} ${fmt(st)}` : inst.error);
    if (st?.ready) {
      const q = await ipc('query', st.connId, 'master', "SELECT CAST(SERVERPROPERTY('Collation') AS nvarchar(100)), CAST(SERVERPROPERTY('IsIntegratedSecurityOnly') AS int), CAST(DATABASEPROPERTYEX(N'Πελάτες', 'Collation') AS nvarchar(100)), SUSER_SNAME(), IS_SRVROLEMEMBER('sysadmin')");
      const r = q.ok ? q.data.results[0].rows[0] : [];
      check('Express: server collation Greek_CI_AS', r[0] === 'Greek_CI_AS', q.ok ? JSON.stringify(r) : q.error);
      check('Express: mixed authentication on', Number(r[1]) === 0, String(r[1]));
      check('Express: first database created with the server collation', r[2] === 'Greek_CI_AS', String(r[2]));
      check('Express: Windows user is sysadmin', Number(r[4]) === 1, String(r[3]));
      // Diagnostics for the two checks above and below, shown in the annotation when they fail.
      const diag = await ipc('query', st.connId, 'master', "SELECT (SELECT STRING_AGG(name + N':' + CAST(UNICODE(name) AS nvarchar(10)), N',') FROM sys.databases WHERE database_id > 4), DB_ID(N'Πελάτες'), UNICODE(N'Π'), (SELECT STRING_AGG(value_name + N'=' + CAST(value_data AS nvarchar(50)), N',') FROM sys.dm_server_registry WHERE value_name IN (N'TcpPort', N'TcpDynamicPorts', N'Enabled') AND registry_key LIKE N'%Tcp%'), (SELECT TOP 1 net_transport + N' ' + encrypt_option FROM sys.dm_exec_connections WHERE session_id = @@SPID)");
      const tcpOpen = await new Promise((r) => {
        const sock = net.connect(14333, '127.0.0.1');
        const done = (v) => (sock.destroy(), r(v));
        sock.once('connect', () => done('open')).once('error', (e) => done(e.code)).setTimeout(10_000, () => done('timeout'));
      });
      console.log('diag', JSON.stringify(diag.ok ? diag.data.results[0].rows[0] : diag.error), 'tcp', tcpOpen);
      if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Express diagnostics::${JSON.stringify(diag.ok ? diag.data.results[0].rows[0] : diag.error)} tcp 14333: ${tcpOpen}`);
      const sa = await ipc('testConnection', { name: 'sa', kind: 'mssql', host: '127.0.0.1', port: 14333, user: 'sa', password: pw, trustServerCertificate: true });
      check('Express: sa signs in over TCP on the chosen port', sa.ok, sa.ok ? sa.data.version : sa.error);
      const conns = await ipc('listConnections');
      check('Express: connection named as chosen', conns.ok && conns.data.some((c) => c.name === 'Express (smoke)' && c.instance === 'SGTSMOKE'));
      const leftovers = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('sql-graphic-tool-express-') || n.startsWith('sql-graphic-tool-ps-'));
      check('Express: temporary setup files removed', leftovers.length === 0, leftovers.join(', '));
    }
  }

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
// On GitHub Actions also leave an annotation, so the result is visible on the run page without opening the log.
if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Smoke test (${process.platform})::${results.length - failed}/${results.length} passed%0A${names.join('%0A')}`);
process.exit(failed ? 1 : 0);
