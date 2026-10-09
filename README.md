# SchemaScope

Visual database manager for **SQLite, SQL Server / Express, PostgreSQL and MySQL / MariaDB**, built as a cross-platform
desktop app (macOS & Windows) with Electron.

- **Visual Schema Inspector (ERD)**: tables are draggable nodes showing 🔑 primary keys and 🔗 foreign keys. Relationships are animated, glowing lines. Hover a table to light up its relations, click one to open a live **data drawer**, focus on a table's neighbourhood, export to PNG, and **drag a column onto another table to create a foreign key**.
- **Visual schema design** (diagram → **Edit**): drag *New table* onto the canvas and column templates (ID, name, email, price, created at, reference…) onto tables; rename, retype, drop and restore in place. Changes stay pending (dashed, glowing) with undo/redo and a SQL preview until **Apply**, which runs them one statement at a time — applied tables flash green, a failing one shakes and shows the database's error.
- **Problems on the diagram**: tables without a primary key, unindexed foreign keys, type mismatches across relationships, duplicate indexes, and draft mistakes (duplicate names, NOT NULL without default on a table with rows, dropping something still referenced, engine limits). Errors pulse red, relationships with problems glow, and many issues have a one-click **Fix**.
- **Management**: object explorer, SQL editor (autocomplete, ⌘/Ctrl+Enter, format, history, CSV/JSON export), **graphical execution plans** (estimated and actual), data grid with inline editing (transactional save), table designer, columns/indexes/foreign keys, DDL scripts, rename/empty/drop.
- **DBA tools**: activity monitor (running queries, blocking, cancel/kill), users/roles/permissions, CSV import, *Generate scripts* (schema + data, replayable), backup & restore (SQLite file, SQL Server `BACKUP`, `pg_dump`/`mysqldump` when installed).
- **Compare & generate**: schema compare with migration script (also across engines), data compare with sync SQL, test-data generator, documentation (HTML, or Markdown with a Mermaid ER diagram).
- **Integrations**: local REST API with API keys, saved queries published as endpoints, OpenAPI, and an **MCP server** so AI assistants can explore the schema and query safely.
- **Safety**: OS-keychain encrypted passwords, production/staging labels, read-only connections enforced in the database session where supported, confirmation before destructive statements on production, SSH tunnels.

## Run

```bash
npm install          # also rebuilds better-sqlite3 for Electron
npm run dev          # Vite + Electron with hot reload
npm run dist:mac     # → release/*.dmg
npm run dist:win     # → release/*.exe (build on Windows, or a macOS machine with Wine)
```

On first launch a demo SQLite database (an e-shop with 17 tables) is created in the app's data folder.

```bash
npm run dist:dir     # unpacked app in release/
npm run smoke        # launches the packaged app with a throw-away data folder and checks UI, IPC, SQLite and the API
```

### Windows & macOS builds (CI)

`better-sqlite3` is a native module and cannot be cross-compiled, so each platform is built on its own OS.
`.github/workflows/ci.yml` does this on `windows-latest` and `macos-latest` for every push: install, typecheck,
build, package, **smoke test the packaged app**, then upload the installers (NSIS `.exe`, `.dmg`/`.zip`) as
artifacts. Actions are pinned to commit SHAs. Builds are unsigned; add signing certificates as repository secrets
when you are ready to distribute.

### Large schemas

Above 60 tables the diagram lays out each group of related tables separately, reshapes long ranks into a
screen-shaped block and packs the groups. Above 80 tables only what is on screen is rendered; when many tables are
visible the heavier glass effects are dropped, and below 40 % zoom tables are drawn as simple blocks (name, column
count, problems) — zoom in for full detail.

## Structure

