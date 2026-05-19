import { Router } from 'express';
import { resolve } from 'node:path';
import {
  listAllSessions,
  listProjectSessions,
  appendSession,
  updateSessionStatus,
  deleteSessions,
  reconcileActiveSessions,
  getSessionById,
} from './agent-sessions.js';
import { fileExists } from '../utils/fs.js';
import { derivePathFromTranscript } from '../utils/transcript.js';
import { enrichSessions } from './session-liveness.js';
import { getAgents, readConfig } from '../utils/config.js';
import { captureProcessStartedAt } from '../utils/process-info.js';
import type { AgentSessionStatus, WsMessage } from './types.js';

export function createAgentSessionsRouter(
  projectsDir: string,
  broadcast?: (msg: WsMessage) => void,
  assignmentsDir?: string,
): Router {
  const router = Router();

  // GET /api/agent-sessions — all sessions across all projects
  router.get('/', async (_req, res) => {
    try {
      await reconcileActiveSessions(projectsDir, assignmentsDir);
      const sessions = await listAllSessions(projectsDir);
      const agents = getAgents(await readConfig());
      res.json({
        sessions: enrichSessions(sessions, agents),
        generatedAt: new Date().toISOString(),
      });
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
      await reconcileActiveSessions(projectsDir, assignmentsDir);
      const sessions = await listProjectSessions(projectsDir, projectSlug, assignment);
      const agents = getAgents(await readConfig());
      res.json({
        sessions: enrichSessions(sessions, agents),
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list sessions' });
    }
  });

  // POST /api/agent-sessions — register a new session
  router.post('/', async (req, res) => {
    try {
      const { projectSlug, assignmentSlug, agent, sessionId, path, description, transcriptPath, pid: rawPid } =
        req.body;

      if (!agent) {
        res.status(400).json({ error: 'agent is required' });
        return;
      }

      if (!sessionId) {
        res.status(400).json({
          error:
            'sessionId is required. Pass the real agent-generated session id — do not synthesize one.',
        });
        return;
      }

      if (projectSlug) {
        const projectDir = resolve(projectsDir, projectSlug);
        if (!(await fileExists(projectDir))) {
          res.status(404).json({ error: `Project "${projectSlug}" not found` });
          return;
        }
      }

      // Prefer the launch cwd recorded inside the transcript over whatever
      // path the caller posted — the transcript is what determines where
      // Claude Code files the conversation, and the only directory from
      // which `claude --resume <id>` will find it.
      const derivedPath = await derivePathFromTranscript(transcriptPath);
      const recordedPath = derivedPath ?? path ?? '';

      const pid =
        typeof rawPid === 'number' && Number.isFinite(rawPid) && rawPid > 0
          ? rawPid
          : null;
      const pidStartedAt = pid !== null ? captureProcessStartedAt(pid) : null;

      const session = {
        projectSlug: projectSlug || null,
        assignmentSlug: assignmentSlug || null,
        agent,
        sessionId,
        started: new Date().toISOString(),
        status: 'active' as AgentSessionStatus,
        path: recordedPath,
        description: description || null,
        transcriptPath: transcriptPath || null,
        pid,
        pidStartedAt,
      };

      await appendSession('', session);
      broadcast?.({ type: 'agent-sessions-updated', timestamp: new Date().toISOString() });
      res.status(201).json({ sessionId });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Registration failed' });
    }
  });

  // PATCH /api/agent-sessions/:sessionId — terminal-only status update.
  // Used by the Mark-stopped affordance on session rows; the
  // /:sessionId/status route below remains available for full status updates
  // (non-terminal allowed) used by other internal flows. Express precedence
  // matches the more specific /:sessionId/status route first.
  router.patch('/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const status = (req.body ?? {}).status;
      if (status !== 'stopped' && status !== 'completed') {
        res.status(400).json({
          error: 'status must be one of: stopped, completed',
        });
        return;
      }
      if (!getSessionById(sessionId)) {
        res.status(404).json({ error: `Session "${sessionId}" not found` });
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
