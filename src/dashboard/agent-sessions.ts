import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { getSessionDb } from './session-db.js';
import {
  ensureOpenEngagement,
  closeOpenEngagement,
  getOpenEngagement,
  getLatestEngagement,
  hasAnyEngagement,
  insertClosedEngagement,
} from '../db/engagement-db.js';
import { getCumulativeTokenSource, type TokenSnapshot } from '../db/engagement-tokens.js';
import type { AgentSession, AgentSessionStatus } from './types.js';

interface SessionRow {
  session_id: string;
  // project_slug / assignment_slug are NOT columns on `sessions` (v6 moved the
  // scalar binding onto `engagement`). They are PROJECTED here from the session's
  // chosen engagement via SESSION_SELECT_WITH_BINDING below.
  project_slug: string | null;
  assignment_slug: string | null;
  agent: string;
  started: string;
  ended: string | null;
  status: string;
  path: string | null;
  description: string | null;
  transcript_path: string | null;
  pid: number | null;
  pid_started_at: string | null;
  original_head_sha: string | null;
  updated_at: string | null;
}

// Project the session's binding (project/assignment slug) from its single
// CHOSEN engagement — the OPEN one, else the LATEST by started_at — via a
// correlated subquery (NOT a plain JOIN, which would duplicate rows per
// historical engagement). See decision-record.md Decision 8. Every
// `rowToSession` reader routes through this so `getSessionById` /
// `listAllSessions` keep populated bindings for `recreate-target` / `launch`.
const SESSION_SELECT_WITH_BINDING = `
SELECT s.*,
       e.project_slug    AS project_slug,
       e.assignment_slug AS assignment_slug,
       e.assignment_id   AS assignment_id
  FROM sessions s
  LEFT JOIN engagement e ON e.id = (
    SELECT e2.id FROM engagement e2
     WHERE e2.session_id = s.session_id
     ORDER BY (e2.ended_at IS NULL) DESC, e2.started_at DESC, e2.id DESC
     LIMIT 1
  )`;

