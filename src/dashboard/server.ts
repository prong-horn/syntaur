import express from 'express';
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { resolve } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { syntaurRoot, viewPrefsFile } from '../utils/paths.js';
import { WebSocketServer, WebSocket } from 'ws';
import {
  listProjects,
  listTicketsBoard,
  listArchived,
  getProjectDetail,
  getTicketDetail,
  getTicketDetailById,
  invalidateRecordsCache,
} from './api.js';
import { resolveTicketById } from '../utils/ticket-resolver.js';
import { listSessionsByTicket, reconcileActiveSessions, withLiveness } from './agent-sessions.js';
import { createWatcher } from './watcher.js';
import { fileExists } from '../utils/fs.js';
import {
  writeThemeConfig,
  deleteThemeConfig,
  readConfig,
} from '../utils/config.js';
import { listTemplates, templatesDir } from '../ticket-templates/registry.js';
import { agentsDir } from '../chat/agents.js';
import {
  isViewMode,
  isSortField,
  isSortDirection,
  isDensity,
  isGrouping,
  isActivity,
  isFilterValue,
  type ViewPrefs,
  type ProjectViewPrefs,
  type ViewFilters,
  type FilterValue,
  type ViewPrefsPatch,
} from '../utils/view-prefs-schema.js';
import {
  readViewPrefsFile,
  applyViewPrefsPatch,
  resetViewPrefsFile,
  isViewPrefsDefaults,
} from '../utils/view-prefs.js';
import { withLock } from './write-locks.js';
import { createWriteRouter } from './api-write.js';
import { createAgentSessionsRouter } from './api-agent-sessions.js';
import { createSearchConfigRouter } from './api-search-config.js';
import { createContentSearchRouter } from './api-search.js';
import { createUsageRouter, getTicketUsageHandler } from './api-usage.js';
import { createEventsRouter } from './api-events.js';
import { createInboxRouter } from './api-inbox.js';
import { createChatRouter } from './api-chat.js';
import { createChatAgentsRouter } from './api-chat-agents.js';
import { createChatBroker, type ChatRuntimeIdentity } from '../chat/broker.js';
import { acquireHomeOwnerLock, type HomeOwnerHandle } from '../chat/broker-owner.js';
import { createStageDispatchRouter } from './api-stage-dispatch.js';
import { captureProcessStartedAt } from '../utils/process-info.js';
import { canonicalPath } from '../utils/path-canon.js';
import { createPlaybooksRouter } from './api-playbooks.js';
import {
  migrateLegacyProjectFiles,
  migrateLegacyConfig,
  summarizeMigration,
} from '../utils/fs-migration.js';
import { initSessionDb, closeSessionDb } from './session-db.js';
import { initUsageDb, closeUsageDb } from '../db/usage-db.js';
import { startMaintenanceLoop, stopMaintenanceLoop } from './maintenance-loop.js';
import { startUsageCollector, stopUsageCollector } from './usage-collector.js';
import type { WsMessage } from './types.js';

export interface DashboardServerOptions {
  port: number;
  projectsDir: string;
  playbooksDir: string;
  serveStaticUi: boolean;
  /** Absolute path to the built dashboard UI (dashboard/dist). Required when serveStaticUi is true. */
  dashboardDistPath?: string;
}

