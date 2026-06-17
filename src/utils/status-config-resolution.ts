import { readFile, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AssignmentStatus } from '../lifecycle/types.js';
import {
  appendStatusHistoryEntry,
  parseAssignmentFrontmatter,
  updateAssignmentFile,
} from '../lifecycle/frontmatter.js';
import { recordStatusEvent, resolveActor } from '../lifecycle/event-emit.js';
import { listAssignmentsByProject } from './assignment-walk.js';
import { nowTimestamp } from './timestamp.js';

export interface AffectedAssignment {
  /** Absolute path to the assignment.md file. */
  path: string;
  /** Human display label: "<project>/<slug>" or "(standalone) <slug>". */
  display: string;
  projectSlug: string | null;
  assignmentSlug: string;
  status: AssignmentStatus;
}

export type StatusResolution =
  | { id: string; mode: 'remap'; target: string }
  | { id: string; mode: 'delete' };

export type StatusResolutionErrorCode =
  | 'invalid-target'
  | 'duplicate-id'
  | 'stale-resolution'
  | 'scan-failed'
  | 'write-failed'
  | 'delete-failed'
  | 'drift-detected';

export class StatusResolutionError extends Error {
  constructor(message: string, public code: StatusResolutionErrorCode) {
    super(message);
    this.name = 'StatusResolutionError';
  }
}

/**
 * Walk all project and standalone assignments, parse each `assignment.md`,
 * and group those whose `status` matches one of the requested `ids`.
 *
 * Returns a Map keyed by status id, **always pre-populated with an entry
 * for every requested id** (possibly empty). This lets callers
 * distinguish "stale" (id not in map) from "zero-affected" (id in map,
 * list empty).
 *
 * Throws `StatusResolutionError(code: 'scan-failed')` on any read error
 * other than ENOENT (which is treated as the file vanishing between the
 * walk and the read — rare but benign).
 */
export async function scanAssignmentsByStatus(
  projectsDir: string,
  standaloneDir: string | null,
  ids: string[],
): Promise<Map<string, AffectedAssignment[]>> {
  // Always populate an entry for every requested id (possibly empty).
  // This lets `applyStatusResolutions` distinguish "stale" (id not in
  // map) from "zero-affected" (id in map, list empty).
  const result = new Map<string, AffectedAssignment[]>();
  for (const id of ids) result.set(id, []);
  if (ids.length === 0) return result;
  const idSet = new Set(ids);

  const walk = await listAssignmentsByProject(projectsDir, standaloneDir);

  for (const entry of walk.withAssignmentMd) {
    const assignmentPath = `${entry.assignmentDir}/assignment.md`;
    let content: string;
    try {
      content = await readFile(assignmentPath, 'utf-8');
    } catch (err) {
      // Don't swallow IO errors silently — surface them as scan-failed.
      // Silent skip would hide affected assignments and let the server
      // wrongly approve a drop, leaving doctor errors after save.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        // File literally vanished between walk and read (rare race) — skip.
        continue;
      }
      throw new StatusResolutionError(
        `failed to read ${assignmentPath}: ${err instanceof Error ? err.message : String(err)}`,
        'scan-failed',
      );
    }
    const fm = parseAssignmentFrontmatter(content);
    if (!idSet.has(fm.status)) continue;

    const display = entry.standalone
      ? `(standalone) ${entry.assignmentSlug}`
      : `${entry.projectSlug}/${entry.assignmentSlug}`;
    const affected: AffectedAssignment = {
      path: assignmentPath,
      display,
      projectSlug: entry.projectSlug,
      assignmentSlug: entry.assignmentSlug,
      status: fm.status,
    };
    const bucket = result.get(fm.status);
    if (bucket) bucket.push(affected);
  }

  return result;
}

/**
 * Apply a list of resolutions to the affected assignments.
 *
 * Order (per `decision-record.md` Decision 3):
 *   1. Validate (duplicates, stale ids, invalid targets) — no writes.
 *   2. Buffer original content for every file we're about to remap.
 *   3. Remap phase: re-verify status (TOCTOU), rewrite assignment.md.
 *      On any failure, restore from buffer and throw.
 *   4. Delete phase: re-verify status, rm -rf assignment directories.
 *      On failure, throw without rolling back remaps (caller leaves
 *      config un-written so the old config still considers every
 *      remaining assignment's status valid).
 *
 * `validTargets` MUST be `oldIds ∩ newIds` — statuses present in BOTH
 * the pre- and post-mutation status config. Restricting targets this
 * way is what makes Decision 3 safe under post-Step-A config-write
 * failures: every remapped assignment's new status is valid in the old
 * config too, so doctor sees no `assignment.invalid-status`.
 *
 * Returns `{ remapped, deleted }` — counts of files actually touched.
 * Skipped TOCTOU mismatches do not count.
 */
export interface ApplyResult {
  remapped: number;
  deleted: number;
  /** Per-resolution actual counts (after TOCTOU skips). */
  byId: Map<string, { mode: 'remap' | 'delete'; count: number; target?: string }>;
}

