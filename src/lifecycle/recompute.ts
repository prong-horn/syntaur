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
  normalizeFactDeclarations,
  readConfig,
  type DeriveConfig,
  type FactDeclaration,
} from '../utils/config.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { syntaurRoot } from '../utils/paths.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { computeFacts } from './facts.js';
import {
  acceptFactDeclarations,
  buildDeriveRegistry,
  deriveDimensions,
  type DerivedDimensions,
} from './derive.js';
import type { FieldRegistry } from '../utils/query/index.js';
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
  /** ACCEPTED custom-fact declarations (normalize→accept output) — resolved
   * once and passed to computeFacts so every recompute speaks one vocabulary. */
  factDeclarations: FactDeclaration[];
  /** Derive registry built from the accepted declarations — ONE per config
   * resolution so the compile-condition cache stays warm across sweeps. */
  registry: FieldRegistry;
}

/**
 * One-time migration marker (rollout safety): IMPLICIT recompute triggers —
 * the dashboard boot sweep, watcher-driven recomputes, config-change sweeps —
 * stay dormant until `syntaur migrate-derive` has seeded facts. Without this,
 * upgrading the dashboard would re-derive every in-flight assignment before
 * its implementationStarted/reviewRequested standing was seeded, regressing
 * real work. EXPLICIT actions (CLI verbs, dashboard transitions, `syntaur
 * recompute`) are deliberate per-assignment acts and run regardless — their
 * output shows the derived result plainly.
 */
const MIGRATION_MARKER = 'derive-migrated';

export async function isDeriveMigrated(): Promise<boolean> {
  return fileExists(resolve(syntaurRoot(), MIGRATION_MARKER));
}

export async function markDeriveMigrated(): Promise<void> {
  await writeFileForce(resolve(syntaurRoot(), MIGRATION_MARKER), `${nowTimestamp()}\n`);
}

/** Resolve the derive context from config.md (defaults when unconfigured).
 * Callers doing many recomputes (sweeps) resolve once and pass it down. */
export async function resolveDeriveContext(): Promise<DeriveContext> {
  const config = await readConfig();
  const statusConfig = config.statuses ?? buildDefaultStatusConfig();
  const terminal = new Set(statusConfig.statuses.filter((s) => s.terminal).map((s) => s.id));
  // Run the full pipeline ONCE: raw → normalize (drop malformed) → accept (drop
  // collisions). Every consumer of this context uses the ACCEPTED list/registry.
  const accepted = acceptFactDeclarations(normalizeFactDeclarations(config.statuses?.facts ?? null));
  return {
    derive: config.statuses?.derive ?? DEFAULT_DERIVE_CONFIG,
    terminalStatuses: terminal.size > 0 ? terminal : DEFAULT_TERMINAL_STATUSES,
    knownStatusIds: new Set(statusConfig.statuses.map((s) => s.id)),
    factDeclarations: accepted,
    registry: buildDeriveRegistry(accepted),
  };
}

/** Acquire the per-assignment advisory lock. Returns a release function.
 * The lockfile carries an ownership token: release unlinks only when the
 * token still matches, so a holder that was staleness-evicted cannot unlink
 * its REPLACEMENT's lock (codex code-review finding 14).
 *
 * Accepted residual (codex r2 finding 6): the read-token-then-unlink pair is
 * itself a (microseconds-wide) TOCTOU — unlink-by-path is the POSIX ceiling
 * without fd-based locking. With cooperating writers, a 30s staleness window
 * vs ms-scale critical sections, and content-CAS behind the lock as a second
 * line of defense, the residual risk is accepted for single-host use. */