export function createDashboardServer(options: DashboardServerOptions) {
  const { port, projectsDir, playbooksDir, serveStaticUi, dashboardDistPath } = options;
  const app = express();
  const server = createServer(app);

  // --- WebSocket (JSON broadcast channel) ---
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  // The `/ws` broadcast channel is the only upgrade Syntaur serves. The
  // per-session `/ws/agent-sessions/<short>/pty` bridge went with the daemon
  // (phase 4, Decision 5) — the chat owns its adapters directly.
  server.on('upgrade', (request, socket, head) => {
    const path = (request.url ?? '').split('?')[0];
    if (path === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
      return;
    }
    socket.destroy();
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
    // Net for record edits made outside the dashboard's own write routes (the
    // watcher debounces 300ms, so this can't be the only mechanism — the write
    // routers invalidate synchronously — but it catches external/manual edits).
    // Internal routes already invalidated before broadcasting; re-clearing is a
    // cheap idempotent no-op.
    if (message.type === 'project-updated' || message.type === 'ticket-updated') {
      invalidateRecordsCache();
    }
    const data = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  // --- Initialize session database ---
  initSessionDb();

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
  app.get('/api/ticket-templates', async (_req, res) => {
    try {
      const root = syntaurRoot();
      const templates = await listTemplates(root);
      res.json({
        templates: templates.map((t) => ({
          id: t.id,
          description: t.description,
          whenToUse: t.whenToUse,
          builtin: t.builtin ?? null,
          driftStatus: t.driftStatus ?? null,
          stageIds: t.stageIds,
          filePaths: t.filePaths,
        })),
      });
    } catch (error) {
      console.error('Error listing ticket templates:', error);
      res.status(500).json({ error: 'Failed to list ticket templates' });
    }
  });

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

  app.use('/api/config/search', createSearchConfigRouter());
  app.use('/api/search', createContentSearchRouter(projectsDir));
  const VIEW_PREFS_LOCK = 'vp:global';

  const FILTER_KEYS = new Set(['status', 'type', 'priority', 'assignee', 'project', 'tags', 'activity']);
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
    for (const key of ['status', 'type', 'priority', 'assignee', 'project', 'tags']) {
      if (obj[key] !== undefined) {
        if (!isFilterValue(obj[key])) {
          return { ok: false, error: `filters.${key} must be a non-empty string or array of non-empty strings` };
        }
        (out as Record<string, FilterValue>)[key] = obj[key] as FilterValue;
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

  app.get('/api/projects', async (_req, res) => {
    try {
      const projects = await listProjects(projectsDir);
      res.json(projects);
    } catch (error) {
      console.error('Error listing projects:', error);
      res.status(500).json({ error: 'Failed to list projects' });
    }
  });

  app.get('/api/tickets', async (_req, res) => {
    try {
      const result = await listTicketsBoard(projectsDir);
      res.json(result);
    } catch (error) {
      console.error('Error listing tickets:', error);
      res.status(500).json({ error: 'Failed to list tickets' });
    }
  });

  app.get('/api/archived', async (_req, res) => {
    try {
      const result = await listArchived(projectsDir);
      res.json(result);
    } catch (error) {
      console.error('Error listing archived content:', error);
      res.status(500).json({ error: 'Failed to list archived content' });
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

  app.get('/api/tickets/:id/log', async (req, res) => {
    try {
      const { getTicketLogById } = await import('./api.js');
      const typeFilter = typeof req.query.type === 'string' ? req.query.type.trim() : undefined;
      const log = await getTicketLogById(projectsDir, req.params.id, typeFilter || undefined);
      if (!log) {
        res.status(404).json({ error: `Ticket "${req.params.id}" not found` });
        return;
      }
      res.json(log);
    } catch (error) {
      console.error('Error getting ticket log:', error);
      res.status(500).json({ error: 'Failed to get ticket log' });
    }
  });

  app.get('/api/tickets/:id', async (req, res) => {
    try {
      const detail = await getTicketDetailById(projectsDir, req.params.id);
      if (!detail) {
        res.status(404).json({ error: `Ticket "${req.params.id}" not found` });
        return;
      }
      res.json(detail);
    } catch (error) {
      console.error('Error getting ticket by id:', error);
      res.status(500).json({ error: 'Failed to get ticket' });
    }
  });

  app.get('/api/tickets/:id/show', async (req, res) => {
    try {
      const { getTicketShowById } = await import('./api.js');
      const show = await getTicketShowById(projectsDir, req.params.id);
      if (!show) {
        res.status(404).json({ error: `Ticket "${req.params.id}" not found` });
        return;
      }
      res.json(show);
    } catch (error) {
      console.error('Error getting ticket show:', error);
      res.status(500).json({ error: 'Failed to get ticket show' });
    }
  });

  app.get('/api/tickets/:id/sessions', async (req, res) => {
    try {
      const resolved = await resolveTicketById(projectsDir, req.params.id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${req.params.id}" not found` });
        return;
      }
      await reconcileActiveSessions(projectsDir);
      const sessions = await listSessionsByTicket(resolved.id);
      res.json({
        sessions: withLiveness(sessions),
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error listing sessions by id:', error);
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  app.get('/api/tickets/:id/usage', getTicketUsageHandler(projectsDir));

  // --- Ticket chat broker (lazy: owner lock + construction happen in start()) ---
  let ownerHandle: HomeOwnerHandle | null = null;
  let runtimeIdentity: ChatRuntimeIdentity | null = null;
  let chatBroker: ReturnType<typeof createChatBroker> | null = null;

  const brokerProxy = new Proxy({} as ReturnType<typeof createChatBroker>, {
    get(_target, prop) {
      if (!chatBroker) {
        throw new Error('Chat broker is not ready');
      }
      const value = (chatBroker as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? value.bind(chatBroker) : value;
    },
  });

  // --- Write API (create projects/tickets) ---
  app.use(createWriteRouter(projectsDir, { broker: brokerProxy }));

  // --- Usage API (per-ticket / per-project token usage rollups) ---
  app.use('/api/usage', createUsageRouter(projectsDir));

  // --- Events API (per-ticket audit Activity timeline) ---
  app.use('/api', createEventsRouter(projectsDir));

  // --- Inbox API ("Needs me" triage view) ---
  app.use('/api', createInboxRouter(projectsDir));

  app.use('/api', createChatRouter(projectsDir, { broker: brokerProxy }));
  app.use('/api', createChatAgentsRouter({ broker: brokerProxy }));
  app.use(createStageDispatchRouter(projectsDir, brokerProxy));

  // --- Agent Sessions API ---
  app.use(
    '/api/agent-sessions',
    createAgentSessionsRouter(projectsDir, broadcast),
  );

  // --- Agents Config API ---

  // --- Playbooks API ---
  app.use('/api/playbooks', createPlaybooksRouter(playbooksDir));

  // --- Static files (production only) ---
  // Only serve the built asset directory as static — never let express.static
  // try to resolve arbitrary client-side route paths (e.g. /tickets/:id)
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
        req.path.startsWith('/ws/') ||
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
  // --- Staleness watchdog (opt-in, read-only) ---
  // Staleness is day-scale, so a slow tick is plenty (and keeps the scan cheap).
  const STALENESS_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
  let stalenessWatchdogTimer: ReturnType<typeof setInterval> | null = null;

  async function cleanupStartupResources(): Promise<void> {
    if (stalenessWatchdogTimer) {
      clearInterval(stalenessWatchdogTimer);
      stalenessWatchdogTimer = null;
    }
    await stopMaintenanceLoop().catch(() => {});
    await stopUsageCollector().catch(() => {});
    if (watcherHandle) {
      await watcherHandle.close().catch(() => {});
      watcherHandle = null;
    }
    if (chatBroker) {
      await chatBroker.stopAll().catch(() => {});
      chatBroker = null;
    }
    if (ownerHandle) {
      await ownerHandle.release().catch(() => {});
      ownerHandle = null;
      runtimeIdentity = null;
    }
  }

  return {
    async start(): Promise<void> {
      watcherHandle = createWatcher({
        projectsDir,
        playbooksDir,
        dbPath: resolve(syntaurRoot(), 'syntaur.db'),
        configPath: resolve(syntaurRoot(), 'config.md'),
        viewPrefsPath: viewPrefsFile(),
        agentsDir: agentsDir(),
        templatesDir: templatesDir(syntaurRoot()),
        onMessage: broadcast,
      });

      startMaintenanceLoop({
        projectsDir,
        // Same WS frame the REST mutations emit, so the UI refreshes when the
        // stale sweep stops a row. The loop's immediate first tick covers
        // "sweep at dashboard start".
        onAgentSessionsChanged: () =>
          broadcast({ type: 'agent-sessions-updated', timestamp: new Date().toISOString() }),
      });
      startUsageCollector();

      // Read-only staleness watchdog (opt-in: config.stalenessWatchdog). Emits
      // staleness-detected/cleared audit events on an interval so staleness can
      // be noticed without a dashboard fetch — NEVER mutates status (decision
      // D1). Migration-gated and dedup'd across ticks; failures are swallowed.
      const startupConfig = await readConfig();
      if (startupConfig.stalenessWatchdog) {
        const { collectStaleCandidates } = await import('./api.js');
        const { runStalenessWatchdogTick } = await import('../staleness/watchdog.js');
        const { emitEvent } = await import('../lifecycle/event-emit.js');
        const stalenessSeen = new Set<string>();
        const watchdogTick = async (): Promise<void> => {
          try {
            const candidates = await collectStaleCandidates(projectsDir);
            const summary = runStalenessWatchdogTick(candidates, stalenessSeen, (e) => {
              emitEvent({
                ticketId: e.ticketId,
                projectSlug: e.projectSlug,
                type: e.type,
                actor: 'system',
                details: { reasons: e.reasons.map((r) => r.kind) },
              });
            });
            if (summary.newlyStale > 0 || summary.cleared > 0) {
              console.log(
                `staleness watchdog: ${summary.newlyStale} newly stale, ${summary.cleared} cleared (${summary.stale}/${summary.scanned} stale).`,
              );
            }
          } catch (err) {
            console.error('staleness watchdog tick failed:', err);
          }
        };
        void watchdogTick();
        stalenessWatchdogTimer = setInterval(() => void watchdogTick(), STALENESS_WATCHDOG_INTERVAL_MS);
        stalenessWatchdogTimer.unref?.();
      }

      try {
        ownerHandle = await acquireHomeOwnerLock(port);
        chatBroker = createChatBroker({
          projectsDir,
          broadcast: (message) => broadcast(message as WsMessage),
          runtimeIdentity: () => runtimeIdentity,
        });
      } catch (err) {
        await cleanupStartupResources();
        throw err;
      }

      return new Promise<void>((resolvePromise, reject) => {
        server.on('error', async (err: NodeJS.ErrnoException) => {
          await cleanupStartupResources();
          if (err.code === 'EADDRINUSE') {
            const inUse = new Error(
              `Port ${port} is already in use.`,
            ) as NodeJS.ErrnoException;
            inUse.code = 'EADDRINUSE';
            reject(inUse);
          } else {
            reject(err);
          }
        });
        server.listen(port, '127.0.0.1', () => {
          const home = syntaurRoot();
          runtimeIdentity = {
            protocol: 1,
            root: canonicalPath(home),
            projectsDir: canonicalPath(projectsDir),
            pid: process.pid,
            processStartedAt: captureProcessStartedAt(process.pid),
            ownerToken: ownerHandle!.record.ownerToken,
            port,
          };
          const portFile = resolve(home, 'dashboard-port');
          void writeFile(portFile, String(port), 'utf-8')
            .catch(() => {})
            .finally(() => resolvePromise());
        });
      });
    },

    async stop(): Promise<void> {
      // Chat first: stopAll() cancels in-flight turns, seals their `turn.status`
      // rows, closes their engagements and tears down the adapter process
      // groups — all of which WRITE, so it has to happen while the session and
      // usage DBs are still open.
      if (chatBroker) {
        await chatBroker.stopAll().catch(() => {});
        chatBroker = null;
      }
      if (stalenessWatchdogTimer) {
        clearInterval(stalenessWatchdogTimer);
        stalenessWatchdogTimer = null;
      }
      await stopMaintenanceLoop();
      await stopUsageCollector();
      if (watcherHandle) {
        await watcherHandle.close();
        watcherHandle = null;
      }
      closeSessionDb();
      closeUsageDb();
      for (const client of clients) {
        client.terminate();
      }
      clients.clear();
      const portFile = resolve(syntaurRoot(), 'dashboard-port');
      try {
        const { readFile } = await import('node:fs/promises');
        const current = (await readFile(portFile, 'utf-8')).trim();
        if (current === String(port)) {
          await unlink(portFile);
        }
      } catch {
        /* no port file */
      }
      server.closeAllConnections?.();
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
      if (ownerHandle) {
        await ownerHandle.release().catch(() => {});
        ownerHandle = null;
        runtimeIdentity = null;
      }
    },

    get port(): number {
      return port;
    },
  };
}
