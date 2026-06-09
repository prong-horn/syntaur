/**
 * The ONE authoritative mutation protocol for derived status (design v3,
 * Piece 3). Every dimension write — CLI fact mutations, watcher-triggered
 * recomputes, reconciliation sweeps, migration — flows through
 * `recomputeAndWrite`, so locking, CAS, history recording, and terminal
 * deference live in exactly one place.
 *
 * Locking: a per-assignment advisory lockfile (`.derive.lock`, O_EXCL with
 * pid+timestamp, stale takeover after 30s) serializes cooperating writers
 * (CLI + dashboard server — both call this function). Content-hash CAS with
 * bounded retry narrows the residual race against NON-cooperating writers
 * (human editors); on exhaustion we surface a warning instead of clobbering.
 *
 * What never happens here: no timer-driven calls (time-based facts are
 * payload-only flags), no recompute of terminal assignments (they defer until
 * `reopen`), no write when nothing changed.
 */

import { createHash } from 'node:crypto';
import { open, readdir, readFile, unlink, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  DEFAULT_DERIVE_CONFIG,
  buildDefaultStatusConfig,
  readConfig,
  type DeriveConfig,
} from '../utils/config.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { computeFacts } from './facts.js';
import { deriveDimensions, type DerivedDimensions } from './derive.js';
import {
  appendStatusHistoryEntry,
  parseAssignmentFrontmatter,
  updateAssignmentFile,
} from './frontmatter.js';
import { DEFAULT_TERMINAL_STATUSES } from './types.js';

const LOCK_FILE = '.derive.lock';
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 50;
const LOCK_MAX_WAITS = 100; // ~5s
const CAS_RETRIES = 3;

export interface DeriveContext {
  derive: DeriveConfig;
  terminalStatuses: ReadonlySet<string>;
  knownStatusIds: ReadonlySet<string>;
}

/** Resolve the derive context from config.md (defaults when unconfigured).
 * Callers doing many recomputes (sweeps) resolve once and pass it down. */
export async function resolveDeriveContext(): Promise<DeriveContext> {
  const config = await readConfig();
  const statusConfig = config.statuses ?? buildDefaultStatusConfig();
  const terminal = new Set(statusConfig.statuses.filter((s) => s.terminal).map((s) => s.id));
  return {
    derive: config.statuses?.derive ?? DEFAULT_DERIVE_CONFIG,
    terminalStatuses: terminal.size > 0 ? terminal : DEFAULT_TERMINAL_STATUSES,
    knownStatusIds: new Set(statusConfig.statuses.map((s) => s.id)),
  };
}

/** Acquire the per-assignment advisory lock. Returns a release function. */
async function acquireLock(assignmentDir: string): Promise<() => Promise<void>> {
  const lockPath = resolve(assignmentDir, LOCK_FILE);
  for (let attempt = 0; attempt <= LOCK_MAX_WAITS; attempt++) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(`${process.pid} ${Date.now()}`, 'utf-8');
      await handle.close();
      return async () => {
        try {
          await unlink(lockPath);
        } catch {
          /* already gone — fine */
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // Stale-lock takeover: a crashed holder leaves the file behind.
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat — retry immediately
      }
      await new Promise((r) => setTimeout(r, LOCK_WAIT_MS));
    }
  }
  throw new Error(`Timed out waiting for ${lockPath} (held > ${(LOCK_WAIT_MS * LOCK_MAX_WAITS) / 1000}s)`);
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function extractBody(content: string): string {
  const m = content.match(/^---\n[\s\S]*?\n---/);
  return m ? content.slice(m[0].length) : content;
}

export interface RecomputeOptions {
  /** Recorded as the history entry's `command` (e.g. 'plan-approve', 'derive', 'migrate'). */
  cause: string;
  /** Actor — 'human', 'agent:<id>', or 'system' for watcher/sweep recomputes. */
  by: string | null;
  /** Project dir for dependency facts; null for standalone assignments. */
  projectDir: string | null;
  context: DeriveContext;
  /** Optional reason carried onto the history entry (pin/block causes). */
  reason?: string;
}

export interface RecomputeResult {
  changed: boolean;
  /** Effective headline after recompute (unchanged when deferred/no-op). */
  status: string;
  dimensions: DerivedDimensions | null;
  /** True when the assignment is terminal and derivation deferred entirely. */
  deferredTerminal: boolean;
  /** Set when CAS retries were exhausted — caller should surface it. */
  warning?: string;
}

/**
 * Recompute one assignment's dimensions and persist them if anything changed.
 * Appends a dimension-aware statusHistory entry via the same serializer the
 * command transitions use — derived changes are recorded by the existing path.
 */
