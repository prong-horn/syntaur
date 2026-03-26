import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists, writeFileForce } from '../utils/fs.js';
import type { AgentSession, AgentSessionStatus } from './types.js';

/**
 * Parse the markdown table rows from a mission's _index-sessions.md file.
 */
export async function parseSessionsIndex(
  missionDir: string,
  missionSlug: string,
): Promise<AgentSession[]> {
  const filePath = resolve(missionDir, '_index-sessions.md');
  if (!(await fileExists(filePath))) return [];

  const raw = await readFile(filePath, 'utf-8');
  const sessions: AgentSession[] = [];

  // Find the table body (skip frontmatter, heading, header row, separator row)
  const lines = raw.split('\n');
  let inTable = false;
  let headerSeen = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Detect table header
    if (trimmed.startsWith('| Assignment') || trimmed.startsWith('|Assignment')) {
      inTable = true;
      headerSeen = false;
      continue;
    }

    // Skip separator row
    if (inTable && !headerSeen && trimmed.match(/^\|[-\s|]+\|$/)) {
      headerSeen = true;
      continue;
    }

    // Parse data rows
    if (inTable && headerSeen && trimmed.startsWith('|')) {
      const cells = trimmed
        .split('|')
        .slice(1, -1) // remove leading/trailing empty from split
        .map((c) => c.trim());

      if (cells.length >= 6) {
        sessions.push({
          assignmentSlug: cells[0],
          agent: cells[1],
          sessionId: cells[2],
          started: cells[3],
          status: (cells[4] as AgentSessionStatus) || 'active',
          path: cells[5],
          missionSlug,
        });
      }
    }
  }

  return sessions;
}

/**
 * Append a new session row to a mission's _index-sessions.md.
 */
export async function appendSession(
  missionDir: string,
  session: AgentSession,
): Promise<void> {
  const filePath = resolve(missionDir, '_index-sessions.md');
  if (!(await fileExists(filePath))) {
    throw new Error(`Sessions index not found at ${filePath}`);
  }

  const raw = await readFile(filePath, 'utf-8');
  const row = `| ${session.assignmentSlug} | ${session.agent} | ${session.sessionId} | ${session.started} | ${session.status} | ${session.path} |`;
  const updated = raw.trimEnd() + '\n' + row + '\n';

  // Update activeSessions count in frontmatter
  const sessions = await parseSessionsIndex(missionDir, session.missionSlug);
  const activeCount = sessions.filter((s) => s.status === 'active').length + 1;
  const final = updated.replace(
    /^activeSessions:\s*\d+/m,
    `activeSessions: ${activeCount}`,
  );

  await writeFileForce(filePath, final);
}

/**
 * Update a session's status by sessionId.
 */
export async function updateSessionStatus(
  missionDir: string,
  sessionId: string,
  status: AgentSessionStatus,
): Promise<boolean> {
  const filePath = resolve(missionDir, '_index-sessions.md');
  if (!(await fileExists(filePath))) return false;

  const raw = await readFile(filePath, 'utf-8');
  const lines = raw.split('\n');
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('|')) continue;

    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());

    if (cells.length >= 5 && cells[2] === sessionId) {
      cells[4] = status;
      lines[i] = '| ' + cells.join(' | ') + ' |';
      found = true;
      break;
    }
  }

  if (found) {
    // Recount active sessions
    const missionSlug = ''; // not needed for count
    const allSessions = await parseSessionsIndex(missionDir, missionSlug);
    // Account for the update we're about to write
    let activeCount = 0;
    for (const s of allSessions) {
      activeCount += (s.sessionId === sessionId ? status : s.status) === 'active' ? 1 : 0;
    }
    const content = lines
      .join('\n')
      .replace(/^activeSessions:\s*\d+/m, `activeSessions: ${activeCount}`);
    await writeFileForce(filePath, content);
  }

  return found;
}

/**
 * List all sessions across all missions.
 */
export async function listAllSessions(missionsDir: string): Promise<AgentSession[]> {
  if (!(await fileExists(missionsDir))) return [];

  const entries = await readdir(missionsDir, { withFileTypes: true });
  const allSessions: AgentSession[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const missionDir = resolve(missionsDir, entry.name);
    const indexPath = resolve(missionDir, '_index-sessions.md');
    if (!(await fileExists(indexPath))) continue;

    const sessions = await parseSessionsIndex(missionDir, entry.name);
    allSessions.push(...sessions);
  }

  return allSessions;
}

/**
 * List sessions for a specific mission, optionally filtered by assignment.
 */
export async function listMissionSessions(
  missionsDir: string,
  missionSlug: string,
  assignmentSlug?: string,
): Promise<AgentSession[]> {
  const missionDir = resolve(missionsDir, missionSlug);
  const sessions = await parseSessionsIndex(missionDir, missionSlug);
  if (assignmentSlug) {
    return sessions.filter((s) => s.assignmentSlug === assignmentSlug);
  }
  return sessions;
}

// Terminal assignment statuses where sessions cannot still be active
const TERMINAL_ASSIGNMENT_STATUSES = new Set(['completed', 'failed']);
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
  if (!(await fileExists(missionsDir))) return 0;

  const entries = await readdir(missionsDir, { withFileTypes: true });
  let totalUpdated = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const missionDir = resolve(missionsDir, entry.name);
    const indexPath = resolve(missionDir, '_index-sessions.md');
    if (!(await fileExists(indexPath))) continue;

    const sessions = await parseSessionsIndex(missionDir, entry.name);
    const activeSessions = sessions.filter((s) => s.status === 'active');
    if (activeSessions.length === 0) continue;

    // Check assignment statuses for active sessions (dedupe by assignment slug)
    const assignmentStatuses = new Map<string, string>();
    const slugs = new Set(activeSessions.map((s) => s.assignmentSlug));
    for (const slug of slugs) {
      const status = await readAssignmentStatus(missionDir, slug);
      if (status) assignmentStatuses.set(slug, status);
    }

    // Update stale sessions
    for (const session of activeSessions) {
      const assignmentStatus = assignmentStatuses.get(session.assignmentSlug);
      if (!assignmentStatus || !DONE_ASSIGNMENT_STATUSES.has(assignmentStatus)) continue;

      const newStatus: AgentSessionStatus =
        assignmentStatus === 'failed' ? 'stopped' : 'completed';
      await updateSessionStatus(missionDir, session.sessionId, newStatus);
      totalUpdated++;
    }
  }

  return totalUpdated;
}
