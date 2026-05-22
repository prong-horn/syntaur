import express from 'express';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { syntaurRoot } from '../utils/paths.js';
import { WebSocketServer, WebSocket } from 'ws';
import {
  listProjects,
  listAssignmentsBoard,
  listAllMemories,
  listAllResources,
  getProjectDetail,
  getAssignmentDetail,
  getAssignmentDetailById,
  getOverview,
  getHelp,
  listWorkspaces,
  createWorkspace,
  deleteWorkspace,
  WorkspaceBlockedError,
} from './api.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';
import { listSessionsByAssignment, reconcileActiveSessions } from './agent-sessions.js';
import { enrichSessions } from './session-liveness.js';
import { createWatcher } from './watcher.js';
import { fileExists } from '../utils/fs.js';
import {
  writeThemeConfig,
  deleteThemeConfig,
  writeHotkeyBindingsConfig,
  deleteHotkeyBindingsConfig,
  readConfig,
  getAgents,
} from '../utils/config.js';
import {
  BINDABLE_ACTION_KINDS,
  canonicalizeCombo,
  isBindableActionKind,
  isReservedCombo,
  type BindableActionKind,
} from '../utils/hotkeysCatalog.js';
import {
  isViewMode,
  isSortField,
  isSortDirection,
  isDensity,
  isGrouping,
  isActivity,
  isFilterString,
  type ViewPrefs,
  type ProjectViewPrefs,
  type ViewFilters,
  type ViewPrefsPatch,
} from '../utils/view-prefs-schema.js';
import {
  readViewPrefsFile,
  applyViewPrefsPatch,
  resetViewPrefsFile,
  isViewPrefsDefaults,
} from '../utils/view-prefs.js';
import { createSavedViewsRouter, createDashboardLayoutRouter } from './api-saved-views.js';
import { withLock } from './todos-locks.js';
import { createWriteRouter } from './api-write.js';
import { createServersRouter } from './api-servers.js';
import { createAgentSessionsRouter } from './api-agent-sessions.js';
import { createAgentsRouter } from './api-agents.js';
import { createLaunchPreflightRouter } from './api-launch-preflight.js';
import { createTerminalConfigRouter } from './api-terminal-config.js';
import { createStatusConfigRouter } from './api-status-config.js';
import { createLeasesRouter } from './api-leases.js';
import { createUsageRouter } from './api-usage.js';
import { createPlaybooksRouter } from './api-playbooks.js';
import {
  migrateLegacyProjectFiles,
  migrateLegacyConfig,
  summarizeMigration,
} from '../utils/fs-migration.js';
import { createTodosRouter } from './api-todos.js';
import { createProjectTodosRouter } from './api-project-todos.js';
import { createBundlesRouter } from './api-bundles.js';
import { createProjectBundlesRouter } from './api-project-bundles.js';
import { createBackupRouter } from './api-backup.js';
import { initSessionDb, migrateFromMarkdown, closeSessionDb } from './session-db.js';
import { initLeasesDb, closeLeasesDb } from '../db/leases-db.js';
import { initUsageDb, closeUsageDb } from '../db/usage-db.js';
import { startAutodiscovery, stopAutodiscovery } from './autodiscovery.js';
import type { WsMessage } from './types.js';

export interface DashboardServerOptions {
  port: number;
  projectsDir: string;
  /**
   * Absolute path to the standalone assignments directory (`~/.syntaur/assignments/`).
   * Standalone assignments have `project: null` and live in folders named by UUID.
   */
  assignmentsDir: string;
  serversDir: string;
  playbooksDir: string;
  todosDir: string;
  serveStaticUi: boolean;
  /** Absolute path to the built dashboard UI (dashboard/dist). Required when serveStaticUi is true. */
  dashboardDistPath?: string;
}