function rowToSession(row: SessionRow): AgentSession {
  return {
    sessionId: row.session_id,
    projectSlug: row.project_slug ?? null,
    assignmentSlug: row.assignment_slug ?? null,
    agent: row.agent,
    started: row.started,
    ended: row.ended ?? null,
    status: row.status as AgentSessionStatus,
    path: row.path ?? '',
    description: row.description ?? null,
    transcriptPath: row.transcript_path ?? null,
    pid: row.pid ?? null,
    pidStartedAt: row.pid_started_at ?? null,
    originalHeadSha: row.original_head_sha ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Query sessions for a specific project.
 */
export async function parseSessionsIndex(
  _projectDir: string,
  projectSlug: string,
): Promise<AgentSession[]> {
  const db = getSessionDb();
  const rows = db
    .prepare(`${SESSION_SELECT_WITH_BINDING} WHERE e.project_slug = ? ORDER BY s.started DESC`)
    .all(projectSlug) as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * Ensure the session has an OPEN engagement matching its binding, if it doesn't
 * already. Binding comes from `freshBinding` (a payload binding) when present,
 * else is recovered from the session's latest engagement — the revive case,
 * where a stopped session comes back to life with no fresh binding and must keep
 * its prior attribution. A from-history reopen starts a NEW interval at `now`
 * (the revive instant), not the original session start. No-op when an open
 * engagement already exists or no binding can be determined. Must run inside the
 * caller's transaction.
 */
function reopenEngagementIfMissing(
  sessionId: string,
  freshBinding: { projectSlug: string | null; assignmentSlug: string | null } | null,
  freshStartedAt: string,
): void {
  if (getOpenEngagement(sessionId)) return;
  if (freshBinding && (freshBinding.projectSlug || freshBinding.assignmentSlug)) {
    ensureOpenEngagement({
      sessionId,
      projectSlug: freshBinding.projectSlug,
      assignmentSlug: freshBinding.assignmentSlug,
      stage: 'implement',
      startedAt: freshStartedAt,
    });
    return;
  }
  const latest = getLatestEngagement(sessionId);
  if (latest && (latest.project_slug || latest.assignment_slug)) {
    ensureOpenEngagement({
      sessionId,
      assignmentId: latest.assignment_id,
      projectSlug: latest.project_slug,
      assignmentSlug: latest.assignment_slug,
      stage: 'implement',
      startedAt: new Date().toISOString(),
    });
  }
}

/**
 * Upsert a session keyed on `session_id`.
 *
 * On conflict, non-null fields in the new payload fill in missing values on the
 * existing row (COALESCE). `started` / `created_at` from the first insert are
 * preserved. A session already in a terminal state (`completed` / `stopped`)
 * is NOT revived by re-registration — status only moves forward — with one
 * narrow exception: `opts.reviveStopped` lets an `active` payload flip a
 * `stopped` row back to active. Callers may only pass it on live-process
 * evidence (the scanner seeing a process hold the transcript open).
 * `completed` always sticks.
 *
 * Makes registration idempotent across SessionStart hooks, `/track-session`,
 * and grab-assignment all touching the same real session ID.
 */
export async function appendSession(
  _projectDir: string,
  session: AgentSession,
  opts?: { reviveStopped?: boolean },
): Promise<void> {
  const db = getSessionDb();

  // The upsert, the persisted-status read, and the engagement-open run in ONE
  // IMMEDIATE transaction so no concurrent writer (a SessionEnd hook / scanner
  // marking the row terminal + closing its engagement) can interleave between
  // the status read and the open — which would otherwise leak an open engagement
  // onto a now-terminal session (codex round-2 TOCTOU).
  const upsert = db.prepare(`
    INSERT INTO sessions (session_id, agent, started, status, path, description, transcript_path, pid, pid_started_at, original_head_sha)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      agent             = excluded.agent,
      status            = CASE
                            WHEN status = 'completed' THEN status
                            WHEN status = 'stopped' AND NOT (? AND excluded.status = 'active') THEN status
                            ELSE excluded.status
                          END,
      ended             = CASE
                            WHEN status = 'stopped' AND ? AND excluded.status = 'active' THEN NULL
                            ELSE ended
                          END,
      path              = COALESCE(NULLIF(excluded.path, ''),              path),
      description       = COALESCE(NULLIF(excluded.description, ''),       description),
      transcript_path   = COALESCE(NULLIF(excluded.transcript_path, ''),   transcript_path),
      pid               = COALESCE(excluded.pid,                           pid),
      pid_started_at    = COALESCE(NULLIF(excluded.pid_started_at, ''),    pid_started_at),
      original_head_sha = COALESCE(NULLIF(original_head_sha, ''), NULLIF(excluded.original_head_sha, '')),
      updated_at        = datetime('now')
  `);

  const apply = db.transaction(() => {
    upsert.run(
      session.sessionId,
      session.agent,
      session.started,
      session.status,
      session.path,
      session.description ?? null,
      session.transcriptPath ?? null,
      session.pid ?? null,
      session.pidStartedAt ?? null,
      session.originalHeadSha ?? null,
      opts?.reviveStopped ? 1 : 0, // status CASE: revive guard
      opts?.reviveStopped ? 1 : 0, // ended CASE: clear stale ended on revive
    );

    // Reconcile the engagement edge against the PERSISTED status (not the
    // incoming payload — re-registering a terminal row as `active` does NOT
    // revive it; the upsert preserves terminal status above). See Decision 1.
    const persisted = db
      .prepare('SELECT status, ended FROM sessions WHERE session_id = ?')
      .get(session.sessionId) as { status: string; ended: string | null } | undefined;
    const freshBinding = {
      projectSlug: session.projectSlug ?? null,
      assignmentSlug: session.assignmentSlug ?? null,
    };
    if (persisted?.status === 'active') {
      // Live session: ensure an open engagement (fresh binding, else recover the
      // prior binding on a stopped->active revive that arrived with no binding).
      reopenEngagementIfMissing(
        session.sessionId,
        freshBinding,
        session.started ?? new Date().toISOString(),
      );
    } else if (
      persisted &&
      (freshBinding.projectSlug || freshBinding.assignmentSlug) &&
      !hasAnyEngagement(session.sessionId)
    ) {
      // First-seen terminal session (e.g. the scanner discovering a stale
      // stopped transcript) with a binding: preserve it as a CLOSED interval so
      // historical attribution survives — without occupying the one-open slot.
      insertClosedEngagement({
        sessionId: session.sessionId,
        projectSlug: freshBinding.projectSlug,
        assignmentSlug: freshBinding.assignmentSlug,
        startedAt: session.started ?? new Date().toISOString(),
        endedAt: persisted.ended ?? session.started ?? new Date().toISOString(),
        closeReason: persisted.status === 'completed' ? 'completed' : 'abandoned',
      });
    }
  });
  apply.immediate();
}

/**
 * Update a session's status by sessionId.
 * Sets `ended` timestamp for terminal statuses (completed, stopped).
 * `endedAt` (ISO 8601) overrides the default `datetime('now')` so sweeps can
 * backdate `ended` to the transcript's last mtime.
 */
export async function updateSessionStatus(
  _projectDir: string,
  sessionId: string,
  status: AgentSessionStatus,
  endedAt?: string,
): Promise<boolean> {
  const db = getSessionDb();
  const isTerminal = status === 'completed' || status === 'stopped';

  if (!isTerminal) {
    // Status update + (for an active/revive transition) reopening the engagement
    // run in ONE IMMEDIATE transaction so the session never sits active without
    // its binding. Reopen recovers the binding from the latest engagement.
    const apply = db.transaction((): boolean => {
      const res = db
        .prepare(
          'UPDATE sessions SET status = ?, updated_at = datetime(\'now\') WHERE session_id = ?',
        )
        .run(status, sessionId);
      if (res.changes > 0 && status === 'active') {
        reopenEngagementIfMissing(sessionId, null, new Date().toISOString());
      }
      return res.changes > 0;
    });
    return apply.immediate();
  }

  // Terminal transition closes the session's open engagement so the one-open
  // slot is freed and its cost window is bounded (Decision 7; distinct from
  // liveness GC of *dead* sessions — #5). Capture the best-effort token snapshot
  // BEFORE flipping the row terminal (the tokens belong to the work done while
  // it was live), then flip status + close in ONE IMMEDIATE transaction so a
  // concurrent revive can't open a new engagement that this close then clobbers
  // (codex round-2 race).
  let snapshot: TokenSnapshot | null = null;
  try {
    snapshot = await getCumulativeTokenSource()(sessionId);
  } catch {
    snapshot = null;
  }

  const apply = db.transaction((): boolean => {
    const res = db
      .prepare(
        'UPDATE sessions SET status = ?, ended = COALESCE(?, datetime(\'now\')), updated_at = datetime(\'now\') WHERE session_id = ?',
      )
      .run(status, endedAt ?? null, sessionId);
    if (res.changes > 0) {
      closeOpenEngagement(sessionId, {
        closeReason: status === 'completed' ? 'completed' : 'abandoned',
        tokensAtClose: snapshot,
        endedAt: endedAt ?? undefined,
      });
    }
    return res.changes > 0;
  });
  return apply.immediate();
}

/**
 * List all sessions across all projects.
 */
export async function listAllSessions(_projectsDir: string): Promise<AgentSession[]> {
  const db = getSessionDb();
  const rows = db
    .prepare(`${SESSION_SELECT_WITH_BINDING} ORDER BY s.started DESC`)
    .all() as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * Fetch a single session by its agent-assigned session id.
 * Returns null when no row matches. Throws if initSessionDb() has not run.
 */
export function getSessionById(sessionId: string): AgentSession | null {
  const db = getSessionDb();
  const row = db
    .prepare(`${SESSION_SELECT_WITH_BINDING} WHERE s.session_id = ? LIMIT 1`)
    .get(sessionId) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

/**
 * List sessions for a specific project, optionally filtered by assignment.
 */
export async function listProjectSessions(
  _projectsDir: string,
  projectSlug: string,
  assignmentSlug?: string,
): Promise<AgentSession[]> {
  const db = getSessionDb();

  if (assignmentSlug) {
    const rows = db
      .prepare(
        `${SESSION_SELECT_WITH_BINDING} WHERE e.project_slug = ? AND e.assignment_slug = ? ORDER BY s.started DESC`,
      )
      .all(projectSlug, assignmentSlug) as SessionRow[];
    return rows.map(rowToSession);
  }

  const rows = db
    .prepare(`${SESSION_SELECT_WITH_BINDING} WHERE e.project_slug = ? ORDER BY s.started DESC`)
    .all(projectSlug) as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * Delete sessions by their IDs. Returns the number of session rows deleted.
 * Cascades to the `engagement` edge in the same transaction so no orphan
 * engagements remain (they would otherwise still drive usage attribution and
 * doctor scans). There is no FK ON DELETE CASCADE — engagement intentionally has
 * no FK to sessions — so the cascade is explicit.
 */
export async function deleteSessions(sessionIds: string[]): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const db = getSessionDb();
  const placeholders = sessionIds.map(() => '?').join(', ');
  const run = db.transaction((): number => {
    db.prepare(`DELETE FROM engagement WHERE session_id IN (${placeholders})`).run(...sessionIds);
    const result = db
      .prepare(`DELETE FROM sessions WHERE session_id IN (${placeholders})`)
      .run(...sessionIds);
    return result.changes;
  });
  return run.immediate();
}

// Statuses that imply the working session is done (review means agent finished)
const DONE_ASSIGNMENT_STATUSES = new Set(['completed', 'failed', 'review']);

/**
 * Read the status field from an assignment.md frontmatter without full parsing.
 */
async function readAssignmentStatusFromPath(
  assignmentMdPath: string,
): Promise<string | null> {
  if (!(await fileExists(assignmentMdPath))) return null;
  const raw = await readFile(assignmentMdPath, 'utf-8');
  const match = raw.match(/^status:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

async function readAssignmentStatus(
  projectDir: string,
  assignmentSlug: string,
): Promise<string | null> {
  return readAssignmentStatusFromPath(
    resolve(projectDir, 'assignments', assignmentSlug, 'assignment.md'),
  );
}

/**
 * Reconcile active sessions against assignment statuses.
 * Sessions whose assignments have moved to completed/failed/review are
 * marked as completed (or stopped for failed assignments).
 * Standalone sessions (project_slug NULL) are resolved via assignmentsDir.
 * Returns the number of sessions that were updated.
 */
export async function reconcileActiveSessions(
  projectsDir: string,
  assignmentsDir?: string,
): Promise<number> {
  const db = getSessionDb();

  // Reconcile against the session's CURRENTLY OPEN engagement only — a closed
  // historical engagement must never drive a session to completed (Decision 8).
  // Standalone bindings carry project_slug IS NULL on the engagement.
  const activeSessions = db
    .prepare(
      `SELECT s.*, e.project_slug AS project_slug, e.assignment_slug AS assignment_slug
         FROM sessions s
         JOIN engagement e ON e.session_id = s.session_id AND e.ended_at IS NULL
        WHERE s.status = 'active' AND e.assignment_slug IS NOT NULL`,
    )
    .all() as SessionRow[];

  if (activeSessions.length === 0) return 0;

  // Read assignment statuses from disk. Key is `${projectSlug ?? '__standalone__'}/${slug}`.
  const assignmentStatuses = new Map<string, string>();
  const seen = new Set<string>();
  for (const session of activeSessions) {
    const aslug = session.assignment_slug;
    if (!aslug) continue;

    const projectKey = session.project_slug ?? '__standalone__';
    const key = `${projectKey}/${aslug}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (session.project_slug) {
      const status = await readAssignmentStatus(
        resolve(projectsDir, session.project_slug),
        aslug,
      );
      if (status) assignmentStatuses.set(key, status);
    } else if (assignmentsDir) {
      const status = await readAssignmentStatusFromPath(
        resolve(assignmentsDir, aslug, 'assignment.md'),
      );
      if (status) assignmentStatuses.set(key, status);
    }
  }

  // Update stale sessions
  let totalUpdated = 0;
  for (const session of activeSessions) {
    const projectKey = session.project_slug ?? '__standalone__';
    const key = `${projectKey}/${session.assignment_slug}`;
    const assignmentStatus = assignmentStatuses.get(key);
    if (!assignmentStatus || !DONE_ASSIGNMENT_STATUSES.has(assignmentStatus)) continue;

    const newStatus: AgentSessionStatus =
      assignmentStatus === 'failed' ? 'stopped' : 'completed';
    await updateSessionStatus('', session.session_id, newStatus);
    totalUpdated++;
  }

  return totalUpdated;
}

/**
 * List sessions for a resolved assignment (standalone or project-nested).
 * Standalone: filter by assignment_slug = id AND project_slug IS NULL.
 * Project-nested: filter by project_slug + assignment_slug.
 */
export async function listSessionsByAssignment(
  projectSlug: string | null,
  assignmentSlug: string,
): Promise<AgentSession[]> {
  const db = getSessionDb();
  const rows = projectSlug === null
    ? (db
        .prepare(
          `${SESSION_SELECT_WITH_BINDING} WHERE e.assignment_slug = ? AND e.project_slug IS NULL ORDER BY s.started DESC`,
        )
        .all(assignmentSlug) as SessionRow[])
    : (db
        .prepare(
          `${SESSION_SELECT_WITH_BINDING} WHERE e.project_slug = ? AND e.assignment_slug = ? ORDER BY s.started DESC`,
        )
        .all(projectSlug, assignmentSlug) as SessionRow[]);
  return rows.map(rowToSession);
}
