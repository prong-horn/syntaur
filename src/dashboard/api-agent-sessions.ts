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
import { listSessionUsage, type SessionUsage } from '../db/usage-db.js';
import { resolveShortForSession, type SessionResolution } from './daemon-join.js';
import type { PtyTokenRegistry } from './pty-token.js';
import type {
  AgentSessionDetail,
  AgentSessionStatus,
  AgentSessionWithLiveness,
  DaemonSessionState,
  WsMessage,
} from './types.js';

/** Phase D browser-attach seams: the shared token registry + the daemon join
 * (injectable so the detail/mint routes are unit-testable without a daemon). */
export interface AgentSessionsRouterDeps {
  ptyTokens?: PtyTokenRegistry;
  resolveShort?: (sessionId: string) => Promise<SessionResolution | null>;
}

const TERMINAL_DAEMON_STATES: ReadonlySet<DaemonSessionState> = new Set(['done', 'failed', 'stopped']);

/**
 * Attach per-session spend to enriched session rows, and — only when the caller
 * opts in — append synthetic rows for session ids that exist in `usage_events`
 * but were never tracked.
 *
 * The orphan rows are deliberately opt-in: every other `useAgentSessions`
 * consumer (overview rails, widgets, saved views) would otherwise start showing
 * rows that have no transcript, no liveness, and no actions. They are appended
 * AFTER liveness enrichment so they can never reach `reconcileActiveSessions`
 * or the liveness probes.
 *
 * Usage is best-effort: when the usage DB was never initialized in this server
 * context, sessions still render (without spend) rather than 500ing.
 */
function attachUsage(
  sessions: AgentSessionWithLiveness[],
  opts: { includeUsageOnly: boolean },
): AgentSessionWithLiveness[] {
  let usageBySession: Map<string, SessionUsage>;
  try {
    usageBySession = listSessionUsage();
  } catch {
    return sessions;
  }

  const summarize = (u: SessionUsage) => ({
    totalCost: u.totalCost,
    totalTokens: u.totalTokens,
    models: u.models,
  });

  const withUsage: AgentSessionWithLiveness[] = sessions.map((session) => {
    const usage = usageBySession.get(session.sessionId);
    return { ...session, usage: usage ? summarize(usage) : null };
  });
  if (!opts.includeUsageOnly) return withUsage;

  const tracked = new Set(sessions.map((s) => s.sessionId));
  const orphans: AgentSessionWithLiveness[] = [];
  for (const [sessionId, usage] of usageBySession) {
    if (tracked.has(sessionId)) continue;
    orphans.push({
      projectSlug: null,
      assignmentSlug: null,
      agent: usage.tool || 'unknown',
      sessionId,
      started: usage.firstEventTs ?? '',
      ended: null,
      status: 'stopped',
      path: usage.cwd ?? '',
      description: null,
      transcriptPath: null,
      pid: null,
      activity: null,
      usage: summarize(usage),
      usageOnly: true,
      isLive: false,
      resumeSupported: false,
      forkSupported: false,
    });
  }
  return [...withUsage, ...orphans];
}

export function createAgentSessionsRouter(
  projectsDir: string,
  broadcast?: (msg: WsMessage) => void,
  assignmentsDir?: string,
  deps: AgentSessionsRouterDeps = {},
): Router {
  const router = Router();
  const resolveShort = deps.resolveShort ?? ((sessionId: string) => resolveShortForSession(sessionId));

  // GET /api/agent-sessions/by-id/:sessionId — one session enriched with the
  // daemon join (short id, attachability, live state, or the settled final
  // screen). Registered before /:projectSlug so `by-id` matches literally.
  router.get('/by-id/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!isSafeSessionId(sessionId)) {
        res.status(400).json({ error: 'Invalid session id' });
        return;
      }
      const base = getSessionById(sessionId);
      if (!base) {
        res.status(404).json({ error: `Session "${sessionId}" not found` });
        return;
      }
      const agents = getAgents(await readConfig());
      const [enriched] = enrichSessions([base], agents);
      const resolution = await resolveShort(sessionId);
      const detail: AgentSessionDetail = {
        ...enriched,
        syntaurdShortId: resolution?.short ?? null,
        attachable: false,
      };
      if (resolution?.live) {
        detail.attachable = true;
        detail.syntaurdState = resolution.state;
        if (resolution.needs != null) detail.needs = resolution.needs;
      } else if (resolution) {
        const st = resolution.jobState?.state ?? resolution.state;
        if (st && TERMINAL_DAEMON_STATES.has(st) && resolution.jobState) {
          detail.settled = {
            lastScreen: resolution.jobState.lastScreen ?? null,
            cols: resolution.jobState.cols,
            rows: resolution.jobState.rows,
            exitCode: resolution.jobState.exitCode ?? null,
            exitSignal: resolution.jobState.exitSignal ?? null,
            state: st,
          };
        } else {
          // daemon-hosted but not reachable and not terminal → retryable
          detail.daemonUnavailable = true;
        }
      }
      res.json({ session: detail, generatedAt: new Date().toISOString() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load session' });
    }
  });

  // POST /api/agent-sessions/by-id/:sessionId/pty-token — mint a single-use,
  // short-lived token for the pty WebSocket upgrade. Only for a live session.
  router.post('/by-id/:sessionId/pty-token', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!isSafeSessionId(sessionId)) {
        res.status(400).json({ error: 'Invalid session id' });
        return;
      }
      if (!deps.ptyTokens) {
        res.status(503).json({ error: 'Browser attach is not enabled' });
        return;
      }
      const resolution = await resolveShort(sessionId);
      if (!resolution) {
        res.status(404).json({ error: `Session "${sessionId}" not found` });
        return;
      }
      if (!resolution.live) {
        res.status(409).json({ error: 'Session is not live and cannot be attached' });
        return;
      }
      res.json(deps.ptyTokens.mint(resolution.short));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to mint token' });
    }
  });

  // GET /api/agent-sessions — all sessions across all projects
  router.get('/', async (req, res) => {
    try {
      await reconcileActiveSessions(projectsDir, assignmentsDir);
      const sessions = await listAllSessions(projectsDir);
      const agents = getAgents(await readConfig());
      const includeUsageOnly = req.query.includeUsageOnly === '1';
      res.json({
        sessions: attachUsage(enrichSessions(sessions, agents), { includeUsageOnly }),
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
        // Usage attached, but never orphan rows: a usage-only session has no
        // project binding, so it cannot belong to a project-scoped listing.
        sessions: attachUsage(enrichSessions(sessions, agents), { includeUsageOnly: false }),
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