export function createDashboardServer(options: DashboardServerOptions) {
  const { port, projectsDir, assignmentsDir, serversDir, playbooksDir, todosDir, serveStaticUi, dashboardDistPath } = options;
  const app = express();
  const server = createServer(app);

  // --- WebSocket ---
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    const connectMsg: WsMessage = {
      type: 'connected',
      timestamp: new Date().toISOString(),
    };
    ws.send(JSON.stringify(connectMsg));

    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  function broadcast(message: WsMessage): void {
    const data = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  // --- Initialize session database ---
  initSessionDb();
  migrateFromMarkdown(projectsDir).catch((err) => {
    console.error('Session migration from markdown failed:', err);
  });

  // --- Initialize leases database (shares syntaur.db) ---
  initLeasesDb();

  // --- Initialize usage database (shares syntaur.db) ---
  initUsageDb();

  // --- One-shot legacy filesystem migration (pre-v0.2.0 → v0.2.0+) ---
  // Idempotent, non-destructive, reports what it did. Run in the background
  // so startup isn't gated on filesystem work.
  (async () => {
    try {
      const configResult = await migrateLegacyConfig(
        resolve(syntaurRoot(), 'config.md'),
      );
      const projectResult = await migrateLegacyProjectFiles(projectsDir);
      const summary = summarizeMigration(projectResult, configResult);
      if (summary) console.log(summary);
    } catch (err) {
      console.error('Legacy filesystem migration failed:', err);
    }
  })();

  // --- JSON body parsing ---
  app.use(express.json());

  // --- API Routes ---
  app.get('/api/overview', async (req, res) => {
    try {
      const staleLimitRaw = req.query.staleLimit;
      const staleOffsetRaw = req.query.staleOffset;
      const staleLimit = typeof staleLimitRaw === 'string' ? Number(staleLimitRaw) : undefined;
      const staleOffset = typeof staleOffsetRaw === 'string' ? Number(staleOffsetRaw) : undefined;
      const overview = await getOverview(projectsDir, serversDir, assignmentsDir, {
        staleLimit,
        staleOffset,
      });
      res.json(overview);
    } catch (error) {
      console.error('Error getting overview:', error);
      res.status(500).json({ error: 'Failed to get overview' });
    }
  });

  app.get('/api/help', async (_req, res) => {
    try {
      const help = await getHelp();
      res.json(help);
    } catch (error) {
      console.error('Error getting help content:', error);
      res.status(500).json({ error: 'Failed to get help content' });
    }
  });

  app.use('/api/config/statuses', createStatusConfigRouter(projectsDir, assignmentsDir));

  // Theme presets — keep in sync with PRESETS in dashboard/src/themes.ts (canonical client list).
  const THEME_PRESET_SLUGS = ['default', 'ocean', 'forest', 'sunset'] as const;
  const DEFAULT_THEME_PRESET = 'default';

  app.get('/api/config/theme', async (_req, res) => {
    try {
      const config = await readConfig();
      const preset = config.theme?.preset ?? DEFAULT_THEME_PRESET;
      res.json({ preset, custom: config.theme !== null });
    } catch (error) {
      console.error('Error getting theme config:', error);
      res.status(500).json({ error: 'Failed to get theme config' });
    }
  });

  app.post('/api/config/theme', async (req, res) => {
    try {
      const { preset } = req.body ?? {};
      if (typeof preset !== 'string' || !(THEME_PRESET_SLUGS as readonly string[]).includes(preset)) {
        res.status(400).json({
          error: `preset must be one of: ${THEME_PRESET_SLUGS.join(', ')}`,
        });
        return;
      }
      await writeThemeConfig({ preset });
      res.json({ preset, custom: true });
    } catch (error) {
      console.error('Error saving theme config:', error);
      res.status(500).json({ error: 'Failed to save theme config' });
    }
  });

  app.delete('/api/config/theme', async (_req, res) => {
    try {
      await deleteThemeConfig();
      res.json({ preset: DEFAULT_THEME_PRESET, custom: false });
    } catch (error) {
      console.error('Error resetting theme config:', error);
      res.status(500).json({ error: 'Failed to reset theme config' });
    }
  });

  app.use('/api/config/terminal', createTerminalConfigRouter());

  app.get('/api/config/hotkeys', async (_req, res) => {
    try {
      const config = await readConfig();
      const bindings = config.hotkeys?.bindings ?? {};
      res.json({ bindings, custom: config.hotkeys !== null });
    } catch (error) {
      console.error('Error getting hotkeys config:', error);
      res.status(500).json({ error: 'Failed to get hotkeys config' });
    }
  });

  app.put('/api/config/hotkeys', async (req, res) => {
    try {
      const raw = (req.body && typeof req.body === 'object' ? req.body : {}) as {
        bindings?: unknown;
      };
      const incoming = raw.bindings;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        res.status(400).json({ error: 'bindings must be an object keyed by action kind' });
        return;
      }
      const cleaned: Partial<Record<BindableActionKind, string>> = {};
      for (const [rawKind, rawValue] of Object.entries(incoming as Record<string, unknown>)) {
        if (!isBindableActionKind(rawKind)) {
          res.status(400).json({
            error: `unknown action kind "${rawKind}" — expected one of: ${BINDABLE_ACTION_KINDS.join(', ')}`,
          });
          return;
        }
        if (typeof rawValue !== 'string' || rawValue.trim() === '') {
          res.status(400).json({ error: `binding for "${rawKind}" must be a non-empty string` });
          return;
        }
        const canonical = canonicalizeCombo(rawValue);
        if (!canonical) {
          res.status(400).json({ error: `binding for "${rawKind}" is not a valid combo` });
          return;
        }
        if (isReservedCombo(canonical)) {
          res.status(400).json({
            error: `combo "${canonical}" is reserved by a built-in shortcut`,
            kind: rawKind,
            combo: canonical,
          });
          return;
        }
        cleaned[rawKind] = canonical;
      }
      // Detect duplicate combos across kinds.
      const seenCombos = new Map<string, BindableActionKind>();
      for (const [kind, combo] of Object.entries(cleaned) as Array<[BindableActionKind, string]>) {
        if (seenCombos.has(combo)) {
          res.status(400).json({
            error: `combo "${combo}" is bound to multiple actions`,
            kinds: [seenCombos.get(combo), kind],
          });
          return;
        }
        seenCombos.set(combo, kind);
      }

      await writeHotkeyBindingsConfig({ bindings: cleaned });
      res.json({ bindings: cleaned, custom: Object.keys(cleaned).length > 0 });
    } catch (error) {
      console.error('Error saving hotkeys config:', error);
      res.status(500).json({ error: 'Failed to save hotkeys config' });
    }
  });

  app.delete('/api/config/hotkeys', async (_req, res) => {
    try {
      await deleteHotkeyBindingsConfig();
      res.json({ bindings: {}, custom: false });
    } catch (error) {
      console.error('Error resetting hotkeys config:', error);
      res.status(500).json({ error: 'Failed to reset hotkeys config' });
    }
  });

  const VIEW_PREFS_LOCK = 'vp:global';

  const FILTER_KEYS = new Set(['status', 'priority', 'assignee', 'project', 'activity']);
  const GLOBAL_KEYS = new Set(['defaultView', 'sortField', 'sortDirection', 'density', 'grouping', 'filters']);
  const SCOPE_KEYS = new Set(['defaultView', 'sortField', 'sortDirection', 'grouping', 'filters']);
  const ROOT_KEYS = new Set(['global', 'projects']);

  function unknownKey(obj: Record<string, unknown>, allowed: Set<string>, where: string): string | null {
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) return `unknown key "${key}" in ${where}`;
    }
    return null;
  }

  function validateFilters(value: unknown): { ok: true; value: ViewFilters } | { ok: false; error: string } {
    if (value === undefined) return { ok: true, value: {} };
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'filters must be an object' };
    }
    const obj = value as Record<string, unknown>;
    const unknown = unknownKey(obj, FILTER_KEYS, 'filters');
    if (unknown) return { ok: false, error: unknown };
    const out: ViewFilters = {};
    for (const key of ['status', 'priority', 'assignee', 'project']) {
      if (obj[key] !== undefined) {
        if (!isFilterString(obj[key])) return { ok: false, error: `filters.${key} must be a non-empty string` };
        (out as Record<string, string>)[key] = obj[key] as string;
      }
    }
    if (obj.activity !== undefined) {
      if (!isActivity(obj.activity)) return { ok: false, error: 'filters.activity invalid' };
      out.activity = obj.activity;
    }
    return { ok: true, value: out };
  }

  function validateGlobalPatch(value: unknown): { ok: true; value: Partial<ViewPrefs> } | { ok: false; error: string } {
    if (value === undefined) return { ok: true, value: {} };
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'global must be an object' };
    }
    const obj = value as Record<string, unknown>;
    const unknown = unknownKey(obj, GLOBAL_KEYS, 'global');
    if (unknown) return { ok: false, error: unknown };
    const out: Partial<ViewPrefs> = {};
    if (obj.defaultView !== undefined) {
      if (!isViewMode(obj.defaultView)) return { ok: false, error: 'global.defaultView invalid' };
      out.defaultView = obj.defaultView;
    }
    if (obj.sortField !== undefined) {
      if (!isSortField(obj.sortField)) return { ok: false, error: 'global.sortField invalid' };
      out.sortField = obj.sortField;
    }
    if (obj.sortDirection !== undefined) {
      if (!isSortDirection(obj.sortDirection)) return { ok: false, error: 'global.sortDirection invalid' };
      out.sortDirection = obj.sortDirection;
    }
    if (obj.density !== undefined) {
      if (!isDensity(obj.density)) return { ok: false, error: 'global.density invalid' };
      out.density = obj.density;
    }
    if (obj.grouping !== undefined) {
      if (!isGrouping(obj.grouping)) return { ok: false, error: 'global.grouping invalid' };
      out.grouping = obj.grouping;
    }
    if (obj.filters !== undefined) {
      const f = validateFilters(obj.filters);
      if (!f.ok) return f;
      out.filters = f.value;
    }
    return { ok: true, value: out };
  }

  function validateScopePatch(value: unknown): { ok: true; value: ProjectViewPrefs } | { ok: false; error: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'project scope must be an object' };
    }
    const obj = value as Record<string, unknown>;
    if (obj.density !== undefined) {
      return { ok: false, error: 'density cannot be set per-project (global only)' };
    }
    const unknown = unknownKey(obj, SCOPE_KEYS, 'project scope');
    if (unknown) return { ok: false, error: unknown };
    const out: ProjectViewPrefs = {};
    if (obj.defaultView !== undefined) {
      if (!isViewMode(obj.defaultView)) return { ok: false, error: 'defaultView invalid' };
      out.defaultView = obj.defaultView;
    }
    if (obj.sortField !== undefined) {
      if (!isSortField(obj.sortField)) return { ok: false, error: 'sortField invalid' };
      out.sortField = obj.sortField;
    }
    if (obj.sortDirection !== undefined) {
      if (!isSortDirection(obj.sortDirection)) return { ok: false, error: 'sortDirection invalid' };
      out.sortDirection = obj.sortDirection;
    }
    if (obj.grouping !== undefined) {
      if (!isGrouping(obj.grouping)) return { ok: false, error: 'grouping invalid' };
      out.grouping = obj.grouping;
    }
    if (obj.filters !== undefined) {
      const f = validateFilters(obj.filters);
      if (!f.ok) return f;
      out.filters = f.value;
    }
    return { ok: true, value: out };
  }

  function validateViewPrefsPatch(body: unknown): { ok: true; value: ViewPrefsPatch } | { ok: false; error: string } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, error: 'body must be an object with optional `global` and/or `projects` keys' };
    }
    const obj = body as Record<string, unknown>;
    const unknownRoot = unknownKey(obj, ROOT_KEYS, 'request body');
    if (unknownRoot) return { ok: false, error: unknownRoot };
    const patch: ViewPrefsPatch = {};
    const g = validateGlobalPatch(obj.global);
    if (!g.ok) return g;
    if (Object.keys(g.value).length > 0) patch.global = g.value;
    if (obj.projects !== undefined) {
      if (!obj.projects || typeof obj.projects !== 'object' || Array.isArray(obj.projects)) {
        return { ok: false, error: 'projects must be an object keyed by scope' };
      }
      const projectsOut: Record<string, ProjectViewPrefs> = {};
      for (const [scope, scopePatch] of Object.entries(obj.projects as Record<string, unknown>)) {
        if (typeof scope !== 'string' || scope.length === 0) {
          return { ok: false, error: 'project scope keys must be non-empty strings' };
        }
        const sp = validateScopePatch(scopePatch);
        if (!sp.ok) return { ok: false, error: `projects["${scope}"]: ${sp.error}` };
        projectsOut[scope] = sp.value;
      }
      if (Object.keys(projectsOut).length > 0) patch.projects = projectsOut;
    }
    return { ok: true, value: patch };
  }

  app.get('/api/view-prefs', async (_req, res) => {
    try {
      const file = await readViewPrefsFile();
      res.json({ ...file, custom: !isViewPrefsDefaults(file) });
    } catch (error) {
      console.error('Error reading view-prefs:', error);
      res.status(500).json({ error: 'Failed to read view-prefs' });
    }
  });

  app.post('/api/view-prefs', async (req, res) => {
    const result = validateViewPrefsPatch(req.body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    try {
      const file = await withLock(VIEW_PREFS_LOCK, () => applyViewPrefsPatch(result.value));
      res.json({ ...file, custom: !isViewPrefsDefaults(file) });
    } catch (error) {
      console.error('Error saving view-prefs:', error);
      res.status(500).json({ error: 'Failed to save view-prefs' });
    }
  });

  app.delete('/api/view-prefs', async (_req, res) => {
    try {
      await withLock(VIEW_PREFS_LOCK, () => resetViewPrefsFile());
      const file = await readViewPrefsFile();
      res.json({ ...file, custom: false });
    } catch (error) {
      console.error('Error resetting view-prefs:', error);
      res.status(500).json({ error: 'Failed to reset view-prefs' });
    }
  });

  app.use('/api/saved-views', createSavedViewsRouter());
  app.use('/api/dashboard', createDashboardLayoutRouter());

  app.get('/api/projects', async (req, res) => {
    try {
      let projects = await listProjects(projectsDir);
      const workspaceParam = req.query.workspace as string | undefined;
      if (workspaceParam) {
        if (workspaceParam === '_ungrouped') {
          projects = projects.filter((m) => m.workspace === null);
        } else {
          projects = projects.filter((m) => m.workspace === workspaceParam);
        }
      }
      res.json(projects);
    } catch (error) {
      console.error('Error listing projects:', error);
      res.status(500).json({ error: 'Failed to list projects' });
    }
  });

  app.get('/api/workspaces', async (_req, res) => {
    try {
      const result = await listWorkspaces(projectsDir, assignmentsDir);
      res.json(result);
    } catch (error) {
      console.error('Error listing workspaces:', error);
      res.status(500).json({ error: 'Failed to list workspaces' });
    }
  });

  app.post('/api/workspaces', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name || typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        res.status(400).json({ error: 'Invalid workspace name. Use lowercase letters, numbers, and hyphens.' });
        return;
      }
      await createWorkspace(projectsDir, name);
      broadcast({ type: 'project-updated', projectSlug: '', timestamp: new Date().toISOString() });
      res.json({ name });
    } catch (error) {
      console.error('Error creating workspace:', error);
      res.status(500).json({ error: 'Failed to create workspace' });
    }
  });

  app.delete('/api/workspaces/:name', async (req, res) => {
    try {
      const cascade = req.query.cascade === 'true';
      const result = await deleteWorkspace(projectsDir, req.params.name, {
        cascade,
        assignmentsDir,
      });
      // Watchers emit project-updated / assignment-updated for any rewritten
      // file; only broadcast explicitly when the delete touched solely the
      // registry (which sits outside any watched tree).
      if (!result.rewroteFiles) {
        broadcast({ type: 'project-updated', projectSlug: '', timestamp: new Date().toISOString() });
      }
      res.json({ ok: true, rewroteFiles: result.rewroteFiles });
    } catch (error) {
      if (error instanceof WorkspaceBlockedError) {
        res.status(409).json({ error: error.message, blockedBy: error.blockedBy });
        return;
      }
      console.error('Error deleting workspace:', error);
      res.status(500).json({ error: 'Failed to delete workspace' });
    }
  });

  app.get('/api/assignments', async (req, res) => {
    try {
      const result = await listAssignmentsBoard(projectsDir, assignmentsDir);
      const workspaceParam = req.query.workspace as string | undefined;
      if (workspaceParam) {
        if (workspaceParam === '_ungrouped') {
          result.assignments = result.assignments.filter((a) => a.projectWorkspace === null);
        } else {
          result.assignments = result.assignments.filter((a) => a.projectWorkspace === workspaceParam);
        }
      }
      res.json(result);
    } catch (error) {
      console.error('Error listing assignments:', error);
      res.status(500).json({ error: 'Failed to list assignments' });
    }
  });

  app.get('/api/projects/:slug', async (req, res) => {
    try {
      const detail = await getProjectDetail(projectsDir, req.params.slug);
      if (!detail) {
        res.status(404).json({ error: `Project "${req.params.slug}" not found` });
        return;
      }
      res.json(detail);
    } catch (error) {
      console.error('Error getting project detail:', error);
      res.status(500).json({ error: 'Failed to get project detail' });
    }
  });

  app.get('/api/assignments/:id', async (req, res) => {
    try {
      const detail = await getAssignmentDetailById(projectsDir, assignmentsDir, req.params.id);
      if (!detail) {
        res.status(404).json({ error: `Assignment "${req.params.id}" not found` });
        return;
      }
      res.json(detail);
    } catch (error) {
      console.error('Error getting assignment by id:', error);
      res.status(500).json({ error: 'Failed to get assignment' });
    }
  });

  app.get('/api/assignments/:id/sessions', async (req, res) => {
    try {
      const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, req.params.id);
      if (!resolved) {
        res.status(404).json({ error: `Assignment "${req.params.id}" not found` });
        return;
      }
      await reconcileActiveSessions(projectsDir, assignmentsDir);
      const sessions = await listSessionsByAssignment(
        resolved.standalone ? null : resolved.projectSlug,
        resolved.standalone ? resolved.id : resolved.assignmentSlug,
      );
      const agents = getAgents(await readConfig());
      res.json({
        sessions: enrichSessions(sessions, agents),
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error listing sessions by id:', error);
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  app.get('/api/projects/:slug/assignments/:aslug', async (req, res) => {
    try {
      const detail = await getAssignmentDetail(
        projectsDir,
        req.params.slug,
        req.params.aslug,
      );
      if (!detail) {
        res.status(404).json({
          error: `Assignment "${req.params.aslug}" not found in project "${req.params.slug}"`,
        });
        return;
      }
      res.json(detail);
    } catch (error) {
      console.error('Error getting assignment detail:', error);
      res.status(500).json({ error: 'Failed to get assignment detail' });
    }
  });

  // --- Write API (create projects/assignments) ---
  app.use(createWriteRouter(projectsDir, assignmentsDir, todosDir));

  // --- Servers API ---
  app.use('/api/servers', createServersRouter(serversDir, projectsDir, assignmentsDir));

  // --- Leases API ---
  app.use('/api/leases', createLeasesRouter(broadcast));

  // --- Usage API (per-assignment / per-project token usage rollups) ---
  app.use('/api/usage', createUsageRouter());

  // --- Agent Sessions API ---
  app.use('/api/agent-sessions', createAgentSessionsRouter(projectsDir, broadcast, assignmentsDir));

  // --- Agents Config API ---
  app.use('/api/config/agents', createAgentsRouter());

  // --- Launch Preflight API ---
  app.use('/api/launch', createLaunchPreflightRouter());

  // --- Playbooks API ---
  app.use('/api/playbooks', createPlaybooksRouter(playbooksDir));

  // --- Memories / Resources (cross-project list) ---
  app.get('/api/memories', async (_req, res) => {
    try {
      const memories = await listAllMemories(projectsDir);
      res.json({ generatedAt: new Date().toISOString(), memories });
    } catch (error) {
      console.error('Error listing memories:', error);
      res.status(500).json({ error: `Failed to load memories: ${(error as Error).message}` });
    }
  });

  app.get('/api/resources', async (_req, res) => {
    try {
      const resources = await listAllResources(projectsDir);
      res.json({ generatedAt: new Date().toISOString(), resources });
    } catch (error) {
      console.error('Error listing resources:', error);
      res.status(500).json({ error: `Failed to load resources: ${(error as Error).message}` });
    }
  });

  // --- Todos API ---
  app.use('/api/todos', createTodosRouter(todosDir, broadcast, projectsDir));
  app.use('/api/projects/:projectId/todos', createProjectTodosRouter(projectsDir, broadcast, todosDir));

  // --- Bundles API (read-only in v1) ---
  app.use('/api/bundles', createBundlesRouter(todosDir, broadcast));
  app.use('/api/projects/:projectId/bundles', createProjectBundlesRouter(projectsDir, broadcast));

  // --- Backup API ---
  app.use('/api/backup', createBackupRouter());

  // --- Static files (production only) ---
  // Only serve the built asset directory as static — never let express.static
  // try to resolve arbitrary client-side route paths (e.g. /assignments/:id)
  // as files, which makes `send` emit NotFoundError on every SPA refresh.
  if (serveStaticUi && dashboardDistPath) {
    // `dotfiles: 'allow'` is required because the resolved package path may
    // live under a dot-prefixed directory (npm/npx caches under ~/.npm,
    // installs under ~/.nvm, ~/.local, etc.). The default 'ignore' makes
    // `send` 404 every file with a dot-component anywhere in the path.
    const sendOpts = { dotfiles: 'allow' as const };

    app.use('/assets', express.static(resolve(dashboardDistPath, 'assets'), sendOpts));
    // Files copied from dashboard/public/ (logo, favicon, etc.) land at the
    // dist root; serve them with fallthrough so missing paths still hit the
    // SPA fallback below. `index: false` prevents express.static from serving
    // index.html for "/" — that's the SPA fallback's job.
    app.use(express.static(dashboardDistPath, { ...sendOpts, index: false, fallthrough: true }));

    // SPA fallback: serve index.html for all non-API, non-WS, non-asset routes.
    // Express 5 requires named wildcards; use '{*path}' instead of '*'.
    app.get('{*path}', async (req: any, res: any) => {
      if (
        req.path.startsWith('/api') ||
        req.path === '/ws' ||
        req.path.startsWith('/assets')
      ) {
        res.status(404).json({ error: 'Not Found' });
        return;
      }
      const indexPath = resolve(dashboardDistPath, 'index.html');
      if (!(await fileExists(indexPath))) {
        res.status(503).send(
          'Dashboard not built. Run "npm run build:dashboard" first.',
        );
        return;
      }
      res.sendFile(indexPath, sendOpts, (err: Error | null) => {
        if (err) {
          console.error('Error sending dashboard index.html:', err);
          if (!res.headersSent) res.status(500).send('Dashboard load error');
        }
      });
    });
  }

  // --- File watcher ---
  let watcherHandle: { close: () => Promise<void> } | null = null;

  return {
    async start(): Promise<void> {
      watcherHandle = createWatcher({
        projectsDir,
        assignmentsDir,
        serversDir,
        playbooksDir,
        todosDir,
        dbPath: resolve(syntaurRoot(), 'syntaur.db'),
        onMessage: broadcast,
      });

      startAutodiscovery({ serversDir, projectsDir, assignmentsDir, excludePids: new Set([process.pid]) });

      return new Promise<void>((resolvePromise, reject) => {
        server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            reject(new Error(
              `Port ${port} is already in use. Use --port <number> to specify a different port.`,
            ));
          } else {
            reject(err);
          }
        });
        server.listen(port, () => {
          const portFile = resolve(syntaurRoot(), 'dashboard-port');
          writeFile(portFile, String(port), 'utf-8').catch(() => {});
          resolvePromise();
        });
      });
    },

    async stop(): Promise<void> {
      await stopAutodiscovery();
      if (watcherHandle) {
        await watcherHandle.close();
      }
      closeSessionDb();
      closeLeasesDb();
      closeUsageDb();
      for (const client of clients) {
        client.terminate();
      }
      clients.clear();
      const portFile = resolve(syntaurRoot(), 'dashboard-port');
      await unlink(portFile).catch(() => {});
      server.closeAllConnections?.();
      return new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    },

    get port(): number {
      return port;
    },
  };
}