export async function applyStatusResolutions(
  resolutions: StatusResolution[],
  affected: Map<string, AffectedAssignment[]>,
  validTargets: Set<string>,
): Promise<ApplyResult> {
  // 1. Validate
  const seenIds = new Set<string>();
  for (const r of resolutions) {
    if (seenIds.has(r.id)) {
      throw new StatusResolutionError(
        `duplicate resolution for status id "${r.id}"`,
        'duplicate-id',
      );
    }
    seenIds.add(r.id);

    if (!affected.has(r.id)) {
      // Stale only if the id wasn't even queried for. A zero-affected
      // resolution (count === 0) is allowed and becomes a no-op below.
      // Distinguish by whether the caller scanned for it: the affected
      // map must contain an entry (possibly empty) for every id in
      // droppedIds. Callers should populate the map accordingly.
      throw new StatusResolutionError(
        `stale resolution: status id "${r.id}" was not scanned`,
        'stale-resolution',
      );
    }

    if (r.mode === 'remap') {
      if (r.target === r.id) {
        throw new StatusResolutionError(
          `invalid remap target "${r.target}" — same as source`,
          'invalid-target',
        );
      }
      if (!validTargets.has(r.target)) {
        throw new StatusResolutionError(
          `invalid remap target "${r.target}" — not in valid targets`,
          'invalid-target',
        );
      }
    }
  }

  // 2. Buffer originals for remap targets only (delete targets don't need a buffer).
  const buffer = new Map<string, string>();
  for (const r of resolutions) {
    if (r.mode !== 'remap') continue;
    const list = affected.get(r.id) ?? [];
    for (const a of list) {
      try {
        const content = await readFile(a.path, 'utf-8');
        buffer.set(a.path, content);
      } catch (err) {
        // File vanished or perms changed between scan and buffer — surface
        // as scan-failed so the caller can map to a clean 5xx instead of a
        // raw ENOENT/EACCES.
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          // Skip silently — assignment is already gone; remap is moot.
          continue;
        }
        throw new StatusResolutionError(
          `failed to buffer ${a.path}: ${err instanceof Error ? err.message : String(err)}`,
          'scan-failed',
        );
      }
    }
  }

  // 3. Remap phase
  const writtenPaths: string[] = [];
  // Pending audit payloads — collected DURING the remap loop but emitted only
  // AFTER all writes in this phase succeed, past the rollback boundary. A later
  // file failure rolls earlier writes back; emitting inside the loop would leave
  // a false event for a rolled-back file (FIX 2).
  const pendingRemapEvents: Array<{
    assignmentId: string;
    projectSlug: string | null;
    at: string;
    from: string;
    to: string;
  }> = [];
  let remapped = 0;
  const byId = new Map<string, { mode: 'remap' | 'delete'; count: number; target?: string }>();
  for (const r of resolutions) {
    if (r.mode === 'remap') byId.set(r.id, { mode: 'remap', count: 0, target: r.target });
    else byId.set(r.id, { mode: 'delete', count: 0 });
  }
  try {
    for (const r of resolutions) {
      if (r.mode !== 'remap') continue;
      const list = affected.get(r.id) ?? [];
      for (const a of list) {
        // Re-read current state to guard against TOCTOU. The buffer holds
        // what we scanned earlier; re-read NOW and check status hasn't
        // drifted.
        let current: string;
        try {
          current = await readFile(a.path, 'utf-8');
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === 'ENOENT') {
            // File vanished between buffer and remap — assignment is gone;
            // remap is moot. Skip silently (mirrors the delete phase).
            continue;
          }
          throw err;
        }
        const fm = parseAssignmentFrontmatter(current);
        if (fm.status !== r.id) {
          console.warn(
            `status-config-resolution: skipping remap of ${a.display} — status drifted from "${r.id}" to "${fm.status}"`,
          );
          continue;
        }
        const now = nowTimestamp();
        const next = appendStatusHistoryEntry(
          updateAssignmentFile(current, {
            status: r.target,
            updated: now,
          }),
          { at: now, from: r.id, to: r.target, command: 'remap', by: null },
        );
        await writeFile(a.path, next, 'utf-8');
        // Defer the audit event past the rollback boundary (FIX 2): collect now,
        // emit only in the success path below.
        pendingRemapEvents.push({
          assignmentId: fm.id,
          projectSlug: a.projectSlug,
          at: now,
          from: r.id,
          to: r.target,
        });
        writtenPaths.push(a.path);
        remapped++;
        const bucket = byId.get(r.id);
        if (bucket) bucket.count++;
      }
    }
  } catch (err) {
    // Rollback every file we successfully wrote in this phase.
    for (const p of writtenPaths) {
      const original = buffer.get(p);
      if (original !== undefined) {
        await writeFile(p, original, 'utf-8').catch((rollbackErr) => {
          console.error(
            `status-config-resolution: rollback write failed for ${p}:`,
            rollbackErr,
          );
        });
      }
    }
    throw new StatusResolutionError(
      `remap write failed: ${err instanceof Error ? err.message : String(err)}`,
      'write-failed',
    );
  }

  // All remap writes succeeded — past the rollback boundary. Emit the audit
  // events now (FIX 2): status remap, actor 'system' (null by).
  for (const e of pendingRemapEvents) {
    recordStatusEvent({
      assignmentId: e.assignmentId,
      projectSlug: e.projectSlug,
      at: e.at,
      actor: resolveActor(null),
      from: e.from,
      to: e.to,
      command: 'remap',
    });
  }

  // 4. Delete phase
  let deleted = 0;
  for (const r of resolutions) {
    if (r.mode !== 'delete') continue;
    const list = affected.get(r.id) ?? [];
    for (const a of list) {
      try {
        const current = await readFile(a.path, 'utf-8');
        const fm = parseAssignmentFrontmatter(current);
        if (fm.status !== r.id) {
          console.warn(
            `status-config-resolution: skipping delete of ${a.display} — status drifted from "${r.id}" to "${fm.status}"`,
          );
          continue;
        }
      } catch {
        // File vanished between scan and delete — skip silently; the
        // intent (delete) is effectively satisfied.
        continue;
      }
      const assignmentDir = dirname(a.path);
      try {
        await rm(assignmentDir, { recursive: true, force: true });
        deleted++;
        const bucket = byId.get(r.id);
        if (bucket) bucket.count++;
      } catch (err) {
        throw new StatusResolutionError(
          `delete failed for ${a.display}: ${err instanceof Error ? err.message : String(err)}`,
          'delete-failed',
        );
      }
    }
  }

  return { remapped, deleted, byId };
}

