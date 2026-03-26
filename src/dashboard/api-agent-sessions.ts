import { Router } from 'express';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  listAllSessions,
  listMissionSessions,
  appendSession,
  updateSessionStatus,
  reconcileActiveSessions,
} from './agent-sessions.js';
import { fileExists } from '../utils/fs.js';
import type { AgentSessionStatus } from './types.js';

export function createAgentSessionsRouter(missionsDir: string): Router {
  const router = Router();

  // GET /api/agent-sessions — all sessions across all missions
  router.get('/', async (_req, res) => {
    try {
      await reconcileActiveSessions(missionsDir);
      const sessions = await listAllSessions(missionsDir);
      res.json({ sessions, generatedAt: new Date().toISOString() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list sessions' });
    }
  });

  // GET /api/agent-sessions/:missionSlug — sessions for one mission
  router.get('/:missionSlug', async (req, res) => {
    try {
      const { missionSlug } = req.params;
      const assignment = req.query.assignment as string | undefined;
      const missionDir = resolve(missionsDir, missionSlug);
      if (!(await fileExists(missionDir))) {
        res.status(404).json({ error: `Mission "${missionSlug}" not found` });
        return;
      }
      await reconcileActiveSessions(missionsDir);
      const sessions = await listMissionSessions(missionsDir, missionSlug, assignment);
      res.json({ sessions, generatedAt: new Date().toISOString() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list sessions' });
    }
  });

  // POST /api/agent-sessions — register a new session
  router.post('/', async (req, res) => {
    try {
      const { missionSlug, assignmentSlug, agent, sessionId, path } = req.body;

      if (!missionSlug || !assignmentSlug || !agent) {
        res.status(400).json({ error: 'missionSlug, assignmentSlug, and agent are required' });
        return;
      }

      const missionDir = resolve(missionsDir, missionSlug);
      if (!(await fileExists(missionDir))) {
        res.status(404).json({ error: `Mission "${missionSlug}" not found` });
        return;
      }

      const id = sessionId || randomUUID();
      const session = {
        missionSlug,
        assignmentSlug,
        agent,
        sessionId: id,
        started: new Date().toISOString(),
        status: 'active' as AgentSessionStatus,
        path: path || '',
      };

      await appendSession(missionDir, session);
      res.status(201).json({ sessionId: id });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Registration failed' });
    }
  });

  // PATCH /api/agent-sessions/:sessionId/status — update session status
  router.patch('/:sessionId/status', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { status, missionSlug } = req.body;

      if (!status || !missionSlug) {
        res.status(400).json({ error: 'status and missionSlug are required' });
        return;
      }

      if (!['active', 'completed', 'stopped'].includes(status)) {
        res.status(400).json({ error: 'status must be active, completed, or stopped' });
        return;
      }

      const missionDir = resolve(missionsDir, missionSlug);
      if (!(await fileExists(missionDir))) {
        res.status(404).json({ error: `Mission "${missionSlug}" not found` });
        return;
      }

      const updated = await updateSessionStatus(missionDir, sessionId, status);
      if (!updated) {
        res.status(404).json({ error: `Session "${sessionId}" not found` });
        return;
      }

      res.json({ updated: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Update failed' });
    }
  });

  return router;
}
