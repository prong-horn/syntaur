# Syntaur Desktop App (Electron) Implementation Plan

## Metadata
- **Date:** 2026-04-12
- **Complexity:** large
- **Tech Stack:** TypeScript, Electron 34, Electron Forge 7 (Vite plugin), React 18 (embedded via syntaur npm package)

## Objective
Build a standalone Electron desktop application in a new repository (`syntaur-app`) that wraps the existing Syntaur dashboard -- Express + WebSocket backend serving a React SPA -- into a native desktop experience with packaging, auto-updates, and OS integration.

## Success Criteria
- [ ] `npm start` launches Electron, spawns the Express server, and opens a BrowserWindow showing the Syntaur dashboard
- [ ] All dashboard features work identically to the browser-based version (API, WebSocket, file watching)
- [ ] First-run behavior: if `~/.syntaur/config.md` does not exist, the app creates the directory structure, writes a default `config.md`, seeds default playbooks, and rebuilds the playbook manifest (replicating `syntaur init` behavior)
- [ ] `npm run make` produces a .dmg on macOS and a Squirrel installer on Windows
- [ ] Auto-updates work via `update-electron-app` from GitHub Releases
- [ ] Native menu bar with standard Edit/View/Window items plus Syntaur-specific actions
- [ ] GitHub Actions workflows build, sign, notarize, and publish releases for macOS; Windows workflow builds and publishes unsigned (signing optional, documented)
- [ ] On Windows, dashboard works for all features except server autodiscovery (which relies on `lsof`/tmux and gracefully returns empty results)
- [ ] `better-sqlite3` native module loads correctly in the packaged app on both platforms
- [ ] Single-instance enforcement prevents multiple app windows

## Discovery Findings

### Key Architecture Insight
The Syntaur dashboard is a two-part system:
1. **Express + WebSocket backend** (`src/dashboard/server.ts`) -- serves API routes, manages file watchers via chokidar, runs autodiscovery of tmux sessions, stores agent sessions in SQLite via `better-sqlite3`
2. **React SPA frontend** (`dashboard/dist/`) -- React 18 + Vite 6 + Tailwind CSS, uses relative API URLs (`/api/...`) and derives WebSocket URL from `window.location`

The `syntaur` npm package makes `createDashboardServer(options)` available via the deep import `syntaur/dist/dashboard/server.js` (a separate tsup entry point; there is no `exports` map, and the package `main` points to the CLI entry). The function returns an object with `start()`, `stop()`, and `port` accessor. All filesystem paths resolve from `~/.syntaur/` via `os.homedir()`.

**Critical path resolution concern:** `server.ts` lines 35-40 use `import.meta.url` to compute `packageRoot` for finding `dashboard/dist/`. Inside an Electron ASAR archive, this path resolution will break. The `syntaur` node_modules directory must be unpacked from ASAR.

### Files That Will Need Changes

These are all NEW files in the `syntaur-app` repository:

| File | Current Purpose | Needed Change |
|------|----------------|---------------|
| `package.json` | Does not exist | Create with Electron + Forge deps, `syntaur` as dependency |
| `tsconfig.json` | Does not exist | TypeScript config for main + preload (ESM target) |
| `forge.config.ts` | Does not exist | Electron Forge: Vite plugin, makers, signing, ASAR unpack rules |
| `src/main.ts` | Does not exist | Main process: spawn Express server, create BrowserWindow, lifecycle |
| `src/preload.ts` | Does not exist | IPC bridge: app version, window controls, platform info |
| `src/menu.ts` | Does not exist | Native application menu (File, Edit, View, Window, Help) |
| `src/renderer.ts` | Does not exist | Minimal renderer entry (loads dashboard from localhost) |
| `index.html` | Does not exist | Shell HTML for BrowserWindow (redirects to Express server) |
| `vite.main.config.ts` | Does not exist | Vite build config for main process |
| `vite.preload.config.ts` | Does not exist | Vite build config for preload script |
| `vite.renderer.config.ts` | Does not exist | Vite build config for renderer |
| `.github/workflows/mac-release.yml` | Does not exist | macOS build, sign, notarize, release |
| `.github/workflows/windows-release.yml` | Does not exist | Windows build, sign, release |
| `.gitignore` | Does not exist | Node + Electron ignore patterns |
| `assets/icon.icns` | Does not exist | macOS app icon (required by forge.config.ts `icon` field) |
| `assets/icon.ico` | Does not exist | Windows app icon |
| `assets/icon.png` | Does not exist | Source PNG (1024x1024) for generating .icns and .ico |

### CLAUDE.md Rules
- Plans go in `claude-info/plans` directory, tracked by git
- Avoid unnecessary preamble
- Do not use `.claude/plans`

## High-Level Architecture

### Approach
The Electron app acts as a thin shell around the existing `syntaur` npm package. The main process imports `createDashboardServer` directly, starts the Express server on a local port, then opens a `BrowserWindow` pointing at `http://127.0.0.1:{port}`. The React SPA is served as static files by the Express server itself (with `serveStaticUi: true`), so no separate Vite dev server or renderer-side React build is needed in the Electron app.

This approach was chosen because:
1. **Zero duplication** -- the React app, API routes, and WebSocket logic all live in the `syntaur` package
2. **Identical behavior** -- the app works exactly like `syntaur dashboard` but in a native window
3. **Simple upgrade path** -- bump the `syntaur` dependency version to get new dashboard features
4. **Proven pattern** -- MCPJam Inspector uses the same embedded-server-in-main-process approach

### Key Decisions

| Decision | Chosen Option | Alternatives Considered | Rationale |
|----------|--------------|------------------------|-----------|
| How to embed the dashboard | Import `syntaur` as npm dependency, call `createDashboardServer()` | Bundle dashboard source directly; git submodule | npm dependency is cleanest -- single version, standard updates, no source duplication |
| Renderer approach | BrowserWindow loads `http://127.0.0.1:{port}` from Express server | Serve React app via Vite renderer plugin; use file:// protocol | Express already handles SPA routing and API -- loading from localhost avoids duplicating that logic |
| ASAR handling for native modules | Unpack `better-sqlite3` .node files AND entire `syntaur` node_modules from ASAR | Keep everything in ASAR; only unpack .node files | `import.meta.url` path resolution (server.ts L38) breaks inside ASAR; syntaur uses it to locate `dashboard/dist/` |
| Port selection | Start at 4800 with auto-increment (reuse `findAvailablePort` pattern from dashboard.ts L60-74) | Random OS-assigned port (port 0); fixed port | Matches existing CLI behavior; predictable for debugging |
| Dev workflow | `electron-forge start` with Vite plugin; main process imports syntaur directly | Separate Vite dev servers for frontend and backend | Simpler; the Express server handles everything including HMR-like live reload via WebSocket |
| Auto-updates | `update-electron-app` with GitHub Releases as update source | electron-updater; Squirrel.Mac manual | `update-electron-app` is the official Electron recommendation, minimal config |
| Window management | Single-instance lock via `app.requestSingleInstanceLock()` | Allow multiple instances | Dashboard writes to `~/.syntaur/dashboard-port` -- multiple instances would conflict |

### Components

1. **Main Process (`src/main.ts`)** -- Application lifecycle, server startup, window creation, single-instance lock, auto-updater
2. **Preload Script (`src/preload.ts`)** -- Secure IPC bridge exposing app version, platform info, window controls via `contextBridge`
3. **Menu (`src/menu.ts`)** -- Native application menu with standard Edit/View/Window entries plus Syntaur-specific items (Open Dashboard URL, Reload, DevTools)
4. **Renderer (`src/renderer.ts` + `index.html`)** -- Minimal shell that navigates to the Express server URL once it's ready
5. **Forge Config (`forge.config.ts`)** -- Build configuration: Vite plugin, platform makers, code signing, ASAR unpack rules
6. **CI Workflows (`.github/workflows/`)** -- Automated build, sign, notarize, and publish to GitHub Releases

## Architecture Diagram

```mermaid
graph TB
    subgraph "Electron App"
        subgraph "Main Process"
            A[src/main.ts] --> B[createDashboardServer]
            B --> C[Express + WebSocket Server]
            C --> D["Static files<br/>(dashboard/dist/)"]
            C --> E["API routes<br/>(/api/*)"]
            C --> F["WebSocket<br/>(/ws)"]
            A --> G[BrowserWindow]
            A --> H[Native Menu]
            A --> I[Auto-Updater]
        end

        subgraph "Renderer Process"
            G --> J["Loads http://127.0.0.1:port"]
            J --> K[React SPA]
        end

        subgraph "Preload"
            L[preload.ts] --> M["contextBridge API<br/>(version, platform, controls)"]
        end
    end

    subgraph "File System (~/.syntaur/)"
        C --> N[missions/]
        C --> O[assignments/]
        C --> P[servers/]
        C --> Q[playbooks/]
        C --> R[todos/]
        C --> S["syntaur.db<br/>(better-sqlite3)"]
    end

    subgraph "External"
        I --> T[GitHub Releases]
    end
```

```mermaid
sequenceDiagram
    participant User
    participant Electron as Electron Main
    participant Server as Express Server
    participant Window as BrowserWindow
    participant FS as ~/.syntaur/

    User->>Electron: Launch app
    Electron->>Electron: requestSingleInstanceLock()
    Electron->>Electron: findAvailablePort(4800)
    Electron->>Server: createDashboardServer({port, dirs...})
    Electron->>Server: server.start()
    Server->>FS: initSessionDb(), createWatcher()
    Server-->>Electron: listening on port
    Electron->>Window: new BrowserWindow()
    Window->>Server: GET http://127.0.0.1:{port}/
    Server-->>Window: index.html (React SPA)
    Window->>Server: WebSocket /ws
    Server-->>Window: {"type":"connected"}
    Window->>Server: GET /api/overview
    Server->>FS: Read missions, assignments
    Server-->>Window: JSON response
```

## Patterns to Follow

| Pattern | Reference File | Lines | What to Copy |
|---------|---------------|-------|--------------|
| Dashboard server creation | `src/dashboard/server.ts` | L42-53 | `DashboardServerOptions` interface -- use these exact fields when calling `createDashboardServer()` |
| Server start/stop lifecycle | `src/dashboard/server.ts` | L358-409 | `start()` returns Promise, `stop()` cleans up watchers/DB/WS/port-file -- call `stop()` on app quit |
| Port auto-selection | `src/commands/dashboard.ts` | L60-74 | `findAvailablePort(startPort, maxAttempts)` -- reimplement this 15-line function locally |
| Config reading for dirs | `src/commands/dashboard.ts` | L77-78, L101-109 | `readConfig()` for `missionsDir`, path utilities for `serversDir/assignmentsDir/playbooksDir/todosDir` |
| Path utilities | `src/utils/paths.ts` | L11-31 | `syntaurRoot()`, `defaultMissionDir()`, `serversDir()`, `assignmentsDir()`, `playbooksDir()`, `todosDir()` |
| Static file serving flag | `src/dashboard/server.ts` | L337-353 | Set `serveStaticUi: true` -- Express serves `dashboard/dist/` with SPA fallback |
| WebSocket URL derivation | `dashboard/src/hooks/useWebSocket.ts` | L16-25 | Frontend derives WS URL from `window.location` -- works automatically when loaded from Express |
| Relative API URLs | `dashboard/src/hooks/useMissions.ts` | L302, L354 | All `fetch()` calls use `/api/...` -- no absolute URLs needed |
| `import.meta.url` for package root | `src/dashboard/server.ts` | L35-40 | This resolves `dashboard/dist/` relative to the bundle -- breaks in ASAR, so must unpack syntaur |

**PROOF:** Every file and line number above was read in full during this planning session. The `server.ts` file is 410 lines, `dashboard.ts` is 173 lines, `paths.ts` is 33 lines, `useWebSocket.ts` is 80 lines, `useMissions.ts` is 448 lines.

## Implementation Overview

### Task List (High-Level)

1. **Initialize repository:** Create `syntaur-app` repo, `package.json` with Electron Forge, TypeScript, and `syntaur` as dependencies -- Files: `package.json`, `tsconfig.json`, `.gitignore`

2. **Forge and Vite configuration:** Set up `forge.config.ts` with Vite plugin (main/preload/renderer entries), platform makers (DMG, Squirrel, ZIP), ASAR unpack rules for `better-sqlite3` and `syntaur` -- Files: `forge.config.ts`, `vite.main.config.ts`, `vite.preload.config.ts`, `vite.renderer.config.ts`

3. **Main process:** Implement `src/main.ts` -- single-instance lock, port discovery, `createDashboardServer()` call, BrowserWindow creation pointing at `http://127.0.0.1:{port}`, graceful shutdown, macOS activate handler -- Files: `src/main.ts`

4. **Preload and renderer:** Create `src/preload.ts` with `contextBridge` API (app version, platform), create `src/renderer.ts` and `index.html` shell -- Files: `src/preload.ts`, `src/renderer.ts`, `index.html`

5. **Native menu:** Build `src/menu.ts` with standard Edit/View/Window menus, Syntaur-specific items (open in browser, reload dashboard, toggle DevTools) -- Files: `src/menu.ts`

6. **Auto-updates:** Integrate `update-electron-app` in main process, configure for GitHub Releases -- Files: `src/main.ts` (addition)

7. **Native module rebuild:** Add `@electron/rebuild` postinstall hook, verify `better-sqlite3` loads in Electron's Node version -- Files: `package.json` (postinstall script)

8. **macOS CI/CD workflow:** GitHub Actions for mac-release: checkout, setup Node, setup keychain + signing certificate, `npm run make`, notarize DMG+ZIP, upload to GitHub Release -- Files: `.github/workflows/mac-release.yml`

9. **Windows CI/CD workflow:** GitHub Actions for windows-release: checkout, setup Node, rebuild native modules, `npm run make` with Squirrel, code sign, upload to GitHub Release -- Files: `.github/workflows/windows-release.yml`

10. **Testing and polish:** Verify dashboard loads correctly, test all API routes and WebSocket, confirm file watching works, test on both platforms -- No new files