/**
 * After `applyStatusResolutions` runs, the apply-time TOCTOU re-verify
 * catches drift WITHIN the same dropped id. But an assignment can drift
 * from one dropped id to ANOTHER dropped id between scan and apply (e.g.
 * the user is dropping both A and B; an assignment changes A → B while
 * we're working). In that case the scan saw it as A (skipped because
 * status changed to B at apply time) and B's resolution doesn't include
 * it (scan never saw it as B). Writing the config now would orphan it.
 *
 * This guard does one final scan of the dropped ids against the live
 * filesystem and throws if anything still references one. Call BEFORE
 * writeStatusConfig.
 */
export async function verifyNoDriftedOrphans(
  projectsDir: string,
  standaloneDir: string | null,
  droppedIds: string[],
): Promise<void> {
  if (droppedIds.length === 0) return;
  const finalScan = await scanAssignmentsByStatus(projectsDir, standaloneDir, droppedIds);
  const remaining: string[] = [];
  for (const id of droppedIds) {
    const list = finalScan.get(id) ?? [];
    for (const a of list) {
      remaining.push(`${a.display} (status: ${a.status})`);
    }
  }
  if (remaining.length > 0) {
    throw new StatusResolutionError(
      `concurrent edit detected: ${remaining.length} assignment(s) still reference a dropped status after resolutions applied: ${remaining.join(', ')}`,
      'drift-detected',
    );
  }
}

/**
 * Rename-scope scan (derived-status v3): find every assignment that references
 * a status id ANYWHERE relabeling must reach — headline `status`, cached
 * `phase`, or any statusHistory from/to/phaseFrom/phaseTo. The plain
 * `scanAssignmentsByStatus` only matches the headline, which misses e.g. a
 * blocked assignment whose cached phase uses the renamed id.
 */
export async function scanAssignmentsReferencingStatus(
  projectsDir: string,
  standaloneDir: string | null,
  id: string,
): Promise<AffectedAssignment[]> {
  const walk = await listAssignmentsByProject(projectsDir, standaloneDir);
  const affected: AffectedAssignment[] = [];
  for (const entry of walk.withAssignmentMd) {
    const assignmentPath = `${entry.assignmentDir}/assignment.md`;
    let content: string;
    try {
      content = await readFile(assignmentPath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') continue;
      throw new StatusResolutionError(
        `failed to read ${assignmentPath}: ${err instanceof Error ? err.message : String(err)}`,
        'scan-failed',
      );
    }
    const fm = parseAssignmentFrontmatter(content);
    const inHistory = fm.statusHistory.some(
      (e) => e.from === id || e.to === id || e.phaseFrom === id || e.phaseTo === id,
    );
    if (fm.status !== id && fm.phase !== id && fm.override?.status !== id && !inHistory) continue;
    affected.push({
      path: assignmentPath,
      display: entry.standalone
        ? `(standalone) ${entry.assignmentSlug}`
        : `${entry.projectSlug}/${entry.assignmentSlug}`,
      projectSlug: entry.projectSlug,
      assignmentSlug: entry.assignmentSlug,
      status: fm.status,
    });
  }
  return affected;
}
