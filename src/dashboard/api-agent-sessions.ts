import { Router } from 'express';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  listAllSessions,
  listMissionSessions,
  appendSession,
  updateSessionStatus,
  deleteSessions,
  reconcileActiveSessions,
} from './agent-sessions.js';
import { fileExists } from '../utils/fs.js';
import type { AgentSessionStatus, WsMessage } from './types.js';

export function createAgentSessionsRouter(
  missionsDir: string,
  broadcast?: (msg: WsMessage) => void,
): Router {
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
      const { missionSlug, assignmentSlug, agent, sessionId, path, description } = req.body;

      if (!agent) {
        res.status(400).json({ error: 'agent is required' });
        return;
      }

      if (missionSlug) {
        const missionDir = resolve(missionsDir, missionSlug);
        if (!(await fileExists(missionDir))) {
          res.status(404).json({ error: `Mission "${missionSlug}" not found` });
          return;
        }
      }

      const id = sessionId || randomUUID();
      const session = {
        missionSlug: missionSlug || null,
        assignmentSlug: assignmentSlug || null,
        agent,
        sessionId: id,
        started: new Date().toISOString(),
        status: 'active' as AgentSessionStatus,
        path: path || '',
        description: description || null,
      };

      await appendSession('', session);
      broadcast?.({ type: 'agent-sessions-updated', timestamp: new Date().toISOString() });
      res.status(201).json({ sessionId: id });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Registration failed' });
    }
  });

  // PATCH /api/agent-sessions/:sessionId/status — update session status
  router.patch('/:sessionId/status', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { status } = req.body;

      if (!status) {
        res.status(400).json({ error: 'status is required' });
        return;
      }

      if (!['active', 'completed', 'stopped'].includes(status)) {
        res.status(400).json({ error: 'status must be active, completed, or stopped' });
        return;
      }

      const updated = await updateSessionStatus('', sessionId, status);
      if (!updated) {
        res.status(404).json({ error: `Session "${sessionId}" not found` });
        return;
      }

      broadcast?.({ type: 'agent-sessions-updated', timestamp: new Date().toISOString() });
      res.json({ updated: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Update failed' });
    }
  });

  // DELETE /api/agent-sessions — delete one or more sessions
  router.delete('/', async (req, res) => {
    try {
      const { sessionIds } = req.body;

      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        res.status(400).json({ error: 'sessionIds must be a non-empty array' });
        return;
      }

      const deleted = await deleteSessions(sessionIds);
      broadcast?.({ type: 'agent-sessions-updated', timestamp: new Date().toISOString() });
      res.json({ deleted });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Delete failed' });
    }
  });

  return router;
}
