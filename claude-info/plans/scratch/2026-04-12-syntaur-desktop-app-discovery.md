# Syntaur Desktop App (Electron) -- Discovery Findings

## Metadata
- **Date:** 2026-04-12
- **Complexity:** large
- **Tech Stack:** TypeScript, Electron, Electron Forge (Vite plugin), React (via embedded Syntaur dashboard)

## Objective
Build a standalone Electron desktop app (`syntaur-app`) that wraps the existing Syntaur dashboard (Express + WebSocket backend serving a React SPA) into a native desktop application with packaging, auto-updates, and native OS integration.

## User's Request
Create a new repo at `git@github.com:prong-horn/syntaur-app.git` containing an Electron app that:
1. Spawns the Express server from the `syntaur` npm package in the main process
2. Opens a BrowserWindow pointing at the local server
3. Uses Electron Forge with the Vite plugin (MCPJam Inspector pattern)
4. Packages as .dmg (Mac) and .exe (Windows)
5. Supports auto-updates via `update-electron-app`
6. Has GitHub Actions for automated builds and notarization
7. Feels native: menu bar, dock icon, window management

## Codebase Overview

### Syntaur Dashboard Architecture
The existing dashboard has two parts:

**Backend** (`src/dashboard/server.ts`):
- `createDashboardServer(options)` creates an Express + HTTP server
- WebSocket on `/ws` path (noServer mode, manual upgrade)
- API routes all under `/api/*` (missions, assignments, workspaces, servers, agent-sessions, playbooks, todos, config)
- Static file serving from `dashboard/dist/` with SPA fallback when `serveStaticUi: true`
- File watcher via chokidar for real-time updates (missions, assignments, servers, playbooks, todos directories)
- SQLite session database via `better-sqlite3` (native module -- requires Electron rebuild)
- Autodiscovery of tmux sessions and listening processes
- Port file written to `~/.syntaur/dashboard-port`
- Default port: 4800

**Frontend** (`dashboard/`):
- React 18 + Vite 6 SPA
- Tailwind CSS 3 for styling
- React Router DOM 7 for client-side routing
- All API calls use relative URLs (`/api/...`) -- works naturally with the embedded server
- WebSocket connects to `ws://hostname:port/ws` derived from `window.location`
- In dev mode, Vite proxies `/api` to the Express backend port via `VITE_API_PORT` env var
- Build output: `dashboard/dist/` (index.html + assets/)

**Key Dependencies (native/special)**:
- `better-sqlite3` -- native C++ addon, needs electron-rebuild
- `chokidar` -- file watching, works fine in Electron
- `express` -- HTTP server
- `ws` -- WebSocket server

**Package Exports**:
- `createDashboardServer` and `DashboardServerOptions` are exported from `src/dashboard/index.ts`
- `dist/dashboard/server.js` is a separate entry in the tsup build
- `dashboard/dist/` (static React build) is included in npm `files` field

### How the Dashboard Server is Configured
From `src/commands/dashboard.ts`:
- Reads config from `~/.syntaur/config.md` for `defaultMissionDir`
- Uses utility functions for other dirs: `serversDir()`, `assignmentsDir()`, `playbooksDir()`, `todosDir()`
- All dirs resolve under `~/.syntaur/`
- Port auto-selection starts at 4800, tries up to 20 ports

### MCPJam Inspector Pattern (Reference Implementation)
From the MCPJam Inspector repo:

**forge.config.ts**:
- Vite plugin with main, preload, and renderer entries
- Makers: MakerSquirrel (Windows), MakerZIP (Mac/Linux), MakerDMG (Mac), MakerDeb, MakerRpm
- macOS code signing via `MAC_CODESIGN_IDENTITY` env var
- Apple notarization via ASC API key or App-specific password
- Fuses plugin for security hardening (disable node options, CLI inspect, enable ASAR integrity)
- Unpacks .node native modules before signing

