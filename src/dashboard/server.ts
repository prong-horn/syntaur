import express from 'express';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { writeFile, unlink } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import {
  listMissions,
  listAssignmentsBoard,
  getMissionDetail,
  getAssignmentDetail,
  getOverview,
  getAttention,
  getHelp,
  getStatusConfig,
  clearStatusConfigCache,
  listWorkspaces,
  createWorkspace,
  deleteWorkspace,
} from './api.js';
import { createWatcher } from './watcher.js';
import { fileExists } from '../utils/fs.js';
import { writeStatusConfig, deleteStatusConfig } from '../utils/config.js';
import { createWriteRouter } from './api-write.js';
import { createServersRouter } from './api-servers.js';
import { createAgentSessionsRouter } from './api-agent-sessions.js';
import { createPlaybooksRouter } from './api-playbooks.js';
import { createTodosRouter } from './api-todos.js';
import { initSessionDb, migrateFromMarkdown, closeSessionDb } from './session-db.js';
import { startAutodiscovery, stopAutodiscovery } from './autodiscovery.js';
import type { WsMessage } from './types.js';

export interface DashboardServerOptions {
  port: number;
  missionsDir: string;
  serversDir: string;
  playbooksDir: string;
  todosDir: string;
  serveStaticUi: boolean;
  /** Absolute path to the built dashboard UI (dashboard/dist). Required when serveStaticUi is true. */
  dashboardDistPath?: string;
}

export function createDashboardServer(options: DashboardServerOptions) {
  const { port, missionsDir, serversDir, playbooksDir, todosDir, serveStaticUi, dashboardDistPath } = options;
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
  migrateFromMarkdown(missionsDir).catch((err) => {
    console.error('Session migration from markdown failed:', err);
  });

  // --- JSON body parsing ---
  app.use(express.json());

  // --- API Routes ---
  app.get('/api/overview', async (_req, res) => {
    try {
      const overview = await getOverview(missionsDir, serversDir);
      res.json(overview);
    } catch (error) {
      console.error('Error getting overview:', error);
      res.status(500).json({ error: 'Failed to get overview' });
    }
  });

  app.get('/api/attention', async (_req, res) => {
    try {
      const attention = await getAttention(missionsDir, serversDir);
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

  app.get('/api/missions', async (req, res) => {
    try {
      let missions = await listMissions(missionsDir);
      const workspaceParam = req.query.workspace as string | undefined;
      if (workspaceParam) {
        if (workspaceParam === '_ungrouped') {
          missions = missions.filter((m) => m.workspace === null);
        } else {
          missions = missions.filter((m) => m.workspace === workspaceParam);
        }
      }
      res.json(missions);
    } catch (error) {
      console.error('Error listing missions:', error);
      res.status(500).json({ error: 'Failed to list missions' });
    }
  });

  app.get('/api/workspaces', async (_req, res) => {
    try {
      const result = await listWorkspaces(missionsDir);
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
      await createWorkspace(missionsDir, name);
      broadcast({ type: 'mission-updated', missionSlug: '', timestamp: new Date().toISOString() });
      res.json({ name });
    } catch (error) {
      console.error('Error creating workspace:', error);
      res.status(500).json({ error: 'Failed to create workspace' });
    }
  });

  app.delete('/api/workspaces/:name', async (req, res) => {
    try {
      await deleteWorkspace(missionsDir, req.params.name);
      broadcast({ type: 'mission-updated', missionSlug: '', timestamp: new Date().toISOString() });
      res.json({ ok: true });
    } catch (error) {
      console.error('Error deleting workspace:', error);
      res.status(500).json({ error: 'Failed to delete workspace' });
    }
  });

  app.get('/api/assignments', async (req, res) => {
    try {
      const result = await listAssignmentsBoard(missionsDir);
      const workspaceParam = req.query.workspace as string | undefined;
      if (workspaceParam) {
        if (workspaceParam === '_ungrouped') {
          result.assignments = result.assignments.filter((a) => a.missionWorkspace === null);
        } else {
          result.assignments = result.assignments.filter((a) => a.missionWorkspace === workspaceParam);
        }
      }
      res.json(result);
    } catch (error) {
      console.error('Error listing assignments:', error);
      res.status(500).json({ error: 'Failed to list assignments' });
    }
  });

  app.get('/api/missions/:slug', async (req, res) => {
    try {
      const detail = await getMissionDetail(missionsDir, req.params.slug);
      if (!detail) {
        res.status(404).json({ error: `Mission "${req.params.slug}" not found` });
        return;
      }
      res.json(detail);
    } catch (error) {
      console.error('Error getting mission detail:', error);
      res.status(500).json({ error: 'Failed to get mission detail' });
    }
  });

  app.get('/api/missions/:slug/assignments/:aslug', async (req, res) => {
    try {
      const detail = await getAssignmentDetail(
        missionsDir,
        req.params.slug,
        req.params.aslug,
      );
      if (!detail) {
        res.status(404).json({
          error: `Assignment "${req.params.aslug}" not found in mission "${req.params.slug}"`,
        });
        return;
      }
      res.json(detail);
    } catch (error) {
      console.error('Error getting assignment detail:', error);
      res.status(500).json({ error: 'Failed to get assignment detail' });
    }
  });

  // --- Write API (create missions/assignments) ---
  app.use(createWriteRouter(missionsDir));

  // --- Servers API ---
  app.use('/api/servers', createServersRouter(serversDir, missionsDir));

  // --- Agent Sessions API ---
  app.use('/api/agent-sessions', createAgentSessionsRouter(missionsDir, broadcast));

  // --- Playbooks API ---
  app.use('/api/playbooks', createPlaybooksRouter(playbooksDir));

  // --- Todos API ---
  app.use('/api/todos', createTodosRouter(todosDir, broadcast));

  // --- Static files (production only) ---
  if (serveStaticUi && dashboardDistPath) {
    app.use(express.static(dashboardDistPath));

    // SPA fallback: serve index.html for all non-API routes
    // Express 5 requires named wildcards; use '{*path}' instead of '*'
    app.get('{*path}', async (_req: any, res: any) => {
      const indexPath = resolve(dashboardDistPath, 'index.html');
      if (await fileExists(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(503).send(
          'Dashboard not built. Run "npm run build:dashboard" first.',
        );
      }
    });
  }

  // --- File watcher ---
  let watcherHandle: { close: () => Promise<void> } | null = null;

  return {
    async start(): Promise<void> {
      watcherHandle = createWatcher({
        missionsDir,
        serversDir,
        playbooksDir,
        todosDir,
        onMessage: broadcast,
      });

      startAutodiscovery({ serversDir, missionsDir, excludePids: new Set([process.pid]) });

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
          const portFile = resolve(homedir(), '.syntaur', 'dashboard-port');
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
        client.close();
      }
      clients.clear();
      const portFile = resolve(homedir(), '.syntaur', 'dashboard-port');
      await unlink(portFile).catch(() => {});
      return new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    },

    get port(): number {
      return port;
    },
  };
}
