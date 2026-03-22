import { Router } from 'express';
import {
  registerSession,
  removeSession,
  listSessionFiles,
  readSessionFile,
  updateLastRefreshed,
  setOverride,
  sanitizeSessionName,
} from './servers.js';
import {
  scanAllSessions,
  scanSingleSession,
  clearScanCache,
} from './scanner.js';

export function createServersRouter(serversDir: string, missionsDir: string): Router {
  const router = Router();

  // GET /api/servers — all sessions with cached scan data
  router.get('/', async (_req, res) => {
    try {
      const result = await scanAllSessions(serversDir, missionsDir);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Scan failed' });
    }
  });

  // GET /api/servers/:name — single session
  router.get('/:name', async (req, res) => {
    try {
      const session = await scanSingleSession(serversDir, missionsDir, req.params.name);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      res.json(session);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Scan failed' });
    }
  });

  // POST /api/servers — register a new session
  router.post('/', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const sanitized = sanitizeSessionName(name);
      const existing = await readSessionFile(serversDir, sanitized);
      if (existing) {
        res.status(409).json({ error: `Session "${sanitized}" already registered` });
        return;
      }
      await registerSession(serversDir, name);
      clearScanCache();
      res.status(201).json({ name: sanitized });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Registration failed' });
    }
  });

  // DELETE /api/servers/:name — unregister
  router.delete('/:name', async (req, res) => {
    try {
      const data = await readSessionFile(serversDir, req.params.name);
      if (!data) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      await removeSession(serversDir, req.params.name);
      clearScanCache();
      res.json({ removed: req.params.name });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Removal failed' });
    }
  });

  // POST /api/servers/refresh — fresh scan all (must be before /:name/refresh)
  router.post('/refresh', async (_req, res) => {
    try {
      const names = await listSessionFiles(serversDir);
      for (const name of names) {
        await updateLastRefreshed(serversDir, name);
      }
      clearScanCache();
      const result = await scanAllSessions(serversDir, missionsDir, { bypassCache: true });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Refresh failed' });
    }
  });

  // POST /api/servers/:name/refresh — fresh scan one
  router.post('/:name/refresh', async (req, res) => {
    try {
      const data = await readSessionFile(serversDir, req.params.name);
      if (!data) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      await updateLastRefreshed(serversDir, req.params.name);
      clearScanCache();
      const session = await scanSingleSession(serversDir, missionsDir, req.params.name);
      res.json(session);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Refresh failed' });
    }
  });

  // PATCH /api/servers/:name/panes/:windowIndex/:paneIndex/assignment — manual link
  router.patch('/:name/panes/:windowIndex/:paneIndex/assignment', async (req, res) => {
    try {
      const { name, windowIndex, paneIndex } = req.params;
      const data = await readSessionFile(serversDir, name);
      if (!data) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const body = req.body;
      if (body === null || (body && body.mission && body.assignment)) {
        await setOverride(
          serversDir,
          name,
          parseInt(windowIndex, 10),
          parseInt(paneIndex, 10),
          body,
        );
        clearScanCache();
        res.json({ updated: true });
      } else {
        res.status(400).json({ error: 'Body must be { mission, assignment } or null' });
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Update failed' });
    }
  });

  return router;
}