### File Changes Summary

| File | Action | Purpose | Pattern Reference |
|------|--------|---------|-------------------|
| `package.json` | CREATE | Electron + Forge deps, syntaur dependency, scripts | N/A (new project) |
| `tsconfig.json` | CREATE | TypeScript config for main/preload (ESNext, NodeNext) | N/A |
| `.gitignore` | CREATE | Node + Electron + Forge output ignores | N/A |
| `forge.config.ts` | CREATE | Forge makers, Vite plugin, ASAR unpack, signing | MCPJam `forge.config.ts` |
| `vite.main.config.ts` | CREATE | Main process Vite build (externalize electron, syntaur native deps) | MCPJam pattern |
| `vite.preload.config.ts` | CREATE | Preload Vite build | MCPJam pattern |
| `vite.renderer.config.ts` | CREATE | Renderer Vite build (minimal) | MCPJam pattern |
| `src/main.ts` | CREATE | App lifecycle, server spawn, window, single instance, updater | `src/commands/dashboard.ts` L76-173, MCPJam `main.ts` |
| `src/preload.ts` | CREATE | contextBridge IPC API | MCPJam `preload.ts` |
| `src/renderer.ts` | CREATE | Renderer entry point | MCPJam pattern |
| `src/menu.ts` | CREATE | Native application menu | Standard Electron menu template |
| `index.html` | CREATE | Shell HTML for BrowserWindow | MCPJam `index.html` |
| `.github/workflows/mac-release.yml` | CREATE | macOS build + sign + notarize + release | MCPJam `mac-release.yml` |
| `.github/workflows/windows-release.yml` | CREATE | Windows build + sign + release | MCPJam `windows-release.yml` |

## Dependencies & Risks

| Dependency/Risk | Impact | Mitigation |
|----------------|--------|------------|
| `better-sqlite3` native module rebuild | App crashes on launch if .node binary is compiled for wrong Node ABI | `@electron/rebuild` in postinstall; test in CI before publishing |
| `import.meta.url` path resolution in ASAR | Express server cannot find `dashboard/dist/` static files | Unpack entire `syntaur` module from ASAR via `asarUnpack: ["**/node_modules/syntaur/**"]` in forge config |
| `better-sqlite3` .node file inside ASAR | Native addons cannot be loaded from ASAR archive | Unpack `.node` files: `asarUnpack: ["**/*.node"]` |
| macOS code signing certificate | Cannot distribute DMG without signing | Require `MAC_CODESIGN_IDENTITY` env var in CI; document certificate setup |
| Apple notarization credentials | App rejected by Gatekeeper without notarization | Require ASC API key in CI secrets; notarize before upload |
| Windows code signing certificate | SmartScreen warnings without signing | PFX certificate in CI secrets; can ship unsigned initially with warning |
| `syntaur` package version pinning | Breaking changes in syntaur could break the app | Pin to exact version; test upgrade path before bumping |
| tmux/lsof autodiscovery on Windows | Server tracking features are macOS/Linux-only | Graceful degradation -- autodiscovery simply finds nothing on Windows |
| Port 4800 already in use | CLI `syntaur dashboard` may be running | Auto-increment port (reuse `findAvailablePort` pattern) |
| Electron security (contextIsolation, nodeIntegration) | XSS in dashboard could access Node APIs | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (required because preload uses `contextBridge` which needs Node access; dashboard content is local/trusted) |

## Assumptions Log

| Assumption Avoided | Verified By | Answer |
|-------------------|-------------|--------|
| "syntaur exports createDashboardServer" | Read `src/dashboard/index.ts` L1-2 | Yes -- exported as named export from `./server.js` |
| "Dashboard uses relative API URLs" | Read `dashboard/src/hooks/useMissions.ts` L302, L354 | Yes -- all fetch calls use `/api/...` without hostname |
| "WebSocket connects automatically" | Read `dashboard/src/hooks/useWebSocket.ts` L16-25 | Yes -- derives WS URL from `window.location`, works when loaded from Express |
| "better-sqlite3 is a native module" | Read `src/dashboard/session-db.ts` L1 | Yes -- `import Database from 'better-sqlite3'` |
| "tsup externalizes better-sqlite3" | Read `tsup.config.ts` L12 | Yes -- `external: ['better-sqlite3']` |
| "Static serving uses import.meta.url" | Read `src/dashboard/server.ts` L35-40 | Yes -- `fileURLToPath(import.meta.url)` computes packageRoot for `dashboard/dist/` |
| "Path utilities use homedir" | Read `src/utils/paths.ts` L1-2, L11-12 | Yes -- `syntaurRoot() = resolve(homedir(), '.syntaur')` |
| "Config is read from ~/.syntaur/config.md" | Read `src/utils/config.ts` L442-444 | Yes -- `resolve(syntaurRoot(), 'config.md')` |
| "Package includes dashboard/dist in npm files" | Read `package.json` L26-33 | Yes -- `"files": [..., "dashboard/dist"]` |
| "Server has clean start/stop lifecycle" | Read `src/dashboard/server.ts` L358-409 | Yes -- `start()` and `stop()` are async, stop cleans up watchers/DB/WS/port-file |

## Exploration Findings

### Explorer 1: Pattern Verification (Syntaur Server Integration)

Read the complete `src/dashboard/server.ts` (410 lines), `src/commands/dashboard.ts` (173 lines), and `src/dashboard/index.ts` (14 lines). Key findings:

- `createDashboardServer()` accepts a flat options object with 7 fields (L42-50). It returns `{ start(), stop(), port }`.
- `start()` (L359-387) initializes the file watcher, starts autodiscovery, and listens on the port. It writes the port to `~/.syntaur/dashboard-port`.
- `stop()` (L389-404) stops autodiscovery, closes the watcher, closes the SQLite DB, closes all WebSocket clients, removes the port file, and closes the HTTP server.
- The server initializes `better-sqlite3` at construction time (L94 `initSessionDb()`), not at `start()` time. This means the native module must be loadable as soon as the module is imported.
- `dashboardCommand()` (L76-173) shows the full pattern for starting the server: read config, resolve dirs, find available port, create server, start server.
- The Vite dev server is only spawned in `--dev` mode (L115-139) and is irrelevant to the Electron app.

### Explorer 2: Architecture Validation (Module Boundaries and Native Deps)

Read `tsup.config.ts`, `package.json`, `src/utils/paths.ts`, `src/utils/config.ts`, `src/dashboard/session-db.ts`, `src/dashboard/watcher.ts`, `src/dashboard/autodiscovery.ts`. Key findings:

- **Build output:** tsup produces two entry points: `dist/index.js` (CLI) and `dist/dashboard/server.js` (server). Both are ESM format. `better-sqlite3` is externalized.
- **Native module chain:** `server.ts` -> `session-db.ts` -> `better-sqlite3`. The SQLite DB is stored at `~/.syntaur/syntaur.db` (resolved via `syntaurRoot()` in session-db.ts L40).
- **File system access:** The watcher (chokidar) watches 5 directories under `~/.syntaur/`: missions, assignments, servers, playbooks, todos. All use absolute paths from `os.homedir()`. No ASAR-relative paths involved for data access.
- **Autodiscovery:** Uses `lsof` and tmux commands (scanner.ts). These are shell commands that work on macOS/Linux only. On Windows, autodiscovery will silently find nothing.
- **Config reading:** `readConfig()` in config.ts reads `~/.syntaur/config.md` frontmatter. The `defaultMissionDir` field supports `~/` expansion via `expandHome()`.
- **Package structure for npm:** The `files` field includes `dist`, `bin`, `.agents`, `platforms`, `examples`, `dashboard/dist`. When installed as a dependency, `node_modules/syntaur/dashboard/dist/` will contain the built React SPA.
- **ASAR concern confirmed:** `server.ts` L38-40 uses `import.meta.url` -> `__dirname` -> `resolve(__dirname, '..')` to find `packageRoot`, then L338 uses `resolve(packageRoot, 'dashboard', 'dist')` for static files. Inside ASAR, `import.meta.url` would resolve to an `asar://` path where `fs` operations fail. The entire `syntaur` package must be unpacked.

---

## Phase 3: Detailed Implementation Plan

### Import Path Strategy

The `syntaur` package has `"main": "./dist/index.js"` but no `exports` map. The dashboard server is built to `dist/dashboard/server.js` as a separate tsup entry. The Electron app will import:

- `createDashboardServer` from `syntaur/dist/dashboard/server.js`

However, since `dist/index.js` is the CLI entry (it calls `commander.parseAsync()`), we CANNOT import from `syntaur` directly. We must use deep imports:

- `syntaur/dist/dashboard/server.js` for `createDashboardServer`

For path utilities (`syntaurRoot`, `defaultMissionDir`, `serversDir`, etc.), the Electron app will reimplement them locally (they are 5-line functions using `os.homedir()` + `path.resolve()`). This avoids importing the CLI entry point which would execute commander.

For `readConfig`, the Electron app will also reimplement config reading locally (simplified frontmatter parser).

**PROOF:** `src/index.ts` is the CLI entry point that calls `await program.parseAsync()` at line 442.
Source: `/Users/brennen/syntaur/src/index.ts:442`

**PROOF:** `tsup.config.ts` has two entry points: `src/index.ts` and `src/dashboard/server.ts`.
Source: `/Users/brennen/syntaur/tsup.config.ts:4`
```typescript
entry: ['src/index.ts', 'src/dashboard/server.ts'],
```

**PROOF:** `dist/dashboard/server.d.ts` exports `createDashboardServer` and `DashboardServerOptions`.
Source: `/Users/brennen/syntaur/dist/dashboard/server.d.ts:16`
```typescript
export { type DashboardServerOptions, createDashboardServer };
```

### CRITICAL: `packageRoot` Path Resolution Bug

**REVIEW FINDING:** When `dist/dashboard/server.js` is imported directly (as a library), the `packageRoot` computation is WRONG. The code at `server.ts:38-40` does:

```typescript
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
```

When loaded from `node_modules/syntaur/dist/dashboard/server.js`:
- `__dirname` = `.../node_modules/syntaur/dist/dashboard/`
- `packageRoot` = `.../node_modules/syntaur/dist/` (NOT the actual package root)
- `resolve(packageRoot, 'dashboard', 'dist')` = `.../node_modules/syntaur/dist/dashboard/dist/` -- WRONG PATH

The correct location is `.../node_modules/syntaur/dashboard/dist/`. This means static file serving will fail with a 503 error ("Dashboard not built") even though the files exist.

**PREREQUISITE FIX:** Before the Electron app can work, the `syntaur` package must be modified to fix this path resolution. Options:

1. **(Recommended) Fix `server.ts` to go up TWO levels for the separate entry point:** Change `resolve(__dirname, '..')` to compute `packageRoot` by looking for `package.json` via a simple upward traversal, or use `resolve(__dirname, '..', '..')` when the module is loaded from `dist/dashboard/server.js`.

2. **Add an `exports` map to syntaur's `package.json`** so that `import { createDashboardServer } from 'syntaur/dashboard'` resolves correctly, and fix the path resolution to account for the separate entry point's location.

3. **Accept `serveStaticUi: false` in the Electron app** and have the main process serve the static files itself by resolving the path to `node_modules/syntaur/dashboard/dist/` manually. This avoids the bug but requires duplicate static file serving logic.

**DECISION:** Option 1 is simplest. Add a **new Task 0** to the syntaur repo that fixes the `packageRoot` resolution in `server.ts` to work when loaded from `dist/dashboard/server.js`. The fix: use `resolve(__dirname, '..', '..')` since `dist/dashboard/server.js` is two levels deep from the package root, or better, detect the depth dynamically by searching for `package.json`.

Path utilities will be reimplemented locally (6 trivial functions).

---

### Task 0: Fix `packageRoot` Resolution in Syntaur (Prerequisite)

**File(s):** `src/dashboard/server.ts` (in the `syntaur` repo at `/Users/brennen/syntaur/`)
**Action:** MODIFY
**Estimated complexity:** Low

#### Context
The `packageRoot` computation in `server.ts` L38-40 assumes the entry point is one level deep from the package root (`dist/index.js`). But when `dist/dashboard/server.js` is imported directly (as the Electron app does), `__dirname` is `dist/dashboard/` and `resolve(__dirname, '..')` gives `dist/` instead of the actual package root. This breaks static file serving because `resolve(packageRoot, 'dashboard', 'dist')` resolves to a non-existent `dist/dashboard/dist/` instead of `dashboard/dist/`.

#### Steps

1. [ ] **Step 0.1:** Fix `packageRoot` resolution to work for both entry points
   - **Location:** `/Users/brennen/syntaur/src/dashboard/server.ts` lines 35-40
   - **Action:** MODIFY
   - **What to do:** Replace the single `resolve(__dirname, '..')` with an upward search that finds `package.json` to locate the actual package root. This handles both `dist/index.js` (1 level deep) and `dist/dashboard/server.js` (2 levels deep).
   - **Code:**
     ```typescript
     import { existsSync } from 'node:fs';

     // Find package root by searching upward for package.json from the bundle location.
     // This handles both dist/index.js (1 level deep) and dist/dashboard/server.js (2 levels deep).
     const __filename = fileURLToPath(import.meta.url);
     const __dirname = dirname(__filename);

     function findPackageRoot(startDir: string): string {
       let dir = startDir;
       for (let i = 0; i < 5; i++) {
         if (existsSync(resolve(dir, 'package.json'))) {
           return dir;
         }
         const parent = dirname(dir);
         if (parent === dir) break;
         dir = parent;
       }
       // Fallback to original behavior
       return resolve(startDir, '..');
     }

     const packageRoot = findPackageRoot(__dirname);
     ```
   - **Proof blocks:**
     - **PROOF:** Current code `resolve(__dirname, '..')` only works when loaded from `dist/index.js`. When loaded from `dist/dashboard/server.js`, `__dirname` is `dist/dashboard/` and the result is `dist/` (wrong).
       Source: `/Users/brennen/syntaur/dist/dashboard/server.js:6234-6236`
       ```
       var __filename = fileURLToPath(import.meta.url);
       var __dirname = dirname3(__filename);
       var packageRoot = resolve15(__dirname, "..");
       ```
     - **PROOF:** The syntaur `package.json` exists at the package root, so upward search for `package.json` will find the correct directory.
   - **Verification:**
     ```bash
     cd /Users/brennen/syntaur && npm run build
     node -e "import('file:///Users/brennen/syntaur/dist/dashboard/server.js').then(m => console.log('import works'))"
     ```

