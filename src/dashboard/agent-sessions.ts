import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { getSessionDb } from './session-db.js';
import type { AgentSession, AgentSessionStatus } from './types.js';

interface SessionRow {
  session_id: string;
  project_slug: string | null;
  assignment_slug: string | null;
  agent: string;
  started: string;
  ended: string | null;
  status: string;
  path: string | null;
  description: string | null;
  transcript_path: string | null;
}

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
    .prepare('SELECT * FROM sessions WHERE project_slug = ? ORDER BY started DESC')
    .all(projectSlug) as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * Upsert a session keyed on `session_id`.
 *
 * On conflict, non-null fields in the new payload fill in missing values on the
 * existing row (COALESCE). `started` / `created_at` from the first insert are
 * preserved. A session already in a terminal state (`completed` / `stopped`)
 * is NOT revived by re-registration — status only moves forward.
 *
 * Makes registration idempotent across SessionStart hooks, `/track-session`,
 * and grab-assignment all touching the same real session ID.
 */
export async function appendSession(
  _projectDir: string,
  session: AgentSession,
): Promise<void> {
  const db = getSessionDb();
  db.prepare(`
    INSERT INTO sessions (session_id, project_slug, assignment_slug, agent, started, status, path, description, transcript_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      project_slug    = COALESCE(NULLIF(excluded.project_slug, ''),    project_slug),
      assignment_slug = COALESCE(NULLIF(excluded.assignment_slug, ''), assignment_slug),
      agent           = excluded.agent,
      status          = CASE WHEN status IN ('completed','stopped') THEN status ELSE excluded.status END,
      path            = COALESCE(NULLIF(excluded.path, ''),            path),
      description     = COALESCE(NULLIF(excluded.description, ''),     description),
      transcript_path = COALESCE(NULLIF(excluded.transcript_path, ''), transcript_path),
      updated_at      = datetime('now')
  `).run(
    session.sessionId,
    session.projectSlug ?? null,
    session.assignmentSlug ?? null,
    session.agent,
    session.started,
    session.status,
    session.path,
    session.description ?? null,
    session.transcriptPath ?? null,
  );
}

/**
 * Update a session's status by sessionId.
 * Sets `ended` timestamp for terminal statuses (completed, stopped).
 */
export async function updateSessionStatus(
  _projectDir: string,
  sessionId: string,
  status: AgentSessionStatus,
): Promise<boolean> {
  const db = getSessionDb();
  const isTerminal = status === 'completed' || status === 'stopped';

  const result = isTerminal
    ? db
        .prepare(
          'UPDATE sessions SET status = ?, ended = datetime(\'now\'), updated_at = datetime(\'now\') WHERE session_id = ?',
        )
        .run(status, sessionId)
    : db
        .prepare(
          'UPDATE sessions SET status = ?, updated_at = datetime(\'now\') WHERE session_id = ?',
        )
        .run(status, sessionId);

  return result.changes > 0;
}

/**
 * List all sessions across all projects.
 */
export async function listAllSessions(_projectsDir: string): Promise<AgentSession[]> {
  const db = getSessionDb();
  const rows = db
    .prepare('SELECT * FROM sessions ORDER BY started DESC')
    .all() as SessionRow[];
  return rows.map(rowToSession);
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
        'SELECT * FROM sessions WHERE project_slug = ? AND assignment_slug = ? ORDER BY started DESC',
      )
      .all(projectSlug, assignmentSlug) as SessionRow[];
    return rows.map(rowToSession);
  }

  const rows = db
    .prepare('SELECT * FROM sessions WHERE project_slug = ? ORDER BY started DESC')
    .all(projectSlug) as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * Delete sessions by their IDs. Returns the number of rows deleted.
 */
export async function deleteSessions(sessionIds: string[]): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const db = getSessionDb();
  const placeholders = sessionIds.map(() => '?').join(', ');
  const result = db
    .prepare(`DELETE FROM sessions WHERE session_id IN (${placeholders})`)
    .run(...sessionIds);
  return result.changes;
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

  // Include standalone sessions (project_slug NULL) when assignmentsDir is provided.
  const activeSessions = db
    .prepare('SELECT * FROM sessions WHERE status = \'active\' AND assignment_slug IS NOT NULL')
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
          'SELECT * FROM sessions WHERE assignment_slug = ? AND project_slug IS NULL ORDER BY started DESC',
        )
        .all(assignmentSlug) as SessionRow[])
    : (db
        .prepare(
          'SELECT * FROM sessions WHERE project_slug = ? AND assignment_slug = ? ORDER BY started DESC',
        )
        .all(projectSlug, assignmentSlug) as SessionRow[]);
  return rows.map(rowToSession);
}