```
electron/
  main.ts          Main process: window, single IPC handler, native dialogs
  preload.ts       contextBridge: exposes only `window.schemascope.invoke()`
core/              Database layer (runs in the main process, no Electron imports)
  api.ts           Implements the IPC contract
  httpApi.ts       Local REST API server (127.0.0.1)
  mcp.ts           MCP tools over HTTP
  endpoints.ts     Saved query endpoints · sqlParams.ts :name parameters
  integrations.ts  Server settings, hashed API keys, endpoints
  transfer.ts      Bulk insert, CSV import, Generate scripts · csv.ts parser
  backup.ts        Backup/restore (SQLite, pg_dump, mysqldump)
  tunnel.ts        SSH tunnels
  pool.ts          One live driver per connection + database
  store.ts         Saved connections (userData/connections.json)
  drivers/
    base.ts        Driver interface + shared paging/editing logic
    sqlite.ts      better-sqlite3 (WAL)
    postgres.ts    pg
    mysql.ts       mysql2
    mssql.ts       mssql/tedious (SQL Server & Express)
shared/
  ipc.ts           The typed contract between UI and main process
  types.ts         Schema / result types
  dialect.ts       Quoting and DDL generation per database
src/               React renderer (no Node.js access)
  components/diagram/   SchemaVisualizer, TableNode, RelationEdge, DataDrawer, layout
  components/tabs/      Query, Table, Diagram, Overview, Integrations
  components/dba/       Activity, Security, Plan view, Compare, Data compare, dialogs
  components/diagram/   …, DesignPalette, ChangesPanel, ProblemsPanel, designContext
  lib/                  plan.ts, schemaDiff.ts, mock.ts, docs.ts, designer.ts (draft → SQL), lint.ts (problems) — pure, testable
scripts/           esbuild, dev runner, smoke test (cross-platform Node scripts)
.github/workflows/ CI: native builds + smoke test on Windows and macOS
```

## Extending

- **New database**: add `core/drivers/<name>.ts` extending `Driver`, register it in `core/pool.ts`, and add the kind to `DbKind`
  (plus quoting/DDL cases in `shared/dialect.ts`).
- **New backend feature**: add a method to `Api` in `shared/ipc.ts` and implement it in `core/api.ts`. The renderer gets a
  typed `api.<method>()` automatically.

## Integrations (REST API, endpoints, MCP)

Open **Integrations** (plug icon in the sidebar header), enable the server and create an API key.

```bash
# rows with filters: eq, neq, gt, gte, lt, lte, like, ilike, in.(a,b), is.null|notnull
curl -H "Authorization: Bearer $KEY" \
  "http://127.0.0.1:4870/v1/connections/<id>/databases/<db>/tables/orders/rows?status=eq.paid&order=id.desc&limit=50"

# a saved query published from a query tab (parameters are :name in the SQL)
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:4870/v1/endpoints/top-customers?status=delivered"

# Claude Code
claude mcp add --transport http schemascope http://127.0.0.1:4870/mcp --header "Authorization: Bearer $KEY"
```

The OpenAPI description is at `/v1/openapi.json`.

## Security

- `contextIsolation`, `sandbox`, no `nodeIntegration`; IPC answers only the app's own page. File paths for imports, exports and backups come from native dialogs in the main process, never from the renderer.
- Passwords (database and SSH) are encrypted with the OS keychain (Electron `safeStorage`: Keychain on macOS, DPAPI on Windows) and never sent to the renderer. On Linux without a keyring they are stored in `connections.json` with file mode 600.
- Every structural change shows the exact SQL for review before it runs. Production connections ask again before `DELETE`/`UPDATE` without `WHERE`, `DROP` and `TRUNCATE`; read-only connections are enforced by the database session on PostgreSQL, MySQL and SQLite, and by statement checks on SQL Server.
- Local API: off by default, binds to 127.0.0.1 only, checks the `Host` header (DNS rebinding) and rejects browser requests (`Origin`); keys are stored as SHA-256 hashes and shown once; per-key connection scope and read/write access; rate limit per key; 1 MB body limit; parameterised SQL only (column names are checked against the schema); no stack traces in responses; the request log stores paths without query strings.
- MCP tools follow the key's rules; destructive statements on production connections are always refused there.
- Production builds ship without source maps.