export async function recomputeAndWrite(
  assignmentPath: string,
  opts: RecomputeOptions,
): Promise<RecomputeResult> {
  const assignmentDir = dirname(assignmentPath);
  const release = await acquireLock(assignmentDir);
  try {
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
      const content = await readFile(assignmentPath, 'utf-8');
      const hash = contentHash(content);
      const frontmatter = parseAssignmentFrontmatter(content);

      // Terminal defers entirely — only `reopen` re-enters derivation.
      if (opts.context.terminalStatuses.has(frontmatter.status)) {
        return { changed: false, status: frontmatter.status, dimensions: null, deferredTerminal: true };
      }

      const facts = await computeFacts({
        assignmentDir,
        frontmatter,
        body: extractBody(content),
        projectDir: opts.projectDir,
        terminalStatuses: opts.context.terminalStatuses,
      });

      const dims = deriveDimensions({
        facts,
        derive: opts.context.derive,
        currentStatus: frontmatter.status,
        terminalStatuses: opts.context.terminalStatuses,
        knownStatusIds: opts.context.knownStatusIds,
        override: frontmatter.override,
      });
      if (dims === null) {
        return { changed: false, status: frontmatter.status, dimensions: null, deferredTerminal: true };
      }

      const statusChanged = dims.status !== frontmatter.status;
      const phaseChanged = dims.phase !== frontmatter.phase;
      const dispositionChanged = dims.disposition !== frontmatter.disposition;
      if (!statusChanged && !phaseChanged && !dispositionChanged) {
        return { changed: false, status: frontmatter.status, dimensions: dims, deferredTerminal: false };
      }

      const at = nowTimestamp();
      let next = updateAssignmentFile(content, {
        status: dims.status,
        phase: dims.phase,
        disposition: dims.disposition,
        updated: at,
      });
      next = appendStatusHistoryEntry(next, {
        at,
        from: frontmatter.status,
        to: dims.status,
        command: opts.cause,
        by: opts.by,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        ...(phaseChanged ? { phaseFrom: frontmatter.phase, phaseTo: dims.phase } : {}),
        ...(dispositionChanged
          ? { dispositionFrom: frontmatter.disposition, dispositionTo: dims.disposition }
          : {}),
      });

      // Content CAS: a non-cooperating writer (human editor) may have raced us
      // between read and write. Re-read and verify before the atomic rename.
      const current = await readFile(assignmentPath, 'utf-8');
      if (contentHash(current) !== hash) {
        continue; // retry the whole read-compute-write cycle
      }
      await writeFileForce(assignmentPath, next);
      return { changed: true, status: dims.status, dimensions: dims, deferredTerminal: false };
    }
    const frontmatter = parseAssignmentFrontmatter(await readFile(assignmentPath, 'utf-8'));
    return {
      changed: false,
      status: frontmatter.status,
      dimensions: null,
      deferredTerminal: false,
      warning: `recompute skipped after ${CAS_RETRIES} concurrent-edit retries: ${assignmentPath}`,
    };
  } finally {
    await release();
  }
}

/**
 * Reverse-dependency recompute: when `changedSlug` transitions (notably to a
 * terminal status), every sibling that `dependsOn` it gets its `depsSatisfied`
 * fact refreshed.
 */
export async function recomputeDependents(
  projectDir: string,
  changedSlug: string,
  opts: Omit<RecomputeOptions, 'projectDir'>,
): Promise<RecomputeResult[]> {
  const assignmentsDir = resolve(projectDir, 'assignments');
  let entries: string[];
  try {
    entries = await readdir(assignmentsDir);
  } catch {
    return [];
  }
  const results: RecomputeResult[] = [];
  for (const slug of entries) {
    if (slug === changedSlug) continue;
    const path = resolve(assignmentsDir, slug, 'assignment.md');
    if (!(await fileExists(path))) continue;
    try {
      const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
      if (!fm.dependsOn.includes(changedSlug)) continue;
      results.push(await recomputeAndWrite(path, { ...opts, projectDir }));
    } catch {
      // unparseable sibling — doctor's territory, not ours
    }
  }
  return results;
}

export interface SweepSummary {
  scanned: number;
  changed: number;
  deferredTerminal: number;
  warnings: string[];
}

/**
 * Reconciliation sweep: recompute every assignment under a projects dir (and
 * optionally a standalone-assignments dir). Used on dashboard-server boot
 * (catches edits made while it was down), on config.md changes (the rules
 * changed → everything re-derives), by `syntaur recompute --all`, and by the
 * migration. Lazy reads stay read-only — this is the only bulk write path.
 */
export async function recomputeAll(
  projectsDir: string,
  standaloneDir: string | null,
  opts: Omit<RecomputeOptions, 'projectDir'>,
): Promise<SweepSummary> {
  const summary: SweepSummary = { scanned: 0, changed: 0, deferredTerminal: 0, warnings: [] };

  const sweepOne = async (path: string, projectDir: string | null): Promise<void> => {
    summary.scanned++;
    try {
      const result = await recomputeAndWrite(path, { ...opts, projectDir });
      if (result.changed) summary.changed++;
      if (result.deferredTerminal) summary.deferredTerminal++;
      if (result.warning) summary.warnings.push(result.warning);
    } catch (err) {
      summary.warnings.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  let projects: string[] = [];
  try {
    projects = await readdir(projectsDir);
  } catch {
    /* no projects dir */
  }
  for (const project of projects) {
    const projectDir = resolve(projectsDir, project);
    const assignmentsDir = resolve(projectDir, 'assignments');
    let slugs: string[] = [];
    try {
      slugs = await readdir(assignmentsDir);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const path = resolve(assignmentsDir, slug, 'assignment.md');
      if (await fileExists(path)) await sweepOne(path, projectDir);
    }
  }

  if (standaloneDir) {
    let ids: string[] = [];
    try {
      ids = await readdir(standaloneDir);
    } catch {
      /* none */
    }
    for (const id of ids) {
      const path = resolve(standaloneDir, id, 'assignment.md');
      if (await fileExists(path)) await sweepOne(path, null);
    }
  }

  return summary;
}
