import { Router } from 'express';
import { resolve } from 'node:path';
import {
  listAllSessions,
  listProjectSessions,
  appendSession,
  updateSessionStatus,
  SessionResurrectionError,
  deleteSessions,
  reconcileActiveSessions,
  getSessionById,
} from './agent-sessions.js';
import { fileExists } from '../utils/fs.js';
import { isSafeSessionId } from '../utils/session-id.js';
import { resolveAssignmentBySlug } from '../utils/assignment-resolver.js';
import { assignmentsDir as assignmentsDirFn } from '../utils/paths.js';
import { derivePathFromTranscript } from '../utils/transcript.js';
import { enrichSessions } from './session-liveness.js';
import { getAgents, readConfig } from '../utils/config.js';
import { captureProcessStartedAt } from '../utils/process-info.js';
import { captureHeadSha } from '../utils/git-worktree.js';
import { isExistingDir } from '../launch/cwd.js';
import { recreateForTarget, recreateOutcomeToHttp } from './worktree-recreate.js';
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

      // L gate (1): a malformed/arbitrary session id must not open or
      // mis-attribute an engagement. `assertMayMutate` is a no-op here (an
      // HTTP-supplied id resolves to EXPLICIT provenance), so the real guard is
      // format validation + assignment-existence below — not provenance.
      if (!isSafeSessionId(sessionId)) {
        res.status(400).json({
          error: 'sessionId is malformed. Pass the real agent-generated session id.',
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

      // L gate (2) + M1: when the POST BINDS to an assignment, the assignment
      // must exist (else this opens/mis-attributes a window for a phantom
      // assignment). Resolve once: `.exists` gates the bind, `.id` is stored as
      // the engagement's `assignment_id` so a later stage assertion won't split
      // the interval to repair the id. A registration-only POST (no
      // `assignmentSlug`) is NOT gated — it registers the bare session.
      let assignmentId: string | null = null;
      if (assignmentSlug) {
        const resolvedAssignment = await resolveAssignmentBySlug(
          projectsDir,
          assignmentsDir ?? assignmentsDirFn(),
          projectSlug || null,
          assignmentSlug,
        );
        if (!resolvedAssignment.exists) {
          res.status(404).json({ error: `Assignment "${assignmentSlug}" not found` });
          return;
        }
        assignmentId = resolvedAssignment.id;
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

      // Best-effort capture of the worktree's HEAD sha so a later recreate of a
      // deleted worktree can be exact. Never blocks registration on git.
      const originalHeadSha = isExistingDir(recordedPath)
        ? await captureHeadSha(recordedPath)
        : null;

      const session = {
        // L: a POST with no assignmentSlug is registration-only (unbound) — do
        // NOT open a project-bound engagement for an arbitrary session. Binding
        // requires a validated assignment selector (existence-checked above).
        projectSlug: assignmentSlug ? projectSlug || null : null,
        assignmentSlug: assignmentSlug || null,
        assignmentId,
        agent,
        sessionId,
        started: new Date().toISOString(),
        status: 'active' as AgentSessionStatus,
        path: recordedPath,
        description: description || null,
        transcriptPath: transcriptPath || null,
        pid,
        pidStartedAt,
        originalHeadSha,
      };

      await appendSession('', session);
      broadcast?.({ type: 'agent-sessions-updated', timestamp: new Date().toISOString() });
      res.status(201).json({ sessionId });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Registration failed' });
    }
  });

  // POST /api/agent-sessions/:sessionId/worktree/recreate — rebuild a deleted
  // worktree at the session's exact recorded path so `claude --resume <id>` can
  // find the transcript again. Server-authoritative (path/repo/branch derived
  // from the session row + its linked assignment, never the request body).
  router.post('/:sessionId/worktree/recreate', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const outcome = await recreateForTarget(
        { projectsDir, assignmentsDir: assignmentsDir ?? '' },
        { kind: 'session', id: sessionId },
      );
      const { httpStatus, body } = recreateOutcomeToHttp(outcome);
      res.status(httpStatus).json(body);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to recreate worktree',
      });
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
      // A completed session is final — reviving it to active is refused, not a 500.
      if (error instanceof SessionResurrectionError) {
        res.status(409).json({ error: error.message });
        return;
      }
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
