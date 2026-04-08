import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { getSessionDb } from './session-db.js';
import type { AgentSession, AgentSessionStatus } from './types.js';

interface SessionRow {
  session_id: string;
  mission_slug: string | null;
  assignment_slug: string | null;
  agent: string;
  started: string;
  ended: string | null;
  status: string;
  path: string | null;
  description: string | null;
}

function rowToSession(row: SessionRow): AgentSession {
  return {
    sessionId: row.session_id,
    missionSlug: row.mission_slug ?? null,
    assignmentSlug: row.assignment_slug ?? null,
    agent: row.agent,
    started: row.started,
    ended: row.ended ?? null,
    status: row.status as AgentSessionStatus,
    path: row.path ?? '',
    description: row.description ?? null,
  };
}

/**
 * Query sessions for a specific mission.
 */
export async function parseSessionsIndex(
  _missionDir: string,
  missionSlug: string,
): Promise<AgentSession[]> {
  const db = getSessionDb();
  const rows = db
    .prepare('SELECT * FROM sessions WHERE mission_slug = ? ORDER BY started DESC')
    .all(missionSlug) as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * Insert a new session into the database.
 */
export async function appendSession(
  _missionDir: string,
  session: AgentSession,
): Promise<void> {
  const db = getSessionDb();
  db.prepare(`
    INSERT INTO sessions (session_id, mission_slug, assignment_slug, agent, started, status, path, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.sessionId,
    session.missionSlug ?? null,
    session.assignmentSlug ?? null,
    session.agent,
    session.started,
    session.status,
    session.path,
    session.description ?? null,
  );
}

/**
 * Update a session's status by sessionId.
 * Sets `ended` timestamp for terminal statuses (completed, stopped).
 */
export async function updateSessionStatus(
  _missionDir: string,
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
 * List all sessions across all missions.
 */
export async function listAllSessions(_missionsDir: string): Promise<AgentSession[]> {
  const db = getSessionDb();
  const rows = db
    .prepare('SELECT * FROM sessions ORDER BY started DESC')
    .all() as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * List sessions for a specific mission, optionally filtered by assignment.
 */
export async function listMissionSessions(
  _missionsDir: string,
  missionSlug: string,
  assignmentSlug?: string,
): Promise<AgentSession[]> {
  const db = getSessionDb();

  if (assignmentSlug) {
    const rows = db
      .prepare(
        'SELECT * FROM sessions WHERE mission_slug = ? AND assignment_slug = ? ORDER BY started DESC',
      )
      .all(missionSlug, assignmentSlug) as SessionRow[];
    return rows.map(rowToSession);
  }

  const rows = db
    .prepare('SELECT * FROM sessions WHERE mission_slug = ? ORDER BY started DESC')
    .all(missionSlug) as SessionRow[];
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
async function readAssignmentStatus(
  missionDir: string,
  assignmentSlug: string,
): Promise<string | null> {
  const assignmentPath = resolve(missionDir, 'assignments', assignmentSlug, 'assignment.md');
  if (!(await fileExists(assignmentPath))) return null;

  const raw = await readFile(assignmentPath, 'utf-8');
  const match = raw.match(/^status:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Reconcile active sessions against assignment statuses.
 * Sessions whose assignments have moved to completed/failed/review are
 * marked as completed (or stopped for failed assignments).
 * Returns the number of sessions that were updated.
 */
export async function reconcileActiveSessions(
  missionsDir: string,
): Promise<number> {
  const db = getSessionDb();

  // Get active sessions that are linked to a mission/assignment (standalone sessions have nothing to reconcile)
  const activeSessions = db
    .prepare('SELECT * FROM sessions WHERE status = \'active\' AND mission_slug IS NOT NULL AND assignment_slug IS NOT NULL')
    .all() as SessionRow[];

  if (activeSessions.length === 0) return 0;

  // Dedupe assignment slugs per mission for status checks
  // mission_slug and assignment_slug are guaranteed non-null by the query filter above
  const toCheck = new Map<string, Set<string>>();
  for (const session of activeSessions) {
    const slugs = toCheck.get(session.mission_slug!) ?? new Set();
    slugs.add(session.assignment_slug!);
    toCheck.set(session.mission_slug!, slugs);
  }

  // Read assignment statuses from disk
  const assignmentStatuses = new Map<string, string>();
  for (const [missionSlug, slugs] of toCheck) {
    const missionDir = resolve(missionsDir, missionSlug);
    for (const slug of slugs) {
      const status = await readAssignmentStatus(missionDir, slug);
      if (status) assignmentStatuses.set(`${missionSlug}/${slug}`, status);
    }
  }

  // Update stale sessions
  let totalUpdated = 0;
  for (const session of activeSessions) {
    const key = `${session.mission_slug}/${session.assignment_slug}`;
    const assignmentStatus = assignmentStatuses.get(key);
    if (!assignmentStatus || !DONE_ASSIGNMENT_STATUSES.has(assignmentStatus)) continue;

    const newStatus: AgentSessionStatus =
      assignmentStatus === 'failed' ? 'stopped' : 'completed';
    await updateSessionStatus('', session.session_id, newStatus);
    totalUpdated++;
  }

  return totalUpdated;
}
