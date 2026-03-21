import express from 'express';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { listMissions, getMissionDetail, getAssignmentDetail } from './api.js';
import { createWatcher } from './watcher.js';
import { fileExists } from '../utils/fs.js';
import type { WsMessage } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DashboardServerOptions {
  port: number;
  missionsDir: string;
  devMode: boolean;
}

export function createDashboardServer(options: DashboardServerOptions) {
  const { port, missionsDir, devMode } = options;
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

  // --- API Routes ---
  app.get('/api/missions', async (_req, res) => {
    try {
      const missions = await listMissions(missionsDir);
      res.json(missions);
    } catch (error) {
      console.error('Error listing missions:', error);
      res.status(500).json({ error: 'Failed to list missions' });
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

  // --- Static files (production only) ---
  if (!devMode) {
    const dashboardDistPath = resolve(__dirname, '..', '..', 'dashboard', 'dist');
    app.use(express.static(dashboardDistPath));

    // SPA fallback: serve index.html for all non-API routes
    // Express 5 requires named wildcards; use '{*path}' instead of '*'
    app.get('{*path}', async (_req, res) => {
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
        onMessage: broadcast,
      });

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
          resolvePromise();
        });
      });
    },

    async stop(): Promise<void> {
      if (watcherHandle) {
        await watcherHandle.close();
      }
      for (const client of clients) {
        client.close();
      }
      clients.clear();
      return new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    },

    get port(): number {
      return port;
    },
  };
}