**main.ts**:
- Starts embedded Hono server on a port, opens BrowserWindow pointing at `http://127.0.0.1:{port}`
- In dev: loads from `MAIN_WINDOW_VITE_DEV_SERVER_URL`
- Window: 1400x900, min 800x600, contextIsolation: true, nodeIntegration: false
- Preload script for IPC bridge
- Single instance lock to prevent multiple windows
- macOS activate handler for dock re-open
- Custom protocol handler for OAuth
- Auto-updater integration

**GitHub Actions**:
- Separate workflows for mac-release.yml and windows-release.yml
- Mac: triggers on v* tags or manual dispatch, sets up keychain + certificate, runs electron:make, notarizes DMG+ZIP, creates GitHub release
- Windows: triggers on v* tags or manual dispatch, rebuilds native modules, code signs with PFX cert, creates release

## Files That Will Need to Be Created (New Repo)

| File | Purpose | Description |
|------|---------|-------------|
| `package.json` | Project manifest | Electron + Forge deps, scripts, syntaur as dependency |
| `tsconfig.json` | TypeScript config | For main + preload processes |
| `forge.config.ts` | Electron Forge config | Makers, plugins (Vite), signing, notarization |
| `src/main.ts` | Electron main process | Spawn Express server, create BrowserWindow, menu, lifecycle |
| `src/preload.ts` | Preload script | IPC bridge for window management, app info |
| `src/renderer.ts` | Renderer entry | Loads the dashboard URL in the window |
| `src/menu.ts` | Application menu | Native menu bar with standard items |
| `vite.main.config.ts` | Vite config for main | Build config for main process |
| `vite.preload.config.ts` | Vite config for preload | Build config for preload script |
| `vite.renderer.config.ts` | Vite config for renderer | Build config for renderer (minimal) |
| `index.html` | Renderer HTML | Simple page that loads from Express server |
| `.github/workflows/mac-release.yml` | Mac CI/CD | Build, sign, notarize, release DMG |
| `.github/workflows/windows-release.yml` | Windows CI/CD | Build, sign, release EXE |
| `.gitignore` | Git ignore | Standard Node + Electron ignores |
| `README.md` | Documentation | Setup, build, release instructions |

## Patterns Discovered

| Pattern | Reference File | Description |
|---------|---------------|-------------|
| Embedded HTTP server | MCPJam `src/main.ts` | Start HTTP server in main process, point BrowserWindow at localhost URL |
| Relative API URLs | `dashboard/src/hooks/useMissions.ts` | Frontend uses `/api/...` paths, works with same-origin server |
| WebSocket connection | `dashboard/src/hooks/useWebSocket.ts` | Derives WS URL from `window.location`, connects to `/ws` |
| Static SPA serving | `src/dashboard/server.ts` lines 337-353 | Express serves `dashboard/dist/` with SPA fallback |
| Native module handling | MCPJam `forge.config.ts` | Unpack `.node` files before signing, rebuild for Electron |
| Electron Forge Vite | MCPJam `forge.config.ts` | VitePlugin with main/preload/renderer build configs |
| Auto-updates | MCPJam `src/main.ts` | `update-electron-app` for Squirrel-based updates |
| Code signing/notarization | MCPJam `.github/workflows/` | Platform-specific CI workflows with cert/key management |
| Config resolution | `src/utils/paths.ts` | All paths derive from `~/.syntaur/` using `os.homedir()` |

## CLAUDE.md Rules Found
No CLAUDE.md files found in the syntaur repo. User's global CLAUDE.md rules:
- Plans go in `claude-info/plans` directory, tracked by git
- Avoid restating the question; get to the point
- Do not use `.claude/plans`

## Questions & Considerations

| Question | Status |
|----------|--------|
| Import syntaur as npm dep vs bundle files? | Recommended: npm dependency, call `createDashboardServer()` directly |
| How to handle better-sqlite3 native module in Electron? | Need `@electron/rebuild` or electron-rebuild in postinstall; unpack .node in forge config |
| Port selection in Electron? | Use port 0 (random OS-assigned) or start at 4800 with auto-increment, same as CLI |
| Should renderer load from localhost URL or serve React app differently? | Load from `http://127.0.0.1:{port}` same as MCPJam pattern. In dev, use Vite dev server URL. |
| Dashboard config (missionsDir, etc.)? | Use same `readConfig()` and path utilities from syntaur package |
| Menu bar design? | Standard Electron menu: File, Edit, View, Window, Help. Add Syntaur-specific items. |
| App icon? | Need to create or derive from existing favicon SVG |
| Windows code signing certificate? | User needs to provide or skip initially |
| Apple Developer credentials for notarization? | User needs to provide ASC API key or App-specific password |