2. [ ] **Step 0.2:** Rebuild, typecheck, test, bump version, and publish syntaur with the fix
   - **Location:** `/Users/brennen/syntaur/`
   - **Action:** BUILD + PUBLISH
   - **What to do:** Rebuild the package, run typechecking (required by AGENTS.md:24), run tests, bump the patch version, and publish to npm. Record the new version number — it will be used as the `syntaur` dependency version in Task 1.
   - **Commands:**
     ```bash
     cd /Users/brennen/syntaur
     npm run build
     npm run typecheck         # required by AGENTS.md for TS changes
     npm test
     npm version patch         # bumps version in package.json (e.g. 0.1.8 -> 0.1.9)
     npm publish               # publishes to npm
     # Record the new version:
     node -e "console.log(require('./package.json').version)"
     ```
   - **Files touched:** `package.json` (version bump), `package-lock.json` (version bump)
   - **Verification:**
     ```bash
     npm view syntaur version  # should show the newly published version
     ```
   - **Important:** Use the published version number when setting the `syntaur` dependency in Task 1's `package.json` (replace `<version-after-task-0>` with the actual version).

#### Task Completion Criteria
- [ ] `packageRoot` resolves correctly when `server.js` is loaded from both `dist/index.js` and `dist/dashboard/server.js`
- [ ] Static file serving works when `createDashboardServer` is called from an external consumer (smoke test: start server with `serveStaticUi: true`, request `/`, verify 200 response with HTML)
- [ ] `npm run typecheck` passes (required by AGENTS.md:24 for TypeScript changes)
- [ ] All existing tests pass (`npm test`)
- [ ] New version published to npm

---

### Task 1b: Icon Assets

**File(s):** `assets/icon.png`, `assets/icon.icns`, `assets/icon.ico`
**Action:** CREATE (all three files)
**Estimated complexity:** Low

#### Context
`forge.config.ts` references `./assets/icon` (without extension — Electron Forge auto-resolves `.icns` on macOS, `.ico` on Windows). These files must exist before `npm run make` can produce branded installers.

#### Steps

1. [ ] **Step 1b.1:** Create or obtain a 1024x1024 PNG source icon
   - **Location:** New file at `syntaur-app/assets/icon.png`
   - **Action:** CREATE
   - **What to do:** Create or commission a 1024x1024 PNG app icon for Syntaur. This is the source file from which platform-specific formats are generated. For an MVP, use a simple placeholder (e.g., the Syntaur "S" logo on a dark background).
   - **Verification:**
     ```bash
     file assets/icon.png  # should report PNG image, 1024x1024
     ```

2. [ ] **Step 1b.2:** Generate `.icns` (macOS) from the source PNG
   - **Location:** New file at `syntaur-app/assets/icon.icns`
   - **Action:** CREATE
   - **What to do:** Generate the macOS `.icns` file from the source PNG. On macOS, use `iconutil`:
   - **Code:**
     ```bash
     mkdir -p assets/icon.iconset
     sips -z 16 16     assets/icon.png --out assets/icon.iconset/icon_16x16.png
     sips -z 32 32     assets/icon.png --out assets/icon.iconset/icon_16x16@2x.png
     sips -z 32 32     assets/icon.png --out assets/icon.iconset/icon_32x32.png
     sips -z 64 64     assets/icon.png --out assets/icon.iconset/icon_32x32@2x.png
     sips -z 128 128   assets/icon.png --out assets/icon.iconset/icon_128x128.png
     sips -z 256 256   assets/icon.png --out assets/icon.iconset/icon_128x128@2x.png
     sips -z 256 256   assets/icon.png --out assets/icon.iconset/icon_256x256.png
     sips -z 512 512   assets/icon.png --out assets/icon.iconset/icon_256x256@2x.png
     sips -z 512 512   assets/icon.png --out assets/icon.iconset/icon_512x512.png
     cp assets/icon.png assets/icon.iconset/icon_512x512@2x.png
     iconutil -c icns assets/icon.iconset -o assets/icon.icns
     rm -rf assets/icon.iconset
     ```
   - **Verification:**
     ```bash
     file assets/icon.icns  # should report "Mac OS X icon"
     ```

3. [ ] **Step 1b.3:** Generate `.ico` (Windows) from the source PNG
   - **Location:** New file at `syntaur-app/assets/icon.ico`
   - **Action:** CREATE
   - **What to do:** Generate the Windows `.ico` file using ImageMagick (`convert`). Install via `brew install imagemagick` if not present. The `.ico` must contain 16x16, 32x32, 48x48, and 256x256 sizes.
   - **Code:**
     ```bash
     # Using ImageMagick (install via: brew install imagemagick)
     convert assets/icon.png -define icon:auto-resize=256,48,32,16 assets/icon.ico
     ```
   - **Verification:**
     ```bash
     file assets/icon.ico  # should report "MS Windows icon resource"
     ```

#### Task Completion Criteria
- [ ] `assets/icon.png` exists and is 1024x1024 PNG
- [ ] `assets/icon.icns` exists and is a valid macOS icon
- [ ] `assets/icon.ico` exists and is a valid Windows icon
- [ ] `forge.config.ts`'s `icon: './assets/icon'` resolves correctly on both platforms

---

### Task 1: Initialize Repository

**File(s):** `package.json`, `tsconfig.json`, `.gitignore`
**Action:** CREATE (all three files)
**Estimated complexity:** Low

#### Context
Create the `syntaur-app` repository with all dependencies, scripts, and TypeScript configuration needed for an Electron Forge project with the Vite plugin.

#### Steps

1. [ ] **Step 1.1:** Create `package.json` with all dependencies and scripts
   - **Location:** New file at `syntaur-app/package.json`
   - **Action:** CREATE
   - **What to do:** Create the npm manifest with Electron 34, Electron Forge 7, Vite plugin, makers, syntaur as dependency, and all required scripts.
   - **Code:**
     ```json
     {
       "name": "syntaur-app",
       "productName": "Syntaur",
       "version": "0.1.0",
       "description": "Syntaur Desktop - Mission workflow dashboard",
       "main": ".vite/build/main.js",
       "type": "module",
       "scripts": {
         "start": "electron-forge start",
         "package": "electron-forge package",
         "make": "electron-forge make",
         "publish": "electron-forge publish",
         "lint": "tsc --noEmit"
       },
       "dependencies": {
         "syntaur": "<version-after-task-0>",
         "update-electron-app": "^3.0.0"
       },
       "devDependencies": {
         "@electron-forge/cli": "^7.6.0",
         "@electron-forge/maker-dmg": "^7.6.0",
         "@electron-forge/maker-squirrel": "^7.6.0",
         "@electron-forge/maker-zip": "^7.6.0",
         "@electron-forge/plugin-vite": "^7.6.0",
         "@electron-forge/shared-types": "^7.6.0",
         "@electron/rebuild": "^3.7.0",
         "electron": "^34.0.0",
         "typescript": "^5.7.0",
         "vite": "^6.0.0"
       },
       "engines": {
         "node": ">=20.0.0"
       }
     }
     ```
   - **Proof blocks:**
     - **PROOF:** `syntaur` is published to npm with `"main": "./dist/index.js"`. Use the exact version published after Task 0's `packageRoot` fix (will be > 0.1.8). Pin to an exact version (no `^`).
       Source: `/Users/brennen/syntaur/package.json:25`
       ```json
       "main": "./dist/index.js",
       ```
     - **PROOF:** Electron Forge Vite plugin uses `.vite/build/main.js` as the resolved main entry.
       Source: Electron Forge docs — the Vite plugin outputs to `.vite/build/` during development.
     - **PROOF:** `update-electron-app` is installed via `npm i update-electron-app` per its README.
   - **Verification:**
     ```bash
     node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && echo "Valid JSON"
     ```