async function acquireLock(assignmentDir: string): Promise<() => Promise<void>> {
  const lockPath = resolve(assignmentDir, LOCK_FILE);
  const token = `${process.pid}:${createHash('sha256').update(`${Math.random()}${Date.now()}`).digest('hex').slice(0, 12)}`;
  for (let attempt = 0; attempt <= LOCK_MAX_WAITS; attempt++) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(token, 'utf-8');
      await handle.close();
      return async () => {
        try {
          const current = await readFile(lockPath, 'utf-8');
          if (current === token) await unlink(lockPath);
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
  /**
   * Optional fact mutation applied INSIDE the lock + CAS loop, after the
   * terminal check and before fact computation — so fact-write + derivation
   * are one transaction (codex finding: a pre-lock fact write could race a
   * concurrent completion or lose against another verb). Receives the
   * freshly-read content; returns the mutated content.
   */
  mutate?: (content: string) => Promise<string> | string;
  /**
   * Opt-in audit entry (AC9): when a mutation ran but dimensions did NOT change,
   * append a same-status history entry `{at, from: status, to: status, command:
   * cause, by}` (no phase/dispo keys) and bump `updated`. Only the new `fact
   * set` / `attest` verbs set this; existing verbs keep today's no-entry
   * behavior on dimension-stable mutations bit-for-bit.
   */
  auditMutation?: boolean;
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
      const original = await readFile(assignmentPath, 'utf-8');
      const hash = contentHash(original);

      // Terminal check on the FRESH read, inside the lock — a concurrent
      // completion between caller and lock acquisition freezes facts here.
      const originalFm = parseAssignmentFrontmatter(original);
      if (opts.context.terminalStatuses.has(originalFm.status)) {
        return { changed: false, status: originalFm.status, dimensions: null, deferredTerminal: true };
      }

      // Apply the caller's fact mutation as part of this transaction.
      const content = opts.mutate ? await opts.mutate(original) : original;
      const mutated = content !== original;
      const frontmatter = mutated ? parseAssignmentFrontmatter(content) : originalFm;

      const facts = await computeFacts({
        assignmentDir,
        frontmatter,
        body: extractBody(content),
        projectDir: opts.projectDir,
        terminalStatuses: opts.context.terminalStatuses,
        declarations: opts.context.factDeclarations,
      });

      const dims = deriveDimensions({
        facts,
        derive: opts.context.derive,
        currentStatus: frontmatter.status,
        terminalStatuses: opts.context.terminalStatuses,
        knownStatusIds: opts.context.knownStatusIds,
        override: frontmatter.override,
        registry: opts.context.registry,
      });
      if (dims === null) {
        return { changed: false, status: frontmatter.status, dimensions: null, deferredTerminal: true };
      }

      const statusChanged = dims.status !== frontmatter.status;
      const phaseChanged = dims.phase !== frontmatter.phase;
      const dispositionChanged = dims.disposition !== frontmatter.disposition;
      if (!statusChanged && !phaseChanged && !dispositionChanged) {
        // No dimension change — but a fact mutation still has to land.
        if (mutated) {
          let toWrite = content;
          if (opts.auditMutation) {
            // AC9: record the fact/attestation mutation as a same-status entry
            // and bump `updated`, even though no dimension moved.
            const at = nowTimestamp();
            toWrite = updateAssignmentFile(toWrite, { updated: at });
            toWrite = appendStatusHistoryEntry(toWrite, {
              at,
              from: frontmatter.status,
              to: frontmatter.status,
              command: opts.cause,
              by: opts.by,
              ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
            });
          }
          const current = await readFile(assignmentPath, 'utf-8');
          if (contentHash(current) !== hash) continue;
          await writeFileForce(assignmentPath, toWrite);
          return { changed: true, status: frontmatter.status, dimensions: dims, deferredTerminal: false };
        }
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

      // Content CAS vs the ORIGINAL read: a non-cooperating writer (human
      // editor) may have raced us. Re-read and verify before the atomic rename.
      const current = await readFile(assignmentPath, 'utf-8');
      if (contentHash(current) !== hash) {
        continue; // retry the whole read-mutate-compute-write cycle
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