## Exploration Log

| Explorer | Focus Area | Key Findings |
|----------|-----------|--------------|
| Direct Read | Dashboard server (`src/dashboard/server.ts`) | Express + WS server, exported as `createDashboardServer()`, serves static React build, all paths from `~/.syntaur/`, uses better-sqlite3 |
| Direct Read | Dashboard command (`src/commands/dashboard.ts`) | Port 4800 default, auto-port selection, config-based dirs, dev/static/server-only modes |
| Direct Read | Dashboard frontend (`dashboard/`) | React 18 + Vite 6 + Tailwind, relative API URLs, WebSocket from location, BrowserRouter SPA |
| Direct Read | Package.json + tsup config | `syntaur` npm package exports dist/ + dashboard/dist/, better-sqlite3 external, ESM |
| Direct Read | Config & paths | All dirs under `~/.syntaur/`, config from `config.md` frontmatter |
| WebFetch | MCPJam Inspector package.json | Electron Forge 7.11.1, Vite 7.1.4, 50+ deps, multiple makers |
| WebFetch | MCPJam Inspector forge.config.ts | Vite plugin, 5 makers, signing+notarization, Fuses, native module unpacking |
| WebFetch | MCPJam Inspector main.ts | Embedded Hono server, BrowserWindow 1400x900, single instance, auto-updates |
| WebFetch | MCPJam Inspector preload.ts | contextBridge API for version, window mgmt, file ops, updates |
| WebFetch | MCPJam Inspector CI workflows | Separate mac-release.yml and windows-release.yml, keychain setup, notarization, GitHub releases |

## Architecture Decision: How the Electron App Wraps Syntaur

The recommended architecture:

1. **`syntaur` as npm dependency**: The Electron app depends on the `syntaur` npm package. This gives access to `createDashboardServer()` and all the static dashboard build files.

2. **Main process flow**:
   - Import `createDashboardServer` from `syntaur/dashboard`
   - Import path utilities from `syntaur` for resolving `~/.syntaur/` dirs
   - Find an available port (start at 4800)
   - Call `createDashboardServer({ port, missionsDir, ..., serveStaticUi: true })`
   - Call `server.start()`
   - Create BrowserWindow pointing at `http://127.0.0.1:{port}`
   - Set up auto-updates, native menu, tray icon

3. **Native module concern**: `better-sqlite3` is a C++ addon that must be rebuilt for Electron's Node version. This requires:
   - `@electron/rebuild` in devDependencies
   - A postinstall script or forge hook to rebuild native modules
   - forge.config.ts must unpack `.node` files from ASAR for code signing

4. **Dev workflow**: In development, the Vite plugin handles HMR for the main process. The renderer loads from the Express server's localhost URL (not a Vite dev server for the React app, since the React app is served by Express).

## Key Risks

1. **Native module rebuilding**: `better-sqlite3` needs careful handling. Must rebuild for Electron's Node version, and the `.node` binary must be unpacked from ASAR before macOS code signing.

2. **Package resolution**: The `syntaur` package uses `import.meta.url` to find `dashboard/dist/`. When consumed as a dependency inside an Electron app's ASAR, path resolution may break. May need to configure forge to unpack the entire `syntaur` module from ASAR.

3. **File system access**: The dashboard watches `~/.syntaur/` directories with chokidar. This should work fine in Electron since the main process has full Node.js access, but ASAR-packed paths could interfere with `better-sqlite3` database file access.

4. **Cross-platform paths**: `os.homedir()` works correctly on all platforms, but the tmux autodiscovery and `lsof` commands are macOS/Linux-specific. Windows users won't get server tracking.
