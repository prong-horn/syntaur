import { Router } from 'express';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  listAllSessions,
  listProjectSessions,
  appendSession,
  updateSessionStatus,
  deleteSessions,
  reconcileActiveSessions,
} from './agent-sessions.js';
import { fileExists } from '../utils/fs.js';
import type { AgentSessionStatus, WsMessage } from './types.js';

export function createAgentSessionsRouter(
  projectsDir: string,
  broadcast?: (msg: WsMessage) => void,
): Router {
  const router = Router();

  // GET /api/agent-sessions — all sessions across all projects
  router.get('/', async (_req, res) => {
    try {
      await reconcileActiveSessions(projectsDir);
      const sessions = await listAllSessions(projectsDir);
      res.json({ sessions, generatedAt: new Date().toISOString() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list sessions' });
    }
  });

  // GET /api/agent-sessions/:projectSlug — sessions for one project
  router.get('/:projectSlug', async (req, res) => {
    try {
      const { projectSlug } = req.params;
      const assignment = req.query.assignment as string | undefined;
      const projectDir = resolve(projectsDir, projectSlug);
      if (!(await fileExists(projectDir))) {
        res.status(404).json({ error: `Project "${projectSlug}" not found` });
        return;
      }
      await reconcileActiveSessions(projectsDir);
      const sessions = await listProjectSessions(projectsDir, projectSlug, assignment);
      res.json({ sessions, generatedAt: new Date().toISOString() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list sessions' });
    }
  });

  // POST /api/agent-sessions — register a new session
  router.post('/', async (req, res) => {
    try {
      const { projectSlug, assignmentSlug, agent, sessionId, path, description } = req.body;

      if (!agent) {
        res.status(400).json({ error: 'agent is required' });
        return;
      }

      if (projectSlug) {
        const projectDir = resolve(projectsDir, projectSlug);
        if (!(await fileExists(projectDir))) {
          res.status(404).json({ error: `Project "${projectSlug}" not found` });
          return;
        }
      }

      const id = sessionId || randomUUID();
      const session = {
        projectSlug: projectSlug || null,
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