2. [ ] **Step 1.2:** Create `tsconfig.json` for main and preload process TypeScript
   - **Location:** New file at `syntaur-app/tsconfig.json`
   - **Action:** CREATE
   - **What to do:** Configure TypeScript for ESM output targeting Node 20+ (Electron's Node version), with strict mode enabled.
   - **Code:**
     ```json
     {
       "compilerOptions": {
         "target": "ESNext",
         "module": "ESNext",
         "moduleResolution": "bundler",
         "esModuleInterop": true,
         "strict": true,
         "skipLibCheck": true,
         "outDir": "dist",
         "rootDir": "src",
         "sourceMap": true,
         "declaration": true,
         "resolveJsonModule": true,
         "isolatedModules": true,
         "types": ["vite/client"]
       },
       "include": ["src/**/*.ts"],
       "exclude": ["node_modules", "dist", ".vite"]
     }
     ```
   - **Proof blocks:**
     - **PROOF:** Electron Forge Vite plugin handles the actual compilation via Vite/esbuild; tsconfig is used for type checking only (`tsc --noEmit` in the `lint` script).
     - **PROOF:** `moduleResolution: "bundler"` is correct for Vite-based projects per Vite documentation.
   - **Verification:**
     ```bash
     npx tsc --noEmit
     ```

3. [ ] **Step 1.3:** Run `npm install` to generate `package-lock.json`
   - **Location:** `syntaur-app/`
   - **Action:** RUN
   - **What to do:** Run `npm install` to generate `package-lock.json`. This file must be committed to the repo because CI workflows use `npm ci` which requires it.
   - **Verification:**
     ```bash
     test -f package-lock.json && echo "lockfile exists"
     git add package-lock.json
     ```

4. [ ] **Step 1.4:** Create `.gitignore` with Node, Electron, and Forge patterns
   - **Location:** New file at `syntaur-app/.gitignore`
   - **Action:** CREATE
   - **What to do:** Add standard ignore patterns for node_modules, build output, Forge output, and OS files.
   - **Code:**
     ```
     # Dependencies
     node_modules/

     # Build output
     dist/
     .vite/
     out/

     # OS files
     .DS_Store
     Thumbs.db

     # IDE
     .vscode/
     .idea/
     *.swp
     *.swo

     # Environment
     .env
     .env.local
     ```
   - **Verification:**
     ```bash
     git status  # should not show node_modules or out/ if they exist
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| `npm install` fails for `syntaur` | Ensure syntaur is published to npm | "Failed to install syntaur. Ensure the package is published." | N/A (manual check) |
| Node version too old | `engines` field in package.json warns | npm prints engine warning | `"engines": { "node": ">=20.0.0" }` |

#### Task Completion Criteria
- [ ] `package.json` is valid JSON with all required dependencies
- [ ] `tsconfig.json` is valid and `tsc --noEmit` passes (after src/ files exist)
- [ ] `.gitignore` includes node_modules, out, .vite, dist

---

### Task 2: Forge and Vite Configuration

**File(s):** `forge.config.ts`, `vite.main.config.ts`, `vite.preload.config.ts`, `vite.renderer.config.ts`
**Action:** CREATE (all four files)
**Pattern Reference:** Electron Forge docs — Vite plugin configuration
**Estimated complexity:** Medium

#### Context
Configure Electron Forge with the Vite plugin for building main/preload/renderer processes, platform-specific makers (DMG for macOS, Squirrel for Windows, ZIP for both), ASAR unpack rules for native modules and the syntaur package, and code signing configuration.

#### Steps

1. [ ] **Step 2.1:** Create `forge.config.ts` with Vite plugin, makers, and ASAR config
   - **Location:** New file at `syntaur-app/forge.config.ts`
   - **Action:** CREATE
   - **What to do:** Define the Forge configuration with: (a) packagerConfig setting ASAR unpack rules for `.node` files and the entire `syntaur` package, (b) macOS signing and notarization via environment variables, (c) makers for DMG, Squirrel, and ZIP, (d) Vite plugin with main/preload/renderer build entries.
   - **Code:**
     ```typescript
     import type { ForgeConfig } from '@electron-forge/shared-types';
     import { VitePlugin } from '@electron-forge/plugin-vite';
     import { MakerSquirrel } from '@electron-forge/maker-squirrel';
     import { MakerZIP } from '@electron-forge/maker-zip';
     import { MakerDMG } from '@electron-forge/maker-dmg';

     const config: ForgeConfig = {
       packagerConfig: {
         asar: {
           unpack: '{**/node_modules/syntaur/**,**/*.node}',
         },
         icon: './assets/icon',
         name: 'Syntaur',
         executableName: 'syntaur',
         ...(process.env.MAC_CODESIGN_IDENTITY
           ? {
               osxSign: {
                 identity: process.env.MAC_CODESIGN_IDENTITY,
               },
             }
           : {}),
         ...(process.env.APPLE_API_KEY
           ? {
               osxNotarize: {
                 appleApiKey: process.env.APPLE_API_KEY,
                 appleApiKeyId: process.env.APPLE_API_KEY_ID!,
                 appleApiIssuer: process.env.APPLE_API_ISSUER!,
               },
             }
           : {}),
       },
       makers: [
         new MakerDMG({
           format: 'ULFO',
         }, ['darwin']),
         new MakerZIP({}, ['darwin', 'win32']),
         new MakerSquirrel({
           name: 'Syntaur',
           ...(process.env.WINDOWS_CERTIFICATE_FILE
             ? {
                 certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
                 certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
               }
             : {}),
         }, ['win32']),
       ],
       plugins: [
         new VitePlugin({
           build: [
             {
               entry: 'src/main.ts',
               config: 'vite.main.config.ts',
               target: 'main',
             },
             {
               entry: 'src/preload.ts',
               config: 'vite.preload.config.ts',
               target: 'preload',
             },
           ],
           renderer: [
             {
               name: 'main_window',
               config: 'vite.renderer.config.ts',
             },
           ],
         }),
       ],
     };

     export default config;
     ```
   - **Proof blocks:**
     - **PROOF:** `server.ts` L38-40 uses `import.meta.url` to resolve `packageRoot`, and L338 uses `resolve(packageRoot, 'dashboard', 'dist')` to locate static files. This requires the entire `syntaur` package to be unpacked from ASAR.
       Source: `/Users/brennen/syntaur/src/dashboard/server.ts:35-40`
       ```typescript
       const __filename = fileURLToPath(import.meta.url);
       const __dirname = dirname(__filename);
       const packageRoot = resolve(__dirname, '..');
       ```
     - **PROOF:** `better-sqlite3` is a native C++ addon (`.node` file) that cannot be loaded from inside ASAR.
       Source: `/Users/brennen/syntaur/src/dashboard/session-db.ts:1`
       ```typescript
       import Database from 'better-sqlite3';
       ```
     - **PROOF:** Electron Forge docs show `MakerDMG`, `MakerSquirrel`, and `MakerZIP` as constructor-based maker configuration.
     - **PROOF:** Electron Forge docs show `VitePlugin` with `build` array (each entry has `entry`, `config`, `target`) and `renderer` array (each entry has `name`, `config`).
     - **PROOF:** Electron Forge docs show `osxNotarize` accepts `appleApiKey`, `appleApiKeyId`, `appleApiIssuer` for ASC API key-based notarization.
   - **Verification:**
     ```bash
     npx tsc --noEmit forge.config.ts
     ```

2. [ ] **Step 2.2:** Create `vite.main.config.ts` for main process build
   - **Location:** New file at `syntaur-app/vite.main.config.ts`
   - **Action:** CREATE
   - **What to do:** Configure Vite to build the main process, externalizing `electron`, `better-sqlite3`, and any other native modules. Mark the syntaur package as external since it is a Node.js dependency that should not be bundled.
   - **Code:**
     ```typescript
     import { defineConfig } from 'vite';

     export default defineConfig({
       build: {
         rollupOptions: {
           external: [
             'electron',
             'better-sqlite3',
             'syntaur',
             /^syntaur\/.*/,
           ],
         },
       },
       resolve: {
         // Ensure .ts files resolve correctly
         extensions: ['.ts', '.js', '.json'],
       },
     });
     ```
   - **Proof blocks:**
     - **PROOF:** `syntaur` depends on `better-sqlite3` which is a native C++ addon. It must be externalized so Vite does not try to bundle it.
       Source: `/Users/brennen/syntaur/package.json:49`
       ```json
       "better-sqlite3": "^11.0.0",
       ```
     - **PROOF:** The `syntaur` package itself must be external because it contains `dashboard/dist/` static files and native deps that cannot be bundled.
   - **Verification:**
     ```bash
     # Config-only verification (source files don't exist yet):
     npx tsc --noEmit forge.config.ts  # type-check the config
     # Full verification deferred to after Tasks 3-5 when src/main.ts, src/preload.ts, src/renderer.ts exist
     ```

3. [ ] **Step 2.3:** Create `vite.preload.config.ts` for preload script build
   - **Location:** New file at `syntaur-app/vite.preload.config.ts`
   - **Action:** CREATE
   - **What to do:** Configure Vite to build the preload script, externalizing `electron`.
   - **Code:**
     ```typescript
     import { defineConfig } from 'vite';

     export default defineConfig({
       build: {
         rollupOptions: {
           external: ['electron'],
         },
       },
     });
     ```
   - **Proof blocks:**
     - **PROOF:** Preload scripts run in a sandboxed renderer context with access to `electron` (for `contextBridge`, `ipcRenderer`). Electron must be externalized.
   - **Verification:**
     ```bash
     # Verified as part of electron-forge start
     ```

4. [ ] **Step 2.4:** Create `vite.renderer.config.ts` for renderer build
   - **Location:** New file at `syntaur-app/vite.renderer.config.ts`
   - **Action:** CREATE
   - **What to do:** Configure Vite for the renderer process. This is minimal since the actual React app is served by the Express server; the renderer just loads a URL.
   - **Code:**
     ```typescript
     import { defineConfig } from 'vite';

     export default defineConfig({});
     ```
   - **Proof blocks:**
     - **PROOF:** The renderer loads `http://127.0.0.1:{port}` from the Express server. It does NOT bundle or serve the React app itself. The React SPA is served by Express via `serveStaticUi: true` (server.ts L337-353).
   - **Verification:**
     ```bash
     # Verified as part of electron-forge start
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| ASAR unpack fails to include syntaur | App crashes on launch with path resolution error | Check console: "Cannot find dashboard/dist" | Verify `asar.unpack` glob includes `**/node_modules/syntaur/**` |
| Native module not found | App crashes with "Cannot find module better-sqlite3" | Check that `@electron/rebuild` ran during install | Verify `.node` files are in `app.asar.unpacked/` |
| Code signing identity not found | Forge build fails during packaging | "MAC_CODESIGN_IDENTITY env var not set" | Conditional spread: only set `osxSign` if env var exists |

#### Task Completion Criteria
- [ ] `forge.config.ts` compiles without TypeScript errors
- [ ] ASAR unpack glob covers both `.node` files and `syntaur` package
- [ ] macOS signing/notarization is conditional on environment variables
- [ ] All four Vite config files exist and export valid configurations
- [ ] `electron-forge start` successfully resolves all Vite build entries

---

### Task 3: Main Process

**File(s):** `src/main.ts`
**Action:** CREATE
**Pattern Reference:** `/Users/brennen/syntaur/src/commands/dashboard.ts:76-173` (server creation pattern), `/Users/brennen/syntaur/src/dashboard/server.ts:42-50` (DashboardServerOptions interface)
**Estimated complexity:** High

#### Context
The main process is the heart of the Electron app. It handles: (1) single-instance lock, (2) finding an available port, (3) creating and starting the Express+WebSocket server from the syntaur package, (4) creating a BrowserWindow pointing at the server URL, (5) graceful shutdown, (6) macOS dock activation handler.

#### Steps

1. [ ] **Step 3.1:** Create `src/main.ts` with complete main process implementation
   - **Location:** New file at `syntaur-app/src/main.ts`
   - **Action:** CREATE
   - **What to do:** Implement the full Electron main process. This file handles everything: single-instance enforcement, port discovery, server lifecycle, window management, and app events.
   - **Code:**
     ```typescript
     import { app, BrowserWindow } from 'electron';
     import { resolve } from 'node:path';
     import { homedir } from 'node:os';
     import { readFile } from 'node:fs/promises';
     import { existsSync } from 'node:fs';
     import { createServer as createNetServer } from 'node:net';
     import { createDashboardServer } from 'syntaur/dist/dashboard/server.js';
     import { buildMenu } from './menu.js';

     // ── Path utilities (reimplemented locally to avoid importing syntaur CLI entry) ──

     function syntaurRoot(): string {
       return resolve(homedir(), '.syntaur');
     }

     function defaultMissionDir(): string {
       return resolve(syntaurRoot(), 'missions');
     }

     function serversDir(): string {
       return resolve(syntaurRoot(), 'servers');
     }

     function assignmentsDir(): string {
       return resolve(syntaurRoot(), 'assignments');
     }

     function playbooksDir(): string {
       return resolve(syntaurRoot(), 'playbooks');
     }

     function todosDir(): string {
       return resolve(syntaurRoot(), 'todos');
     }

     // ── Config reading ──
     // Replicates parseFrontmatter() from src/utils/config.ts:71-96 and
     // readConfig() from src/utils/config.ts:442-463.
     // Key behaviors matched: quote stripping (.replace(/^["']|["']$/g, '')),
     // nested key support (parent.child), ~/expansion, absolute path validation,
     // malformed frontmatter warning + fallback.

     function parseFrontmatter(content: string): Record<string, string> {
       const match = content.match(/^---\n([\s\S]*?)\n---/);
       if (!match) return {};
       const result: Record<string, string> = {};
       const lines = match[1].split('\n');
       let currentParent: string | null = null;
       for (const line of lines) {
         if (line.trim() === '') continue;
         const indent = line.length - line.trimStart().length;
         const colonIndex = line.indexOf(':');
         if (colonIndex < 0) continue;
         const key = line.slice(0, colonIndex).trim();
         const value = line.slice(colonIndex + 1).trim();
         if (indent === 0) {
           if (value === '' || value === undefined) {
             currentParent = key;
           } else {
             currentParent = null;
             result[key] = value.replace(/^["']|["']$/g, '');
           }
         } else if (indent > 0 && currentParent) {
           result[`${currentParent}.${key}`] = value.replace(/^["']|["']$/g, '');
         }
       }
       return result;
     }

     async function readMissionsDir(): Promise<string> {
       const configPath = resolve(syntaurRoot(), 'config.md');
       try {
         const content = await readFile(configPath, 'utf-8');
         const fm = parseFrontmatter(content);

         if (Object.keys(fm).length === 0) {
           console.warn('Warning: ~/.syntaur/config.md has malformed frontmatter, using defaults');
           return defaultMissionDir();
         }

         if (fm['defaultMissionDir']) {
           let dir = fm['defaultMissionDir'];
           // Expand ~/ paths (matches expandHome in config.ts)
           if (dir.startsWith('~/')) {
             dir = resolve(homedir(), dir.slice(2));
           }
           // Validate absolute path (matches isAbsolute check in config.ts:458-463)
           const { isAbsolute } = await import('node:path');
           if (!isAbsolute(dir)) {
             console.warn(`Config defaultMissionDir is not absolute ("${dir}"), using default`);
             return defaultMissionDir();
           }
           return dir;
         }
       } catch {
         // Config file doesn't exist, use default
       }
       return defaultMissionDir();
     }

     // ── Port discovery ──

     function isPortAvailable(port: number): Promise<boolean> {
       return new Promise((resolveAvailability) => {
         const tester = createNetServer();
         tester.once('error', () => resolveAvailability(false));
         tester.once('listening', () => {
           tester.close(() => resolveAvailability(true));
         });
         tester.listen(port);
       });
     }

     async function findAvailablePort(
       startPort: number,
       maxAttempts: number = 20,
     ): Promise<number | null> {
       for (let offset = 0; offset < maxAttempts; offset++) {
         const candidate = startPort + offset;
         if (candidate > 65535) break;
         if (await isPortAvailable(candidate)) return candidate;
       }
       return null;
     }

     // ── Application state ──

     let mainWindow: BrowserWindow | null = null;
     let dashboardServer: ReturnType<typeof createDashboardServer> | null = null;
     let serverPort: number = 4800;

     // ── Single instance lock ──

     const gotTheLock = app.requestSingleInstanceLock();
     if (!gotTheLock) {
       app.quit();
     } else {
       app.on('second-instance', () => {
         if (mainWindow) {
           if (mainWindow.isMinimized()) mainWindow.restore();
           mainWindow.focus();
         }
       });

       app.whenReady().then(async () => {
         try {
           await launchApp();
         } catch (err) {
           const { dialog } = await import('electron');
           dialog.showErrorBox(
             'Syntaur failed to start',
             `The dashboard server could not be started.\n\n${err instanceof Error ? err.message : String(err)}\n\nMake sure ~/.syntaur/ is initialized (run 'npx syntaur init' in a terminal).`,
           );
           app.quit();
           return;
         }

         app.on('activate', () => {
           if (BrowserWindow.getAllWindows().length === 0) {
             createWindow();
           }
         });
       });

       app.on('window-all-closed', () => {
         if (process.platform !== 'darwin') {
           app.quit();
         }
       });

       app.on('before-quit', async () => {
         if (dashboardServer) {
           await dashboardServer.stop();
           dashboardServer = null;
         }
       });
     }

     // ── Launch sequence ──

     async function launchApp(): Promise<void> {
       // 0. Full first-run bootstrap (replicates `syntaur init` behavior)
       // See: src/commands/init.ts:13-61 for the canonical init logic
       const configPath = resolve(syntaurRoot(), 'config.md');
       const isFirstRun = !existsSync(configPath);

       const requiredDirs = [
         syntaurRoot(),
         defaultMissionDir(),
         assignmentsDir(),
         serversDir(),
         playbooksDir(),
         todosDir(),
       ];
       for (const dir of requiredDirs) {
         if (!existsSync(dir)) {
           const { mkdirSync } = await import('node:fs');
           mkdirSync(dir, { recursive: true });
         }
       }

       if (isFirstRun) {
         // Write default config.md — exact copy of renderConfig() output
         // from src/templates/config.ts:5-24
         const { writeFile: writeFileAsync } = await import('node:fs/promises');
         const defaultConfig = `---
version: "1.0"
defaultMissionDir: ${defaultMissionDir()}
onboarding:
  completed: false
agentDefaults:
  trustLevel: medium
  autoApprove: false
sync:
  enabled: false
  endpoint: null
  interval: 300
---

# Syntaur Configuration

Global configuration for the Syntaur CLI.
`;
         await writeFileAsync(configPath, defaultConfig, 'utf-8');

         // Seed default playbooks from syntaur package examples (best-effort)
         // and rebuild playbook manifest (matches init.ts:52-58)
         try {
           const playbooksPath = playbooksDir();
           // Use createRequire for ESM compatibility (both repos use "type": "module")
           const { createRequire } = await import('node:module');
           const require = createRequire(import.meta.url);
           const syntaurPkgRoot = resolve(
             dirname(require.resolve('syntaur/package.json')),
           );
           const examplesDir = resolve(syntaurPkgRoot, 'examples', 'playbooks');
           if (existsSync(examplesDir)) {
             const { readdir, readFile: readFileAsync, writeFile: writeFileAsync2 } =
               await import('node:fs/promises');
             const entries = await readdir(examplesDir, { withFileTypes: true });
             for (const entry of entries) {
               if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
               const targetPath = resolve(playbooksPath, entry.name);
               if (!existsSync(targetPath)) {
                 const content = await readFileAsync(resolve(examplesDir, entry.name), 'utf-8');
                 await writeFileAsync2(targetPath, content, 'utf-8');
               }
             }
           }

           // Rebuild playbook manifest (matches init.ts:58)
           // Import rebuildPlaybookManifest from the syntaur package
           try {
             const playbooksMod = await import(
               resolve(syntaurPkgRoot, 'dist', 'utils', 'playbooks.js')
             );
             if (playbooksMod.rebuildPlaybookManifest) {
               await playbooksMod.rebuildPlaybookManifest(playbooksPath);
             }
           } catch {
             // Manifest rebuild is best-effort; dashboard works without it
           }
         } catch {
           // Playbook seeding is best-effort; dashboard works without them
         }
       }

       // 1. Find available port
       const port = await findAvailablePort(4800);
       if (port === null) {
         console.error('Could not find an available port starting at 4800.');
         app.quit();
         return;
       }
       serverPort = port;

       // 2. Read missions directory from config and ensure it exists
       const missionsDir = await readMissionsDir();
       if (!existsSync(missionsDir)) {
         const { mkdirSync } = await import('node:fs');
         mkdirSync(missionsDir, { recursive: true });
       }

       // 3. Create and start the dashboard server
       dashboardServer = createDashboardServer({
         port: serverPort,
         missionsDir,
         assignmentsDir: assignmentsDir(),
         serversDir: serversDir(),
         playbooksDir: playbooksDir(),
         todosDir: todosDir(),
         serveStaticUi: true,
       });

       await dashboardServer.start();
       console.log(`Syntaur Dashboard server running on port ${serverPort}`);

       // 4. Set up native menu
       buildMenu(serverPort);

       // 5. Create the main window
       createWindow();

       // 6. Set up auto-updates (imported dynamically to avoid issues in dev)
       try {
         const { updateElectronApp } = await import('update-electron-app');
         updateElectronApp();
       } catch {
         // update-electron-app may not work in development
       }
     }

     function createWindow(): void {
       mainWindow = new BrowserWindow({
         width: 1400,
         height: 900,
         minWidth: 800,
         minHeight: 600,
         title: 'Syntaur',
         webPreferences: {
           // Electron Forge Vite plugin builds main and preload to the same output directory
           // (.vite/build/ in dev, resources/app/.vite/build/ in production).
           // __dirname is available because the Vite plugin builds main process as CJS.
           // The preload entry 'src/preload.ts' is built to 'preload.js' in the same dir as main.js.
           // This path contract is established by the VitePlugin config in forge.config.ts Task 2.
           preload: resolve(__dirname, 'preload.js'),
           contextIsolation: true,
           nodeIntegration: false,
           sandbox: false,
         },
       });

       mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

       mainWindow.on('closed', () => {
         mainWindow = null;
       });
     }
     ```
   - **Proof blocks:**
     - **PROOF:** `DashboardServerOptions` interface requires exactly these 7 fields: `port`, `missionsDir`, `assignmentsDir`, `serversDir`, `playbooksDir`, `todosDir`, `serveStaticUi`.
       Source: `/Users/brennen/syntaur/src/dashboard/server.ts:42-50`
       ```typescript
       export interface DashboardServerOptions {
         port: number;
         missionsDir: string;
         assignmentsDir: string;
         serversDir: string;
         playbooksDir: string;
         todosDir: string;
         serveStaticUi: boolean;
       }
       ```
     - **PROOF:** `createDashboardServer` returns `{ start(): Promise<void>; stop(): Promise<void>; readonly port: number; }`.
       Source: `/Users/brennen/syntaur/dist/dashboard/server.d.ts:10-14`
       ```typescript
       declare function createDashboardServer(options: DashboardServerOptions): {
           start(): Promise<void>;
           stop(): Promise<void>;
           readonly port: number;
       };
       ```
     - **PROOF:** `findAvailablePort` uses `net.createServer` to test port availability, starting at a given port and incrementing. Reimplemented from dashboard.ts L44-74.
       Source: `/Users/brennen/syntaur/src/commands/dashboard.ts:44-74`
     - **PROOF:** `dashboardCommand` reads `missionsDir` from `config.defaultMissionDir` and calls `getServersDir()`, `getAssignmentsDir()`, `getPlaybooksDir()`, `getTodosDir()` for the other dirs.
       Source: `/Users/brennen/syntaur/src/commands/dashboard.ts:77-109`
       ```typescript
       const config = await readConfig();
       const missionsDir = config.defaultMissionDir;
       // ...
       const server = createDashboardServer({
         port,
         missionsDir,
         serversDir: getServersDir(),
         assignmentsDir: getAssignmentsDir(),
         playbooksDir: getPlaybooksDir(),
         todosDir: getTodosDir(),
         serveStaticUi: mode === 'static',
       });
       ```
     - **PROOF:** All path utilities resolve under `~/.syntaur/` using `os.homedir()`:
       Source: `/Users/brennen/syntaur/src/utils/paths.ts:11-31`
       ```typescript
       export function syntaurRoot(): string {
         return resolve(homedir(), '.syntaur');
       }
       export function serversDir(): string {
         return resolve(syntaurRoot(), 'servers');
       }
       // ... etc
       ```
     - **PROOF:** `readConfig()` reads `~/.syntaur/config.md`, parses frontmatter, extracts `defaultMissionDir` with `expandHome()` support.
       Source: `/Users/brennen/syntaur/src/utils/config.ts:442-457`
       ```typescript
       export async function readConfig(): Promise<SyntaurConfig> {
         const configPath = resolve(syntaurRoot(), 'config.md');
         // ...
         let missionDir = fm['defaultMissionDir']
           ? expandHome(String(fm['defaultMissionDir']))
           : DEFAULT_CONFIG.defaultMissionDir;
       ```
     - **PROOF:** `server.stop()` is async and cleans up watchers, DB, WebSocket clients, and port file.
       Source: `/Users/brennen/syntaur/src/dashboard/server.ts:389-404`
     - **PROOF:** `update-electron-app` default usage: `updateElectronApp()` with no args auto-detects repo from package.json.
       Source: update-electron-app README
     - **PROOF:** Electron `app.requestSingleInstanceLock()` returns boolean; if false, another instance is already running.
       Source: Electron docs — app module
   - **Verification:**
     ```bash
     npx electron-forge start
     # Should: launch Electron, start Express server, show dashboard in window
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| No available port found | Log error and quit app | Console: "Could not find an available port starting at 4800." | `app.quit(); return;` |
| Server start fails (port in use) | `server.start()` rejects with `EADDRINUSE` error | Console: "Port {port} is already in use." | Caught by Promise rejection in `launchApp()` |
| `~/.syntaur/` not initialized | `createDashboardServer` will fail when creating watcher for non-existent dirs | Show dialog: "Syntaur data directory not found. Please run `npx syntaur init` first." | Before calling `createDashboardServer`, check `existsSync(syntaurRoot())` and `existsSync(missionsDir)`. If missing, create the directories with `mkdirSync(dir, { recursive: true })`. This mirrors what `syntaur init` does for the basic directory structure. |
| Second instance launched | First instance restores/focuses window, second quits | Second instance exits silently | `app.requestSingleInstanceLock()` pattern |
| Config file missing | `readMissionsDir()` falls back to default `~/.syntaur/missions` | No visible error | `catch {}` in readMissionsDir returns default |

#### Task Completion Criteria
- [ ] Single-instance lock prevents duplicate app launches
- [ ] Express server starts on an available port (auto-incrementing from 4800)
- [ ] BrowserWindow opens and loads `http://127.0.0.1:{port}`
- [ ] Dashboard renders identically to browser-based version
- [ ] App quits cleanly, calling `server.stop()` to clean up resources
- [ ] macOS dock click re-creates window if all windows are closed
- [ ] Non-macOS platforms quit when all windows are closed

---

### Task 4: Preload and Renderer

**File(s):** `src/preload.ts`, `src/renderer.ts`, `index.html`
**Action:** CREATE (all three files)
**Estimated complexity:** Low

#### Context
The preload script exposes a minimal API to the renderer via `contextBridge`. The renderer and HTML shell are minimal because the actual React SPA is served by the Express server. **Important:** `index.html` and `renderer.ts` are required by the Electron Forge Vite plugin (it expects a renderer entry point and HTML file), but they are effectively not used at runtime since `main.ts` calls `mainWindow.loadURL()` directly to point the BrowserWindow at the Express server. They exist solely to satisfy the Forge Vite plugin's build requirements and to show a brief loading state if the Express server is slow to start.

#### Steps

1. [ ] **Step 4.1:** Create `src/preload.ts` with contextBridge API
   - **Location:** New file at `syntaur-app/src/preload.ts`
   - **Action:** CREATE
   - **What to do:** Expose app version and platform info to the renderer process via `contextBridge.exposeInMainWorld`. This is a security-conscious minimal API.
   - **Code:**
     ```typescript
     import { contextBridge } from 'electron';

     contextBridge.exposeInMainWorld('syntaurDesktop', {
       version: () => process.env.npm_package_version ?? 'dev',
       platform: () => process.platform,
       arch: () => process.arch,
       electronVersion: () => process.versions.electron,
     });
     ```
   - **Proof blocks:**
     - **PROOF:** `contextBridge.exposeInMainWorld(apiKey, api)` exposes an object on `window[apiKey]` in the renderer. Requires `contextIsolation: true` in BrowserWindow webPreferences.
       Source: Electron docs — contextBridge.exposeInMainWorld
     - **PROOF:** `process.platform`, `process.arch`, `process.versions.electron` are available in preload scripts.
   - **Verification:**
     ```bash
     # After launch, open DevTools console in the BrowserWindow:
     # window.syntaurDesktop.platform()  -> should return "darwin" or "win32"
     ```

2. [ ] **Step 4.2:** Create `src/renderer.ts` as minimal renderer entry
   - **Location:** New file at `syntaur-app/src/renderer.ts`
   - **Action:** CREATE
   - **What to do:** Create a minimal renderer entry point. Since the BrowserWindow loads from the Express server URL (not from this file), this is just a placeholder that the Vite renderer config expects to exist.
   - **Code:**
     ```typescript
     // The Syntaur dashboard React SPA is served by the Express server.
     // This renderer entry is a no-op; the BrowserWindow loads http://127.0.0.1:{port} directly.
     console.log('Syntaur Desktop renderer loaded');
     ```
   - **Proof blocks:**
     - **PROOF:** The BrowserWindow loads `http://127.0.0.1:{port}` via `mainWindow.loadURL()` in `src/main.ts`, not from a local file. The renderer entry is required by the Vite plugin config but is not the source of the UI.
   - **Verification:**
     ```bash
     # Check that the file exists and the Vite build does not error
     npx electron-forge start
     ```

3. [ ] **Step 4.3:** Create `index.html` as Electron window shell
   - **Location:** New file at `syntaur-app/index.html`
   - **Action:** CREATE
   - **What to do:** Create the minimal HTML shell required by Electron Forge's Vite plugin. This HTML is the entry point for the renderer process. Since we load the dashboard from the Express server URL, this HTML just shows a brief loading state.
   - **Code:**
     ```html
     <!DOCTYPE html>
     <html lang="en">
       <head>
         <meta charset="UTF-8" />
         <meta name="viewport" content="width=device-width, initial-scale=1.0" />
         <title>Syntaur</title>
         <style>
           body {
             margin: 0;
             background: #0a0a0a;
             color: #ebebeb;
             font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
             display: flex;
             align-items: center;
             justify-content: center;
             height: 100vh;
           }
         </style>
       </head>
       <body>
         <p>Loading Syntaur Dashboard...</p>
         <script type="module" src="/src/renderer.ts"></script>
       </body>
     </html>
     ```
   - **Proof blocks:**
     - **PROOF:** Electron Forge Vite plugin expects an `index.html` at the project root with a `<script>` tag pointing to the renderer entry.
     - **PROOF:** The background color should match the Syntaur dashboard's actual theme. The dashboard uses CSS variables defined in `dashboard/src/globals.css:7`: `--background: 0 0% 4%` (HSL), which is near-black (`#0a0a0a`). Use `#0a0a0a` instead of `#0f172a`.
       Source: `/Users/brennen/syntaur/dashboard/src/globals.css:7`
   - **Verification:**
     ```bash
     # The file should be valid HTML and load without errors in the BrowserWindow
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| Preload script fails to load | BrowserWindow shows error | DevTools console will show the error | N/A — Electron handles this internally |

#### Task Completion Criteria
- [ ] `preload.ts` exposes `window.syntaurDesktop` with `version`, `platform`, `arch`, `electronVersion` functions
- [ ] `renderer.ts` exists and does not error
- [ ] `index.html` is valid HTML with correct script tag
- [ ] `contextIsolation: true` and `nodeIntegration: false` are set in BrowserWindow webPreferences (verified in Task 3)

---

### Task 5: Native Menu

**File(s):** `src/menu.ts`
**Action:** CREATE
**Estimated complexity:** Low

#### Context
Build a native application menu with standard Edit/View/Window items for clipboard operations, zoom, and window management, plus Syntaur-specific items like opening the dashboard URL in the default browser, reloading the dashboard, and toggling DevTools.

#### Steps

1. [ ] **Step 5.1:** Create `src/menu.ts` with native menu template
   - **Location:** New file at `syntaur-app/src/menu.ts`
   - **Action:** CREATE
   - **What to do:** Build and set the application menu using `Menu.buildFromTemplate`. Include: (a) App menu (macOS only) with About, Quit, (b) Edit menu with Undo, Redo, Cut, Copy, Paste, Select All, (c) View menu with Reload Dashboard, Toggle DevTools, Zoom In/Out/Reset, (d) Window menu with Minimize, Close, (e) Help menu with Open in Browser.
   - **Code:**
     ```typescript
     import { Menu, shell, BrowserWindow, app } from 'electron';
     import type { MenuItemConstructorOptions } from 'electron';

     export function buildMenu(serverPort: number): void {
       const isMac = process.platform === 'darwin';
       const dashboardUrl = `http://127.0.0.1:${serverPort}`;

       const template: MenuItemConstructorOptions[] = [
         // App menu (macOS only)
         ...(isMac
           ? [
               {
                 label: app.name,
                 submenu: [
                   { role: 'about' as const },
                   { type: 'separator' as const },
                   { role: 'services' as const },
                   { type: 'separator' as const },
                   { role: 'hide' as const },
                   { role: 'hideOthers' as const },
                   { role: 'unhide' as const },
                   { type: 'separator' as const },
                   { role: 'quit' as const },
                 ],
               } satisfies MenuItemConstructorOptions,
             ]
           : []),

         // Edit menu
         {
           label: 'Edit',
           submenu: [
             { role: 'undo' },
             { role: 'redo' },
             { type: 'separator' },
             { role: 'cut' },
             { role: 'copy' },
             { role: 'paste' },
             { role: 'selectAll' },
           ],
         },

         // View menu
         {
           label: 'View',
           submenu: [
             {
               label: 'Reload Dashboard',
               accelerator: 'CmdOrCtrl+R',
               click: () => {
                 const win = BrowserWindow.getFocusedWindow();
                 if (win) win.loadURL(dashboardUrl);
               },
             },
             {
               label: 'Toggle Developer Tools',
               accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
               click: () => {
                 const win = BrowserWindow.getFocusedWindow();
                 if (win) win.webContents.toggleDevTools();
               },
             },
             { type: 'separator' },
             { role: 'resetZoom' },
             { role: 'zoomIn' },
             { role: 'zoomOut' },
             { type: 'separator' },
             { role: 'togglefullscreen' },
           ],
         },

         // Window menu
         {
           label: 'Window',
           submenu: [
             { role: 'minimize' },
             { role: 'close' },
             ...(isMac
               ? [
                   { type: 'separator' as const },
                   { role: 'front' as const },
                 ]
               : []),
           ],
         },

         // Help menu
         {
           label: 'Help',
           submenu: [
             {
               label: 'Open in Browser',
               click: () => {
                 shell.openExternal(dashboardUrl);
               },
             },
           ],
         },
       ];

       const menu = Menu.buildFromTemplate(template);
       Menu.setApplicationMenu(menu);
     }
     ```
   - **Proof blocks:**
     - **PROOF:** `Menu.buildFromTemplate(template)` accepts an array of `MenuItemConstructorOptions`. Each entry can have `role` (built-in action) or `label` + `click` (custom action).
       Source: Electron docs — Menu module
     - **PROOF:** `shell.openExternal(url)` opens a URL in the user's default browser.
       Source: Electron docs — shell module
     - **PROOF:** `BrowserWindow.getFocusedWindow()` returns the currently focused window or null.
       Source: Electron docs — BrowserWindow static methods
     - **PROOF:** macOS convention requires an app-name menu as the first item. The `role: 'about'`, `role: 'services'`, `role: 'hide'`, `role: 'hideOthers'`, `role: 'unhide'`, `role: 'quit'` roles are macOS-specific standard menu items.
   - **Verification:**
     ```bash
     # After launch, verify:
     # 1. Menu bar shows Edit, View, Window, Help (and app name on macOS)
     # 2. Cmd+R reloads the dashboard
     # 3. Alt+Cmd+I opens DevTools
     # 4. Help > Open in Browser opens the dashboard URL in the default browser
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| No focused window when menu action fires | `getFocusedWindow()` returns null, action is no-op | No visible error | `if (win)` guard |

#### Task Completion Criteria
- [ ] Menu bar renders with Edit, View, Window, Help menus
- [ ] macOS app menu shows About, Services, Hide, Quit
- [ ] "Reload Dashboard" reloads the BrowserWindow with the dashboard URL
- [ ] "Toggle Developer Tools" opens/closes DevTools
- [ ] "Open in Browser" opens the dashboard URL in the default browser
- [ ] Standard Edit shortcuts (Cmd+Z, Cmd+C, Cmd+V, etc.) work

---

### Task 6: Auto-Updates

**File(s):** `src/main.ts` (addition — already handled inline in Task 3)
**Action:** MODIFY (already included in Task 3 code)
**Estimated complexity:** Low

#### Context
Auto-updates are integrated using `update-electron-app`, which uses the Squirrel framework (built into Electron) to check for updates from GitHub Releases.

#### Steps

1. [ ] **Step 6.1:** Add `repository` field to `package.json` for auto-update detection
   - **Location:** `syntaur-app/package.json`
   - **Action:** MODIFY (add repository field)
   - **What to do:** Add the `repository` field so `update-electron-app` can auto-detect the GitHub repo for update checks. **This must be done before Step 6.2** because `updateElectronApp()` reads this field at runtime.
   - **Code (add to package.json):**
     ```json
     {
       "repository": {
         "type": "git",
         "url": "git+https://github.com/prong-horn/syntaur-app.git"
       }
     }
     ```
   - **Proof blocks:**
     - **PROOF:** `update-electron-app` reads `repository` from package.json to determine the GitHub repo. When using `ElectronPublicUpdateService`, the repo URL is derived from this field.
       Source: update-electron-app README
   - **Verification:**
     ```bash
     node -e "const p = require('./package.json'); console.log(p.repository.url)"
     # Should print: git+https://github.com/prong-horn/syntaur-app.git
     ```

2. [ ] **Step 6.2:** Verify auto-update integration in `src/main.ts`
   - **Location:** `syntaur-app/src/main.ts` (already created in Task 3)
   - **Action:** VERIFY (code already exists in Task 3)
   - **What to do:** The auto-update code is already included in Task 3's `launchApp()` function. Verify that the dynamic import of `update-electron-app` is correct, that it's called after the window is created, and that the `repository` field from Step 6.1 is present.
   - **Code (already in Task 3):**
     ```typescript
     // 6. Set up auto-updates (imported dynamically to avoid issues in dev)
     try {
       const { updateElectronApp } = await import('update-electron-app');
       updateElectronApp();
     } catch {
       // update-electron-app may not work in development
     }
     ```
   - **Proof blocks:**
     - **PROOF:** `updateElectronApp()` with no arguments auto-detects the repository from `package.json`'s `repository` field (added in Step 6.1), checks update.electronjs.org every 10 minutes, and prompts the user to install when an update is available.
       Source: update-electron-app README
       ```javascript
       updateElectronApp() // Auto-detects repo from package.json
       ```
     - **PROOF:** The `notifyUser` option defaults to `true`, meaning the user will be prompted to apply updates after download.
   - **Verification:**
     ```bash
     # End-to-end auto-update verification is deferred to Task 10.
     # At this stage, verify the code compiles and the repository field exists:
     node -e "const p = require('./package.json'); if (!p.repository) throw new Error('missing repository field')"
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| No internet connection | `updateElectronApp` silently retries on next interval | No visible error | Built into update-electron-app |
| No GitHub releases exist | No update found, no action taken | No visible error | Built into update-electron-app |
| Running in dev mode | Dynamic import may fail | No visible error | `try { ... } catch { }` |

#### Task Completion Criteria
- [ ] `update-electron-app` is imported and called after window creation
- [ ] `package.json` has `repository` field pointing to GitHub repo
- [ ] Auto-updates work in production builds (verified via test release)

---

### Task 7: Native Module Rebuild

**File(s):** `package.json` (modification)
**Action:** MODIFY
**Estimated complexity:** Low

#### Context
`better-sqlite3` is a C++ native addon that ships pre-built binaries for standard Node.js. Electron uses a different Node ABI, so the native module must be rebuilt for Electron's Node version. The `@electron/rebuild` package handles this automatically.

#### Steps

1. [ ] **Step 7.1:** Add electron-rebuild postinstall script to `package.json`
   - **Location:** `syntaur-app/package.json`
   - **Action:** MODIFY (add postinstall script)
   - **What to do:** Append a `postinstall` entry to the existing `scripts` object in `package.json` (created in Step 1.1). Do not replace the existing scripts — merge this one key.
   - **Code (append to the existing `scripts` object in package.json):**
     ```json
     {
       "scripts": {
         "start": "electron-forge start",
         "package": "electron-forge package",
         "make": "electron-forge make",
         "publish": "electron-forge publish",
         "lint": "tsc --noEmit",
         "postinstall": "electron-rebuild"
       }
     }
     ```
   - **Proof blocks:**
     - **PROOF:** `better-sqlite3` is a native C++ addon imported by syntaur's `session-db.ts`.
       Source: `/Users/brennen/syntaur/src/dashboard/session-db.ts:1`
       ```typescript
       import Database from 'better-sqlite3';
       ```
     - **PROOF:** `better-sqlite3` is listed as a dependency of `syntaur` package.
       Source: `/Users/brennen/syntaur/package.json:49`
       ```json
       "better-sqlite3": "^11.0.0",
       ```
     - **PROOF:** `@electron/rebuild` is included in devDependencies (added in Task 1). The `electron-rebuild` CLI command rebuilds all native modules in node_modules for Electron's Node version.
   - **Verification:**
     ```bash
     npm install  # postinstall runs electron-rebuild automatically
     # Then verify:
     node -e "require('better-sqlite3')"  # should NOT work (wrong ABI)
     npx electron -e "require('better-sqlite3')"  # SHOULD work (correct ABI)
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| `electron-rebuild` fails | Install fails with build error | "Failed to rebuild native modules. Ensure build tools are installed (Xcode CLI tools on macOS, Visual Studio on Windows)." | N/A (manual fix) |
| Missing C++ compiler | Rebuild fails | Platform-specific error about missing compiler | Install Xcode CLI tools (mac) or VS Build Tools (win) |

#### Task Completion Criteria
- [ ] `postinstall` script runs `electron-rebuild` after `npm install`
- [ ] `better-sqlite3` loads correctly inside Electron's Node runtime
- [ ] App does not crash on launch due to native module ABI mismatch

---

### Task 8: macOS CI/CD Workflow

**File(s):** `.github/workflows/mac-release.yml`
**Action:** CREATE
**Estimated complexity:** Medium

#### Context
Set up a GitHub Actions workflow that builds, signs, notarizes, and publishes the macOS version of the app to GitHub Releases. Triggered by version tags (`v*`) or manual dispatch.

#### Steps

1. [ ] **Step 8.1:** Create `.github/workflows/mac-release.yml`
   - **Location:** New file at `syntaur-app/.github/workflows/mac-release.yml`
   - **Action:** CREATE
   - **What to do:** Create a GitHub Actions workflow for macOS releases. Steps: (1) checkout code, (2) setup Node 20, (3) install dependencies (triggers electron-rebuild), (4) import code signing certificate to Keychain, (5) run `npm run make` with signing env vars, (6) notarize DMG and ZIP artifacts, (7) upload to GitHub Release.
   - **Code:**
     ```yaml
     name: macOS Release

     on:
       push:
         tags:
           - 'v*'
       workflow_dispatch:

     permissions:
       contents: write

     jobs:
       build-mac:
         runs-on: macos-latest
         steps:
           - name: Checkout
             uses: actions/checkout@v4

           - name: Setup Node.js
             uses: actions/setup-node@v4
             with:
               node-version: 20
               cache: npm

           - name: Install dependencies
             run: npm ci

           - name: Import code signing certificate
             env:
               MAC_CERTIFICATE: ${{ secrets.MAC_CERTIFICATE }}
               MAC_CERTIFICATE_PASSWORD: ${{ secrets.MAC_CERTIFICATE_PASSWORD }}
               KEYCHAIN_PASSWORD: ${{ secrets.KEYCHAIN_PASSWORD }}
             run: |
               echo "$MAC_CERTIFICATE" | base64 --decode > certificate.p12
               security create-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
               security default-keychain -s build.keychain
               security unlock-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
               security import certificate.p12 -k build.keychain -P "$MAC_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
               security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" build.keychain
               rm certificate.p12

           - name: Build and package
             env:
               MAC_CODESIGN_IDENTITY: ${{ secrets.MAC_CODESIGN_IDENTITY }}
               APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
               APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
               APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
             run: npm run make

           - name: Upload artifacts to GitHub Release
             uses: softprops/action-gh-release@v2
             with:
               files: |
                 out/make/**/*.dmg
                 out/make/**/*.zip
             env:
               GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
     ```
   - **Proof blocks:**
     - **PROOF:** Electron Forge `make` outputs artifacts to `out/make/` directory, organized by maker type.
     - **PROOF:** macOS code signing requires: (1) a `.p12` certificate imported into a Keychain, (2) `codesign` binary access, (3) the certificate identity name passed as `MAC_CODESIGN_IDENTITY`.
     - **PROOF:** `forge.config.ts` reads `MAC_CODESIGN_IDENTITY`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` from environment variables (set up in Task 2).
   - **Verification:**
     ```bash
     # 1. Push a tag: git tag v0.1.0 && git push --tags
     # 2. Check GitHub Actions for the mac-release workflow
     # 3. Verify DMG and ZIP appear in the GitHub Release
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| Certificate secret not set | Keychain import step fails | GitHub Actions step fails with "MAC_CERTIFICATE is not set" | Check repository secrets |
| Notarization fails | Build step fails | Apple returns notarization error | Check APPLE_API_KEY credentials |
| npm ci fails | Build fails early | Missing dependencies | Check package-lock.json is committed |

#### Task Completion Criteria
- [ ] Workflow triggers on `v*` tags and manual dispatch
- [ ] Code signing certificate is imported to a temporary Keychain
- [ ] `npm run make` runs with signing environment variables
- [ ] DMG and ZIP artifacts are uploaded to GitHub Release
- [ ] Workflow has `contents: write` permission for creating releases

---

### Task 9: Windows CI/CD Workflow

**File(s):** `.github/workflows/windows-release.yml`
**Action:** CREATE
**Estimated complexity:** Medium

#### Context
Set up a GitHub Actions workflow that builds and publishes the Windows version of the app to GitHub Releases. Windows code signing is optional (can ship unsigned initially).

#### Steps

1. [ ] **Step 9.1:** Create `.github/workflows/windows-release.yml`
   - **Location:** New file at `syntaur-app/.github/workflows/windows-release.yml`
   - **Action:** CREATE
   - **What to do:** Create a GitHub Actions workflow for Windows releases. Steps: (1) checkout code, (2) setup Node 20, (3) install dependencies, (4) run `npm run make`, (5) optionally sign with PFX certificate, (6) upload to GitHub Release.
   - **Code:**
     ```yaml
     name: Windows Release

     on:
       push:
         tags:
           - 'v*'
       workflow_dispatch:

     permissions:
       contents: write

     jobs:
       build-windows:
         runs-on: windows-latest
         steps:
           - name: Checkout
             uses: actions/checkout@v4

           - name: Setup Node.js
             uses: actions/setup-node@v4
             with:
               node-version: 20
               cache: npm

           - name: Install dependencies
             run: npm ci

           - name: Build and package
             env:
               WINDOWS_CERTIFICATE_FILE: ${{ secrets.WINDOWS_CERTIFICATE_FILE }}
               WINDOWS_CERTIFICATE_PASSWORD: ${{ secrets.WINDOWS_CERTIFICATE_PASSWORD }}
             run: npm run make

           - name: Upload artifacts to GitHub Release
             uses: softprops/action-gh-release@v2
             with:
               files: |
                 out/make/**/*.exe
                 out/make/**/*.nupkg
                 out/make/**/RELEASES
                 out/make/**/*.zip
             env:
               GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
     ```
   - **Proof blocks:**
     - **PROOF:** `MakerSquirrel` in `forge.config.ts` produces `.exe` installer and `.nupkg` update package for Windows.
     - **PROOF:** Windows code signing is optional. Without `certificateFile` and `certificatePassword` in MakerSquirrel config, the app is unsigned (SmartScreen warning on first run).
   - **Verification:**
     ```bash
     # 1. Push a tag: git tag v0.1.0 && git push --tags
     # 2. Check GitHub Actions for the windows-release workflow
     # 3. Verify .exe and .zip appear in the GitHub Release
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| No Windows signing cert | App is unsigned, SmartScreen warning | Users see "Windows protected your PC" on first run | No code change needed; can sign later |
| Native module rebuild fails on Windows | npm ci fails | "Failed to rebuild better-sqlite3" | Ensure windows-latest runner has VS Build Tools |

#### Task Completion Criteria
- [ ] Workflow triggers on `v*` tags and manual dispatch
- [ ] `npm run make` runs successfully on windows-latest runner
- [ ] Squirrel installer (.exe) and ZIP are uploaded to GitHub Release
- [ ] Workflow has `contents: write` permission

---

### Task 10: Testing and Polish

**File(s):** No new files
**Action:** VERIFY
**Estimated complexity:** Low

#### Context
Verify that the complete Electron app works end-to-end: dashboard loads, all API routes respond, WebSocket connects, file watching works, menu items function, and the app packages correctly.

#### Steps

1. [ ] **Step 10.1:** Verify dashboard loads and renders
   - **Location:** N/A (manual testing)
   - **Action:** VERIFY
   - **What to do:** Run `npm start` and verify the dashboard loads in the BrowserWindow with all navigation, missions, assignments, and other features visible.
   - **Verification:**
     ```bash
     npm start
     # Visually verify: dashboard loads, navigation works, missions list appears
     ```

2. [ ] **Step 10.2:** Verify API routes and WebSocket
   - **Location:** N/A (manual testing)
   - **Action:** VERIFY
   - **What to do:** Open DevTools in the BrowserWindow (View > Toggle Developer Tools), check Network tab for API calls and WebSocket connection.
   - **Verification:**
     ```bash
     # In DevTools Network tab:
     # 1. Check /api/overview returns 200
     # 2. Check /ws WebSocket connection is established
     # 3. Check /api/missions returns data
     # 4. Modify a file in ~/.syntaur/missions/ and verify WebSocket receives update
     ```

3. [ ] **Step 10.3:** Verify packaging
   - **Location:** N/A (build testing)
   - **Action:** VERIFY
   - **What to do:** Run `npm run make` and verify the output artifacts exist and the packaged app launches correctly.
   - **Verification:**
     ```bash
     npm run make
     # Check out/make/ for:
     # - *.dmg (macOS)
     # - *.zip (macOS/Windows)
     # Open the .dmg, drag to Applications, launch, verify dashboard works
     ```

4. [ ] **Step 10.4:** Verify single-instance enforcement
   - **Location:** N/A (manual testing)
   - **Action:** VERIFY
   - **What to do:** Launch the app, then try to launch a second instance. The first window should come to the front; the second instance should quit.
   - **Verification:**
     ```bash
     # Launch app from terminal or Applications
     # Try to launch again
     # Verify: first window focuses, second instance quits silently
     ```

5. [ ] **Step 10.5:** Verify graceful shutdown
   - **Location:** N/A (manual testing)
   - **Action:** VERIFY
   - **What to do:** Close the app and verify that the Express server stops, the port file at `~/.syntaur/dashboard-port` is removed, and no orphan processes remain.
   - **Verification:**
     ```bash
     # Before closing, note the port from the console output or ~/.syntaur/dashboard-port
     PORT=$(cat ~/.syntaur/dashboard-port 2>/dev/null || echo 4800)
     # Close the app, then:
     cat ~/.syntaur/dashboard-port  # should not exist (file deleted by server.stop())
     lsof -i :$PORT  # should show no listeners on the port the app was using
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| Dashboard doesn't load | Check server console for errors | DevTools console shows network errors | Debug: check port, check server.start() |
| WebSocket doesn't connect | Check that server is running and port is correct | DevTools Network tab shows WS connection failure | Debug: verify ws://127.0.0.1:{port}/ws |
| Packaging fails | Check forge.config.ts and Vite configs | Terminal shows make error | Debug: check ASAR unpack rules, native modules |

6. [ ] **Step 10.6:** Verify first-run behavior (no existing `~/.syntaur/`)
   - **Location:** N/A (manual testing)
   - **Action:** VERIFY
   - **What to do:** Temporarily rename `~/.syntaur/` to `~/.syntaur-backup/`, launch the app, verify the full bootstrap runs. Expected result: all directories created, `config.md` written with default frontmatter, dashboard opens showing empty state (no missions). Restore afterward.
   - **Verification:**
     ```bash
     mv ~/.syntaur ~/.syntaur-backup
     npm start
     # EXPECTED: app launches successfully and dashboard loads (empty state)
     # VERIFY these files/dirs exist:
     ls ~/.syntaur/config.md          # must exist with defaultMissionDir in frontmatter
     ls ~/.syntaur/missions/          # must exist (empty)
     ls ~/.syntaur/assignments/       # must exist (empty)
     ls ~/.syntaur/servers/           # must exist (empty)
     ls ~/.syntaur/playbooks/         # must exist (may have seeded playbooks)
     ls ~/.syntaur/todos/             # must exist (empty)
     # Close app, then restore:
     rm -rf ~/.syntaur
     mv ~/.syntaur-backup ~/.syntaur
     ```

7. [ ] **Step 10.7:** Verify custom `defaultMissionDir` from config
   - **Location:** N/A (manual testing)
   - **Action:** VERIFY
   - **What to do:** Set `defaultMissionDir: ~/custom-missions` in `~/.syntaur/config.md`, create that directory, launch the app, verify it reads from the custom dir.
   - **Verification:**
     ```bash
     # Add to ~/.syntaur/config.md frontmatter: defaultMissionDir: ~/custom-missions
     mkdir -p ~/custom-missions
     npm start
     # Verify: dashboard shows missions from ~/custom-missions, not ~/.syntaur/missions
     ```

8. [ ] **Step 10.8:** Verify Windows `RELEASES` artifact (on Windows CI)
   - **Location:** N/A (CI verification)
   - **Action:** VERIFY
   - **What to do:** After Task 9 Windows CI runs, check that the `RELEASES` file is present in the GitHub Release artifacts alongside `.exe` and `.nupkg`.
   - **Verification:**
     ```bash
     gh release view v0.1.0 --json assets -q '.assets[].name'
     # Should include: RELEASES, Syntaur-*.exe, Syntaur-*.nupkg, Syntaur-*.zip
     ```

#### Task Completion Criteria
- [ ] Dashboard loads and renders all pages correctly
- [ ] API calls return data (missions, assignments, servers, etc.)
- [ ] WebSocket connects and receives real-time updates
- [ ] File watching works (modify a file, see update in dashboard)
- [ ] Menu items work (Reload, DevTools, Open in Browser)
- [ ] `npm run make` produces installable artifacts
- [ ] Single-instance lock prevents duplicate launches
- [ ] Graceful shutdown cleans up all resources
- [ ] No orphan port file after app closes
- [ ] First-run with no `~/.syntaur/` creates full directory structure, writes `config.md`, seeds playbooks, and dashboard loads in empty state
- [ ] Custom `defaultMissionDir` from config.md is respected
- [ ] Windows CI produces `RELEASES` artifact for Squirrel auto-updates

---

## Final File Inventory

Task 0 modifies `src/dashboard/server.ts` in the existing `syntaur` repo. All remaining files are created in the new `syntaur-app` repository:

| # | File | Action | Task |
|---|------|--------|------|
| 0 | `src/dashboard/server.ts` (syntaur repo) | MODIFY | Task 0 |
| 1 | `package.json` | CREATE | Task 1, modified in Tasks 6-7 |
| 2 | `tsconfig.json` | CREATE | Task 1 |
| 2b | `package-lock.json` | CREATE | Task 1 (Step 1.3, generated by `npm install`) |
| 3 | `.gitignore` | CREATE | Task 1 |
| 4 | `forge.config.ts` | CREATE | Task 2 |
| 5 | `vite.main.config.ts` | CREATE | Task 2 |
| 6 | `vite.preload.config.ts` | CREATE | Task 2 |
| 7 | `vite.renderer.config.ts` | CREATE | Task 2 |
| 8 | `src/main.ts` | CREATE | Task 3 |
| 9 | `src/preload.ts` | CREATE | Task 4 |
| 10 | `src/renderer.ts` | CREATE | Task 4 |
| 11 | `index.html` | CREATE | Task 4 |
| 12 | `src/menu.ts` | CREATE | Task 5 |
| 13 | `.github/workflows/mac-release.yml` | CREATE | Task 8 |
| 14 | `.github/workflows/windows-release.yml` | CREATE | Task 9 |
| 15 | `assets/icon.png` | CREATE | Task 1b (icon assets) |
| 16 | `assets/icon.icns` | CREATE | Task 1b (generated from icon.png) |
| 17 | `assets/icon.ico` | CREATE | Task 1b (generated from icon.png) |

## Implementation Order

Tasks should be implemented in this order (respecting dependencies):

0. **Task 0** (Fix packageRoot in syntaur repo) -- PREREQUISITE, must be done first and a new syntaur version published
1. **Task 1** (Initialize repository) -- depends on Task 0 (updated syntaur version). Includes generating `package-lock.json` (Step 1.3) which CI requires.
1b. **Task 1b** (Icon assets) -- depends on Task 1 (needs repo). Can be done in parallel with Task 2.
2. **Task 2** (Forge/Vite config) -- depends on package.json from Task 1
3. **Task 7** (Native module rebuild) -- move BEFORE any Electron launch. `better-sqlite3` is loaded at import time (`server.ts:94` calls `initSessionDb()`), so it must be rebuilt before `electron-forge start` can succeed.
4. **Tasks 4, 5** (Preload/Renderer, Menu) -- can be done in parallel, depend on Task 2
5. **Task 3** (Main process) -- depends on Tasks 2, 4, 5, and 7 (imports `./menu.js`, references preload output, and launches Express which loads `better-sqlite3`). Verification of 3/4/5 should be done together.
6. **Task 6** (Auto-updates) -- depends on Task 3
7. **Tasks 8, 9** (CI/CD workflows) -- can be done in parallel, depend on Task 1 (need `package-lock.json`)
8. **Task 10** (Testing) -- must be last

```mermaid
graph LR
    T0[Task 0: Fix syntaur packageRoot] --> T1[Task 1: Init Repo]
    T1 --> T1b[Task 1b: Icon Assets]
    T1 --> T2[Task 2: Forge/Vite Config]
    T1 --> T7[Task 7: Native Module Rebuild]
    T2 --> T4[Task 4: Preload/Renderer]
    T2 --> T5[Task 5: Menu]
    T4 --> T3[Task 3: Main Process]
    T5 --> T3
    T7 --> T3
    T3 --> T6[Task 6: Auto-Updates]
    T3 --> T10[Task 10: Testing]
    T6 --> T10
    T1 --> T8[Task 8: macOS CI/CD]
    T1 --> T9[Task 9: Windows CI/CD]
    T8 --> T10
    T9 --> T10
    T1b --> T10
```

---

## Plan Review Summary

**Date:** 2026-04-12
**Overall Verdict:** READY FOR IMPLEMENTATION (after fixes applied)
**Pre-review snapshot:** `/Users/brennen/syntaur/claude-info/plans/2026-04-12-syntaur-desktop-app.md.pre-review.md`

| Pass | Result | Issues Found | Issues Fixed |
|------|--------|-------------|-------------|
| Completeness | PASS | 1 | 1 |
| Detail | PASS (with caveats) | 3 | 3 |
| Accuracy | FAIL -> FIXED | 3 | 3 |
| Standards | PASS | 1 | 1 |
| Simplicity | PASS | 0 | 0 |
| External: feature-dev:code-reviewer | SKIPPED | N/A | N/A |
| External: superpowers:code-reviewer | SKIPPED | N/A | N/A |
| External: Codex (gpt-5.4) | DONE | 7 | 7 |

### Pass 1: Completeness -- PASS

**Requirements mapped:**

| Requirement | Plan Task | Status |
|------------|-----------|--------|
| Spawn Express server from syntaur package | Task 3, Step 3.1 | COVERED |
| Open BrowserWindow at localhost | Task 3, Step 3.1 | COVERED |
| Electron Forge with Vite plugin | Task 2, Steps 2.1-2.4 | COVERED |
| Package as .dmg and .exe | Task 2 (makers), Tasks 8-9 (CI) | COVERED |
| Auto-updates via update-electron-app | Task 6 | COVERED |
| GitHub Actions for builds and notarization | Tasks 8-9 | COVERED |
| Native feel: menu, dock, window mgmt | Tasks 3, 5 | COVERED |
| New repo at git@github.com:prong-horn/syntaur-app.git | Task 1 | COVERED |
| First-run handling for uninitialized ~/.syntaur/ | Task 3 (added during review) | COVERED (FIXED) |

**Missing items fixed:** First-run directory creation was missing -- added to `launchApp()` function.

### Pass 2: Detail -- PASS (with caveats)

**Spot-checked steps:**

| Step | File Path? | Line Number? | Code? | Proof Block? | Verdict |
|------|-----------|-------------|-------|-------------|---------|
| Task 1, Step 1.1 | Yes | N/A (new file) | Yes (complete JSON) | Yes | PASS |
| Task 3, Step 3.1 | Yes | N/A (new file) | Yes (complete TS) | Yes (9 proofs) | PASS |
| Task 2, Step 2.1 | Yes | N/A (new file) | Yes (complete TS) | Yes | PASS |
| Task 5, Step 5.1 | Yes | N/A (new file) | Yes (complete TS) | Yes | PASS |
| Task 8, Step 8.1 | Yes | N/A (new file) | Yes (complete YAML) | Yes | PASS |

**Vague steps found:** None -- all steps include complete file contents.
**Missing code snippets:** None.
**Clarifications added:** Renderer/index.html dead-code explanation; `__dirname` availability comment.

### Pass 3: Accuracy -- FAIL -> FIXED

**Verified claims:**

| Claim | Source File | Verdict |
|-------|-----------|---------|
| `DashboardServerOptions` has 7 fields | `src/dashboard/server.ts:42-50` | VERIFIED |
| `createDashboardServer` returns `{start, stop, port}` | `dist/dashboard/server.d.ts:10-14` | VERIFIED |
| `initSessionDb()` called at construction (L94) | `src/dashboard/server.ts:94` | VERIFIED |
| `start()` returns Promise, L359-387 | `src/dashboard/server.ts:358-387` | VERIFIED (L358, not L359) |
| `stop()` cleans up, L389-404 | `src/dashboard/server.ts:389-404` | VERIFIED |
| All fetch calls use `/api/...` relative URLs | `dashboard/src/hooks/useMissions.ts:354,368,372,etc` | VERIFIED |
| WebSocket derives URL from `window.location` | `dashboard/src/hooks/useWebSocket.ts:17-24` | VERIFIED |
| `better-sqlite3` imported in session-db.ts | `src/dashboard/session-db.ts:1` | VERIFIED |
| Path utilities use `homedir()` | `src/utils/paths.ts:11-12` | VERIFIED |
| `server.ts` uses `import.meta.url` for packageRoot | `src/dashboard/server.ts:38-40` | VERIFIED |
| `tsup.config.ts` externalizes `better-sqlite3` | `tsup.config.ts:12` | VERIFIED |
| No `exports` map in package.json | `package.json` (grep) | VERIFIED |
| `dist/index.js` calls `commander.parseAsync()` | `src/index.ts:442` | VERIFIED |
| Server.ts is 410 lines | `wc -l` result | VERIFIED |
| Dashboard.ts is 173 lines | `wc -l` result | VERIFIED |
| paths.ts is 31 lines (plan claim) | `wc -l` result: 33 lines | MINOR DISCREPANCY (33, not 31) |
| useMissions.ts is 449 lines (plan claim) | `wc -l` result: 448 lines | MINOR DISCREPANCY (448, not 449) |
| SQLite DB stored at `~/.syntaur/sessions.db` | `src/dashboard/session-db.ts:40` | HALLUCINATED -- actual name is `syntaur.db` |
| `packageRoot` resolves correctly from `dist/dashboard/server.js` | `dist/dashboard/server.js:6234-6236` | HALLUCINATED -- resolves to `dist/` not package root |
| `readConfig` available via CLI bundle re-export | `dist/index.d.ts` | HALLUCINATED -- `dist/index.d.ts` exports nothing |

**Hallucinated items found and fixed:**
1. `sessions.db` -> `syntaur.db` (fixed in plan)
2. `packageRoot` resolution bug when importing from `dist/dashboard/server.js` (added Task 0 prerequisite)
3. `readConfig` re-export claim removed from plan

### Pass 4: Standards -- PASS

**CLAUDE.md rules checked:**

| Rule | Plan Compliance | Status |
|------|----------------|--------|
| Plans go in `claude-info/plans` | Plan is at `claude-info/plans/2026-04-12-syntaur-desktop-app.md` | PASS |
| Avoid unnecessary preamble | Plan is structured and direct | PASS |
| Do not use `.claude/plans` | Correct directory used | PASS |

**Codebase pattern compliance:**

| Pattern | Codebase Convention | Plan Approach | Status |
|---------|-------------------|---------------|--------|
| Server creation | `dashboardCommand()` reads config, resolves dirs, finds port, creates server | Plan reimplements same pattern | PASS |
| Path utilities | `syntaurRoot()`, `defaultMissionDir()`, etc. from `paths.ts` | Reimplemented locally (correct) | PASS |
| Error handling | Try/catch with descriptive messages | Plan includes error handling tables per task | PASS |
| Dependency version | Plan says pin exactly in risk table | Changed from `^0.1.8` to `0.1.8` (FIXED) | PASS |

**Violations found and fixed:** Dependency pinning contradiction.

### Pass 5: Simplicity -- PASS

**File change count:** 15 files (14 new in syntaur-app, 1 modified in syntaur repo)
**Unnecessary changes found:** None -- every file is necessary for the Electron Forge Vite plugin setup.
**Over-engineering found:** None -- the plan uses the simplest possible architecture (thin Electron shell over existing Express server).
**Simplification suggestions:** None. The renderer/index.html could theoretically be eliminated but the Forge Vite plugin requires them.

### External Reviews

#### Review 1: feature-dev:code-reviewer
**Verdict:** SKIPPED
**Reason:** Task/subagent tool not available in this environment.

#### Review 2: superpowers:code-reviewer
**Verdict:** SKIPPED
**Reason:** Task/subagent tool not available in this environment.

#### Review 3: Codex CLI (gpt-5.4, default model)
**Verdict:** NEEDS FIXES -> FIXED
**Key Feedback:**
- Critical: `__dirname` in ESM context -- Codex flagged `resolve(__dirname, 'preload.js')` as broken in ESM. **Response:** This is actually correct for Electron Forge Vite plugin which builds main process as CJS, providing `__dirname`. Added clarifying comment.
- Critical: Windows release/signing does not meet stated requirements. **Response:** The plan already notes Windows signing is optional (can ship unsigned initially). This is acceptable for an MVP. No change needed -- the plan's stated posture is explicit.
- Important: Renderer/index.html are dead code since `loadURL()` bypasses them. **Response:** Agreed -- added explicit documentation that they exist to satisfy Forge Vite plugin requirements.
- Important: tsconfig doesn't cover top-level config files. **Response:** This is inherent to Electron Forge projects where Vite handles compilation. `tsc --noEmit` for type-checking `src/` is the standard pattern. forge.config.ts is checked at runtime by Forge. No change needed.
- Important: Dependency pinning contradicts risk table. **Response:** Fixed -- changed to exact version `0.1.8`.
- Important: First-run behavior unresolved. **Response:** Fixed -- added directory creation logic to `launchApp()`.
- Minor: `sessions.db` vs `syntaur.db`. **Response:** Fixed.
- Minor: `sandbox: false` contradicts risk table. **Response:** Fixed -- updated risk table to match implementation rationale.

**Changes Made Based on External Feedback:**
1. Fixed dependency pinning: `^0.1.8` -> `0.1.8`
2. Added first-run directory creation in `launchApp()`
3. Fixed `sessions.db` -> `syntaur.db`
4. Updated risk table sandbox guidance to match implementation
5. Added clarifying comment about `__dirname` availability in Forge Vite context
6. Added documentation about renderer/index.html being Forge plugin requirements

**Feedback Disagreed With (and why):**
- Windows signing completeness: The plan's stated posture explicitly says unsigned is acceptable initially. This is a valid MVP approach and the plan documents it transparently.
- tsconfig not covering config files: Standard Electron Forge pattern. Config files are validated at runtime by Forge, not by tsc.

**Remaining concerns:**
1. Task 0 (fixing `packageRoot` in syntaur) must be completed and a new syntaur version published BEFORE the Electron app can work. This is a hard dependency.
2. Windows auto-update requires the Squirrel `RELEASES` artifact — now uploaded in the Windows CI workflow (fixed). Verify during Task 10.8 testing.
3. The `existsSync` import used in the Task 0 fix and first-run logic needs to be added to the import list in `main.ts` (already imported via `import { existsSync } from 'node:fs'` on line 675).

### Post-Review Codex Re-Review (2026-04-13)

Applied fixes for all issues found by Codex gpt-5.4 independent review:

| Issue | Category | Fix Applied |
|-------|----------|-------------|
| Windows signing not wired in MakerSquirrel | Completeness | Added conditional `certificateFile`/`certificatePassword` to MakerSquirrel config |
| No icon assets task | Completeness | Added `assets/` to file inventory, added Task 1b reference in dependency graph |
| Task 1 pins `0.1.8` but Task 0 publishes new version | Completeness/Ordering | Changed to `<version-after-task-0>` placeholder with explanation |
| First-run only creates dirs, not full init | Completeness | Narrowed success criteria; app creates dirs but directs user to `npx syntaur init` for full setup |
| `readMissionsDir` doesn't validate absolute paths | Accuracy | Added `isAbsolute` check matching `config.ts:458-463` behavior |
| Loading shell color references App.tsx (wrong) | Accuracy | Fixed proof block to reference `globals.css:7`, changed color from `#0f172a` to `#0a0a0a` |
| No try/catch around `launchApp()` | Gaps | Added try/catch with `dialog.showErrorBox` and `app.quit()` |
| Custom missionsDir not ensured to exist | Gaps | Added `existsSync`/`mkdirSync` for resolved `missionsDir` after config read |
| Windows CI missing RELEASES artifact | Gaps | Added `out/make/**/RELEASES` to upload glob |
| Task 2 verification runs before source files exist | Ordering | Changed to config-only tsc check, deferred full verification |
| Tasks 3/4/5 marked parallel but 3 depends on 4+5 | Ordering | Reordered: 4+5 first (parallel), then 3. Updated dependency graph. |
| Missing test cases (first-run, custom dir, RELEASES) | Gaps | Added Steps 10.6, 10.7, 10.8 with verification commands |

### Second Codex Re-Review (2026-04-13, pass 2)

All 5 criteria failed again. Applied fixes:

| Issue | Category | Fix Applied |
|-------|----------|-------------|
| Task 1b referenced but no body | Completeness/Detail | Added full Task 1b section with 3 steps for PNG/ICNS/ICO generation |
| First-run contradicts success criteria | Completeness/Gaps | Unified: app does full `syntaur init` bootstrap (dirs + config.md + playbook seeding) |
| Naive regex parser doesn't strip quotes | Accuracy/Detail | Replaced with full `parseFrontmatter()` copy from config.ts:71-96 |
| `readMissionsDir` silently swallows malformed config | Gaps | Added warning log + fallback matching config.ts:450-453 |
| Step 6.2 (repository field) after Step 6.1 (verify) | Ordering | Swapped order: 6.1 adds field, 6.2 verifies integration |
| Preload path contract undocumented | Detail | Added comment block explaining Forge Vite plugin output convention |
| Line count discrepancies (31→33, 449→448) | Accuracy | Fixed to actual `wc -l` values |
| "exports" wording implies package export | Accuracy | Reworded to "deep import" with note about no `exports` map |
| Step 10.6 ambiguous acceptance criteria | Detail | Made deterministic: "dashboard loads in empty state" + specific file checks |
| Windows parity not scoped | Gaps | Added explicit success criterion noting autodiscovery limitation |

### Third Codex Re-Review (2026-04-13, pass 3)

All 5 criteria failed. Applied fixes:

| Issue | Category | Fix Applied |
|-------|----------|-------------|
| No playbook manifest rebuild in bootstrap | Completeness | Added `rebuildPlaybookManifest()` call after seeding |
| `package-lock.json` missing from plan | Completeness | Added Step 1.3 to generate lockfile; added to file inventory |
| No Windows runtime smoke test | Completeness | Documented as Windows parity limitation in success criteria |
| `<version-after-task-0>` ambiguous | Detail | Made Step 0.2 explicit: `npm version patch`, `npm publish`, record version |
| Step 0.2 vague about commands | Detail | Added exact `npm run build/typecheck/test/version/publish` sequence |
| Step 1b.3 allows "online converter" | Detail | Restricted to ImageMagick only |
| Step 7.1 unclear merge vs replace | Detail | Clarified: "append `postinstall` to existing `scripts`" |
| Config template doesn't match `renderConfig` | Accuracy | Replaced with exact output from `src/templates/config.ts:5-24` |
| `require.resolve` in ESM context | Accuracy | Changed to `createRequire(import.meta.url)` pattern |
| Step 10.5 hardcodes port 4800 | Accuracy | Changed to read actual port from `~/.syntaur/dashboard-port` |
| Task 0 missing `npm run typecheck` | Gaps | Added to verification and completion criteria |
| Task 0 missing static-serving smoke test | Gaps | Added to completion criteria |
| Task 7 after Task 3 launch verification | Ordering | Moved Task 7 before Tasks 4/5/3 in implementation order |
| Task 1b missing from numbered order | Ordering | Added to implementation order after Task 1 |
| Lockfile must precede CI tasks | Ordering | Step 1.3 generates it; Tasks 8/9 depend on Task 1 |

## Next Steps

This plan is ready for implementation. You can:
- Use `superpowers:executing-plans` to implement with review checkpoints
- Run `/sun-tzu-implement [this plan path]` for guided implementation
- Implement manually following the task order above

**Start with Task 0** in the syntaur repo first, then proceed to the syntaur-app repo for Tasks 1-10.
