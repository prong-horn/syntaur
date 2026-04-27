import express from 'express';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { syntaurRoot } from '../utils/paths.js';
import { WebSocketServer, WebSocket } from 'ws';
import {
  listProjects,
  listAssignmentsBoard,
  getProjectDetail,
  getAssignmentDetail,
  getAssignmentDetailById,
  getOverview,
  getAttention,
  getHelp,
  getStatusConfig,
  clearStatusConfigCache,
  listWorkspaces,
  createWorkspace,
  deleteWorkspace,
} from './api.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';
import { listSessionsByAssignment, reconcileActiveSessions } from './agent-sessions.js';
import { createWatcher } from './watcher.js';
import { fileExists } from '../utils/fs.js';
import { writeStatusConfig, deleteStatusConfig, writeThemeConfig, deleteThemeConfig, readConfig } from '../utils/config.js';
import { createWriteRouter } from './api-write.js';
import { createServersRouter } from './api-servers.js';
import { createAgentSessionsRouter } from './api-agent-sessions.js';
import { createPlaybooksRouter } from './api-playbooks.js';
import {
  migrateLegacyProjectFiles,
  migrateLegacyConfig,
  summarizeMigration,
} from '../utils/fs-migration.js';
import { createTodosRouter } from './api-todos.js';
import { createProjectTodosRouter } from './api-project-todos.js';
import { createBackupRouter } from './api-backup.js';
import { initSessionDb, migrateFromMarkdown, closeSessionDb } from './session-db.js';
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
  app.get('/api/overview', async (_req, res) => {
    try {
      const overview = await getOverview(projectsDir, serversDir, assignmentsDir);
      res.json(overview);
    } catch (error) {
      console.error('Error getting overview:', error);
      res.status(500).json({ error: 'Failed to get overview' });
    }
  });

  app.get('/api/attention', async (_req, res) => {
    try {
      const attention = await getAttention(projectsDir, serversDir, assignmentsDir);
      res.json(attention);
    } catch (error) {
      console.error('Error getting attention queue:', error);
      res.status(500).json({ error: 'Failed to get attention queue' });
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

  app.get('/api/config/statuses', async (_req, res) => {
    try {
      const config = await getStatusConfig();
      res.json({
        statuses: config.statuses,
        order: config.order,
        transitions: config.transitions,
        custom: config.custom,
      });
    } catch (error) {
      console.error('Error getting status config:', error);
      res.status(500).json({ error: 'Failed to get status config' });
    }
  });

  app.post('/api/config/statuses', async (req, res) => {
    try {
      const { statuses, order, transitions } = req.body;
      if (!Array.isArray(statuses) || !Array.isArray(order) || !Array.isArray(transitions)) {
        res.status(400).json({ error: 'Request body must include statuses, order, and transitions arrays' });
        return;
      }
      await writeStatusConfig({ statuses, order, transitions });
      clearStatusConfigCache();
      const config = await getStatusConfig();
      res.json({
        statuses: config.statuses,
        order: config.order,
        transitions: config.transitions,
        custom: config.custom,
      });
    } catch (error) {
      console.error('Error saving status config:', error);
      res.status(500).json({ error: 'Failed to save status config' });
    }
  });

  app.delete('/api/config/statuses', async (_req, res) => {
    try {
      await deleteStatusConfig();
      clearStatusConfigCache();
      const config = await getStatusConfig();
      res.json({
        statuses: config.statuses,
        order: config.order,
        transitions: config.transitions,
        custom: config.custom,
      });
    } catch (error) {
      console.error('Error resetting status config:', error);
      res.status(500).json({ error: 'Failed to reset status config' });
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
      await deleteWorkspace(projectsDir, req.params.name);
      broadcast({ type: 'project-updated', projectSlug: '', timestamp: new Date().toISOString() });
      res.json({ ok: true });
    } catch (error) {
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
      res.json({ sessions, generatedAt: new Date().toISOString() });
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
  app.use(createWriteRouter(projectsDir, assignmentsDir));

  // --- Servers API ---
  app.use('/api/servers', createServersRouter(serversDir, projectsDir, assignmentsDir));

  // --- Agent Sessions API ---
  app.use('/api/agent-sessions', createAgentSessionsRouter(projectsDir, broadcast, assignmentsDir));

  // --- Playbooks API ---
  app.use('/api/playbooks', createPlaybooksRouter(playbooksDir));

  // --- Todos API ---
  app.use('/api/todos', createTodosRouter(todosDir, broadcast));
  app.use('/api/projects/:projectId/todos', createProjectTodosRouter(projectsDir, broadcast));

  // --- Backup API ---
  app.use('/api/backup', createBackupRouter());

  // --- Static files (production only) ---
  // Only serve the built asset directory as static — never let express.static
  // try to resolve arbitrary client-side route paths (e.g. /assignments/:id)
  // as files, which makes `send` emit NotFoundError on every SPA refresh.
  if (serveStaticUi && dashboardDistPath) {
    app.use('/assets', express.static(resolve(dashboardDistPath, 'assets')));
    // Files copied from dashboard/public/ (logo, favicon, etc.) land at the
    // dist root; serve them with fallthrough so missing paths still hit the
    // SPA fallback below. `index: false` prevents express.static from serving
    // index.html for "/" — that's the SPA fallback's job.
    app.use(express.static(dashboardDistPath, { index: false, fallthrough: true }));

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
      res.sendFile(indexPath, (err: Error | null) => {
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
