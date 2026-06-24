/**
 * One-time backfill: synthesize engagement edges from existing `sessions` rows
 * during the v5->v6 migration, BEFORE the scalar slug columns are dropped.
 *
 * Runs synchronously on the migration's connection, inside the EXCLUSIVE
 * transaction (decision-record.md Decisions 4 & 6). Every session row yields
 * exactly one engagement (the unique index tolerates one open per session):
 *   - `assignment_id` resolved from `(project_slug, assignment_slug)` against the
 *     assignment files on disk via `parseAssignmentFrontmatter`; unresolved => NULL
 *     (the explicit "unattributed" bucket - the common case).
 *   - `active` sessions => OPEN (`ended_at NULL`); terminal sessions => CLOSED with
 *     `ended_at = COALESCE(sessions.ended, transcript mtime, updated_at, started)`
 *     and `close_reason` = `completed` (status completed) else `abandoned`.
 *   - Token snapshots are NULL (no historical cumulative exists).
 */

import type Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { resolve } from 'node:path';
import { syntaurRoot } from '../utils/paths.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';

export interface BackfillCounts {
  backfilled: number;
  attributed: number;
  unattributed: number;
}

interface V5SessionRow {
  session_id: string;
  project_slug: string | null;
  assignment_slug: string | null;
  status: string;
  started: string;
  ended: string | null;
  transcript_path: string | null;
  updated_at: string | null;
}

/**
 * List a directory's entries, returning [] on ANY filesystem error (missing
 * dir, not-a-directory, permission, concurrent removal). The backfill runs
 * inside the v5->v6 migration transaction - an unreadable tree must degrade
 * rows to unattributed, never abort the whole schema migration.
 */
function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readAssignmentId(assignmentMdPath: string): string | null {
  try {
    const fm = parseAssignmentFrontmatter(readFileSync(assignmentMdPath, 'utf-8'));
    return fm.id || null;
  } catch {
    return null;
  }
}

function transcriptMtimeIso(path: string | null): string | null {
  if (!path) return null;
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

/** Unambiguous, text-safe composite key for the project-nested map. */
function projectKey(projectSlug: string, assignmentSlug: string): string {
  return JSON.stringify([projectSlug, assignmentSlug]);
}

/** Build the (project_slug, assignment_slug)->id and standalone-UUID->id maps. */
function buildSlugIdMaps(): {
  project: Map<string, string>;
  standalone: Map<string, string>;
} {
  const root = syntaurRoot();
  const project = new Map<string, string>();
  const standalone = new Map<string, string>();

  const projectsDir = resolve(root, 'projects');
  for (const proj of safeReaddir(projectsDir)) {
    if (!proj.isDirectory()) continue;
    const asgRoot = resolve(projectsDir, proj.name, 'assignments');
    for (const asg of safeReaddir(asgRoot)) {
      if (!asg.isDirectory()) continue;
      const id = readAssignmentId(resolve(asgRoot, asg.name, 'assignment.md'));
      if (id) project.set(projectKey(proj.name, asg.name), id);
    }
  }

  const standaloneDir = resolve(root, 'assignments');
  for (const asg of safeReaddir(standaloneDir)) {
    if (!asg.isDirectory()) continue;
    const id = readAssignmentId(resolve(standaloneDir, asg.name, 'assignment.md'));
    // Standalone sessions store the assignment UUID (= dir name) in
    // `assignment_slug` with `project_slug IS NULL`; key by that UUID.
    if (id) standalone.set(asg.name, id);
  }

  return { project, standalone };
}

export function backfillEngagements(db: Database.Database): BackfillCounts {
  const { project, standalone } = buildSlugIdMaps();

  const sessions = db
    .prepare(
      `SELECT session_id, project_slug, assignment_slug, status, started, ended,
              transcript_path, updated_at
         FROM sessions`,
    )
    .all() as V5SessionRow[];

  const insert = db.prepare(
    `INSERT INTO engagement
       (session_id, assignment_id, project_slug, assignment_slug, stage,
        started_at, ended_at, tokens_at_open, tokens_at_close, close_reason)
     VALUES
       (@session_id, @assignment_id, @project_slug, @assignment_slug, 'implement',
        @started_at, @ended_at, NULL, NULL, @close_reason)`,
  );

  const counts: BackfillCounts = { backfilled: 0, attributed: 0, unattributed: 0 };

  for (const s of sessions) {
    let assignmentId: string | null = null;
    if (s.project_slug && s.assignment_slug) {
      assignmentId = project.get(projectKey(s.project_slug, s.assignment_slug)) ?? null;
    } else if (!s.project_slug && s.assignment_slug) {
      assignmentId = standalone.get(s.assignment_slug) ?? null;
    }

    const isActive = s.status === 'active';
    let endedAt: string | null = null;
    let closeReason: string | null = null;
    if (!isActive) {
      endedAt =
        s.ended ?? transcriptMtimeIso(s.transcript_path) ?? s.updated_at ?? s.started;
      closeReason = s.status === 'completed' ? 'completed' : 'abandoned';
    }

    insert.run({
      session_id: s.session_id,
      assignment_id: assignmentId,
      project_slug: s.project_slug,
      assignment_slug: s.assignment_slug,
      started_at: s.started,
      ended_at: endedAt,
      close_reason: closeReason,
    });

    counts.backfilled++;
    if (assignmentId) counts.attributed++;
    else counts.unattributed++;
  }

  return counts;
}
