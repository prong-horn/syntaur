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
import { basename, dirname, resolve } from 'node:path';
import { readConfig } from '../utils/config.js';
import { getWorkflowBundle, DEFAULT_WORKFLOW_ID } from '../utils/workflow-resolve.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { syntaurRoot } from '../utils/paths.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { computeFacts, resolveBindingEnv } from './facts.js';
import { computeEngineStep, type EngineMove } from './engine-step.js';
import { appendComment } from './comment-append.js';
import type { AssignmentFrontmatter } from './types.js';
import { deriveDimensions, type DerivedDimensions } from './derive.js';
import { buildDeriveContext, type DeriveContext } from './derive-context.js';
import {
  makeWorkflowContextResolver,
  type WorkflowContextResolver,
} from './workflow-context.js';
import {
  appendStatusHistoryEntry,
  parseAssignmentFrontmatter,
  updateAssignmentFile,
} from './frontmatter.js';
import { recordStatusEvent, resolveActor } from './event-emit.js';

// Re-exported so the many `import { DeriveContext } from '.../recompute.js'`
// call sites keep resolving after the interface moved to its leaf module.
export type { DeriveContext } from './derive-context.js';
export type { WorkflowContextResolver } from './workflow-context.js';

const LOCK_FILE = '.derive.lock';
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 50;
const LOCK_MAX_WAITS = 100; // ~5s
const CAS_RETRIES = 3;

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

/**
 * The stage-engine activation marker (Phase 1 / WS-2). SEPARATE from
 * `derive-migrated` on purpose (WS-2 Decision 2): the sweep gates
 * (`server.ts`, `derive-verbs.ts`) stay on `isDeriveMigrated()` so the ladder
 * keeps moving the live board; the engine-vs-ladder choice is a branch INSIDE
 * {@link recomputeAndWrite} gated on `isStagesMigrated() && ctx.stageWorkflow`.
 * The marker stays UNSET through WS-2 (the engine wiring is dormant, exercised
 * only by fixtures that set it) — WS-3's migration calls
 * {@link markStagesMigrated} after seeding per-file workflows + stage positions
 * on all live tickets, flipping the whole board onto the engine at once.
 */
const STAGES_MARKER = 'stages-migrated';

export async function isStagesMigrated(): Promise<boolean> {
  return fileExists(resolve(syntaurRoot(), STAGES_MARKER));
}

export async function markStagesMigrated(): Promise<void> {
  await writeFileForce(resolve(syntaurRoot(), STAGES_MARKER), `${nowTimestamp()}\n`);
}

/** Resolve the derive context for ONE workflow id (default `'default'`) from
 * config.md. For `'default'` in a legacy config with no `workflows:` block this
 * is the top-level `statuses:` bundle — byte-identical to the pre-workflow
 * behavior, so global/default callers are unaffected. Callers doing many
 * recomputes across workflows should use {@link resolveRecomputeContext} +
 * `workflowResolver` so each ticket derives against its OWN workflow. */
export async function resolveDeriveContext(
  workflowId: string = DEFAULT_WORKFLOW_ID,
): Promise<DeriveContext> {
  const config = await readConfig();
  return buildDeriveContext(getWorkflowBundle(config, workflowId));
}

/** Resolve BOTH the default-lifecycle context (back-compat fallback) and a
 * per-ticket workflow resolver in a SINGLE config read. Recompute callers that
 * act on a specific assignment pass `workflowResolver` into the recompute opts;
 * {@link recomputeAndWrite} then resolves that ticket's own workflow context
 * (derive/terminal/known/registry) from its fresh frontmatter + project binding.
 * `context` stays the default-lifecycle fallback for callers that pass no
 * resolver. The resolver memoizes contexts by workflow id and bindings by dir,
 * so a sweep reuses one warm compile cache per workflow. */
export async function resolveRecomputeContext(): Promise<{
  context: DeriveContext;
  workflowResolver: WorkflowContextResolver;
}> {
  const config = await readConfig();
  return {
    context: buildDeriveContext(getWorkflowBundle(config, DEFAULT_WORKFLOW_ID)),
    workflowResolver: makeWorkflowContextResolver(config),
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
  /** Default-lifecycle derive context — the fallback used when no
   * `workflowResolver` is supplied (legacy single-workflow path). */
  context: DeriveContext;
  /** Per-ticket workflow resolver (memoized by workflow id + project dir). When
   * present, recompute resolves THIS assignment's own workflow context from its
   * fresh frontmatter + project binding, so each ticket derives/gates/defers
   * against its own workflow. Absent → `context` is used. */
  workflowResolver?: WorkflowContextResolver;
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
  /**
   * WS-2 (migrated path): the write-move that drives the engine step. Default
   * `{kind:'gate'}` (a fact-change recompute cascades gate routes). Ignored on
   * the ladder path (marker unset / no per-file workflow).
   */
  engineMove?: EngineMove;
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
  /** WS-2: the write went through the stage engine (vs the ladder). */
  viaEngine?: boolean;
  /** WS-2: this write landed the ticket on a SUCCESS terminal stage — the caller
   * runs the terminal side effects (linked-todos) after lock release (Task 2.5). */
  successTerminal?: boolean;
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
  // WS-2 Decision 2: the engine-vs-ladder choice is IN here (not the sweep
  // gates). `stages-migrated` unset OR no per-file workflow → the ladder path,
  // byte-for-byte unchanged (golden-tested).
  const stagesMigrated = await isStagesMigrated();
  // Engine success is captured here and returned AFTER the lock releases, so its
  // dissent-note copy (an external comments.md side effect) runs post-release,
  // not while holding the assignment lock (codex review major 4).
  let engineResult: RecomputeResult | null = null;
  let engineDissentNotes: Array<{ author: string; body: string }> = [];
  let engineDissentRef = '';
  const release = await acquireLock(assignmentDir);
  try {
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
      const original = await readFile(assignmentPath, 'utf-8');
      const hash = contentHash(original);

      // Terminal check on the FRESH read, inside the lock — a concurrent
      // completion between caller and lock acquisition freezes facts here.
      const originalFm = parseAssignmentFrontmatter(original);
      // Resolve the ticket's OWN workflow context from its fresh frontmatter +
      // project binding (per-workflow derive/terminal/known/registry). The
      // `workflow`/`type` binding fields don't change under a fact mutate, so
      // resolving from `originalFm` is stable for this transaction. Absent
      // resolver → the default-lifecycle `context` (legacy single-workflow).
      const wctx = opts.workflowResolver
        ? await opts.workflowResolver.forAssignment(originalFm, opts.projectDir)
        : null;
      const ctx = wctx ? wctx.deriveContext : opts.context;
      const stageWorkflow = stagesMigrated ? (wctx?.stageWorkflow ?? null) : null;
      const engineActive = stageWorkflow !== null;

      // Terminal set: the engine's own terminal STAGE ids when migrated (codex
      // r3 finding 5 — the legacy `DeriveContext` terminal set may differ), else
      // the workflow's `completed/failed` set.
      const terminalStatuses =
        engineActive && stageWorkflow
          ? new Set(stageWorkflow.stages.filter((s) => s.terminal).map((s) => s.id))
          : ctx.terminalStatuses;

      const move: EngineMove = opts.engineMove ?? { kind: 'gate' };
      // Terminal defer: a frozen terminal ticket does not re-derive (a `reopen`
      // move is the only way out). Engine path uses the engine terminal set.
      if (terminalStatuses.has(originalFm.status) && !(engineActive && move.kind === 'reopen')) {
        return { changed: false, status: originalFm.status, dimensions: null, deferredTerminal: true };
      }

      // Apply the caller's fact mutation as part of this transaction.
      const content = opts.mutate ? await opts.mutate(original) : original;
      const mutated = content !== original;
      const frontmatter = mutated ? parseAssignmentFrontmatter(content) : originalFm;

      // Per-dependency terminal predicate (codex r4): resolve each dependency's
      // OWN workflow terminal set so a mixed-workflow edge isn't misclassified.
      const depTerminalFor =
        engineActive && opts.workflowResolver
          ? async (depFm: AssignmentFrontmatter): Promise<ReadonlySet<string> | null> => {
              const sw = await opts.workflowResolver!.stageWorkflowFor(depFm, opts.projectDir);
              return sw ? new Set(sw.stages.filter((s) => s.terminal).map((s) => s.id)) : null;
            }
          : undefined;

      const facts = await computeFacts({
        assignmentDir,
        frontmatter,
        body: extractBody(content),
        projectDir: opts.projectDir,
        terminalStatuses,
        declarations: ctx.factDeclarations,
        depTerminalFor,
      });

      // ── WS-2 engine branch (dormant until `stages-migrated` + a per-file
      //    workflow). Runs the pure engine step, assembles the single CAS
      //    payload, writes once. Falls back to the ladder if the stored status
      //    isn't a stage in this workflow. ─────────────────────────────────────
      if (engineActive && stageWorkflow) {
        const at = nowTimestamp();
        const env = await resolveBindingEnv(stageWorkflow, frontmatter, assignmentDir);
        const step = computeEngineStep({
          content,
          frontmatter,
          facts,
          workflow: stageWorkflow,
          env,
          move,
          cause: opts.cause,
          by: opts.by,
          reason: opts.reason,
          at,
        });
        if (step) {
          if (!step.changed) {
            // No engine movement — but a fact mutation still has to land.
            if (mutated) {
              const cur = await readFile(assignmentPath, 'utf-8');
              if (contentHash(cur) !== hash) continue;
              await writeFileForce(assignmentPath, content);
              return {
                changed: true,
                status: step.finalStatus,
                dimensions: null,
                deferredTerminal: false,
                viaEngine: true,
              };
            }
            return {
              changed: false,
              status: step.finalStatus,
              dimensions: null,
              deferredTerminal: false,
              viaEngine: true,
            };
          }
          const cur = await readFile(assignmentPath, 'utf-8');
          if (contentHash(cur) !== hash) continue;
          await writeFileForce(assignmentPath, step.nextContent);
          if (step.finalStatus !== originalFm.status) {
            recordStatusEvent({
              assignmentId: frontmatter.id,
              projectSlug: frontmatter.project,
              at,
              actor: resolveActor(opts.by),
              from: originalFm.status,
              to: step.finalStatus,
              command: opts.cause,
            });
          }
          // Task 2.7: capture each newly-fired dissent note; the copy into
          // comments.md runs AFTER the lock releases (major 4). Best-effort there.
          engineDissentNotes = step.firedDissents
            .filter((d): d is typeof d & { note: string } => Boolean(d.note))
            .map((d) => ({ author: d.actor, body: d.note }));
          engineDissentRef = frontmatter.slug || frontmatter.id;
          engineResult = {
            changed: true,
            status: step.finalStatus,
            dimensions: null,
            deferredTerminal: false,
            viaEngine: true,
            successTerminal: step.successTerminal,
          };
          break;
        }
        // step === null → the stored status isn't a stage here; fall through.
      }

      const dims = deriveDimensions({
        facts,
        derive: ctx.derive,
        currentStatus: frontmatter.status,
        terminalStatuses: ctx.terminalStatuses,
        knownStatusIds: ctx.knownStatusIds,
        override: frontmatter.override,
        registry: ctx.registry,
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

      // Audit event (best-effort): this is the dimension-change status write
      // (from !== to is implied by statusChanged, but recordStatusEvent
      // self-guards on from===to regardless — R5). Actor is the recompute's
      // own resolved `by` (null → 'system').
      recordStatusEvent({
        assignmentId: frontmatter.id,
        projectSlug: frontmatter.project,
        at,
        actor: resolveActor(opts.by),
        from: frontmatter.status,
        to: dims.status,
        command: opts.cause,
      });

      return { changed: true, status: dims.status, dimensions: dims, deferredTerminal: false };
    }
    // The loop ended. If the engine success path broke out, its result is
    // finished post-release below; otherwise the CAS retries were exhausted.
    if (!engineResult) {
      const frontmatter = parseAssignmentFrontmatter(await readFile(assignmentPath, 'utf-8'));
      return {
        changed: false,
        status: frontmatter.status,
        dimensions: null,
        deferredTerminal: false,
        warning: `recompute skipped after ${CAS_RETRIES} concurrent-edit retries: ${assignmentPath}`,
      };
    }
  } finally {
    await release();
  }

  // Lock released — run the engine's post-release side effects (Task 2.7 dissent
  // note copy into comments.md; best-effort, never undoes the status move), then
  // return the captured engine result (codex review major 4).
  if (engineResult) {
    for (const note of engineDissentNotes) {
      try {
        await appendComment({
          assignmentDir,
          assignmentRef: engineDissentRef,
          author: note.author,
          type: 'feedback',
          body: note.body,
        });
      } catch {
        /* best-effort: keep the status move even if the note copy fails */
      }
    }
    return engineResult;
  }
  // Unreachable: the loop returned, threw, or set engineResult before breaking.
  throw new Error(`recomputeAndWrite: no result after lock release for ${assignmentPath}`);
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
  // Each dependent may resolve to a different workflow; ensure a resolver so
  // siblings derive against their OWN workflow (built once, memoized).
  const workflowResolver = opts.workflowResolver ?? makeWorkflowContextResolver(await readConfig());
  const results: RecomputeResult[] = [];
  for (const slug of entries) {
    if (slug === changedSlug) continue;
    const path = resolve(assignmentsDir, slug, 'assignment.md');
    if (!(await fileExists(path))) continue;
    try {
      const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
      if (!fm.dependsOn.includes(changedSlug)) continue;
      results.push(await recomputeAndWrite(path, { ...opts, projectDir, workflowResolver }));
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

  // One resolver for the whole sweep: memoizes a derive context per workflow id
  // (warm compile cache) and a binding per project dir, so a mixed-workflow
  // board re-derives each ticket against its OWN workflow at near single-context
  // cost. Built once here unless the caller already supplied one.
  const workflowResolver = opts.workflowResolver ?? makeWorkflowContextResolver(await readConfig());

  const sweepOne = async (path: string, projectDir: string | null): Promise<void> => {
    summary.scanned++;
    try {
      const result = await recomputeAndWrite(path, { ...opts, projectDir, workflowResolver });
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

/**
 * Best-effort recompute keyed by an assignment DIRECTORY, for explicit
 * file-mutating CLI verbs (`plan create`/`plan version`/`capture`) that change a
 * file-derived fact (planExists / planApproved-invalidation) but don't flow
 * through the `assertFact` spine. Resolves the derive context and infers
 * `projectDir` from the directory layout (`<projectDir>/assignments/<slug>` →
 * projectDir; standalone → null). EXPLICIT trigger: runs regardless of the
 * migration gate (the verb is a deliberate per-assignment act). Never throws —
 * the verb's primary effect already succeeded — returning null on any failure.
 */
export async function recomputeAssignmentDir(
  assignmentDir: string,
  cause: string,
  by: string | null,
): Promise<RecomputeResult | null> {
  try {
    const assignmentPath = resolve(assignmentDir, 'assignment.md');
    if (!(await fileExists(assignmentPath))) return null;
    const parent = dirname(assignmentDir);
    const projectDir = basename(parent) === 'assignments' ? dirname(parent) : null;
    const { context, workflowResolver } = await resolveRecomputeContext();
    return await recomputeAndWrite(assignmentPath, {
      cause,
      by,
      projectDir,
      context,
      workflowResolver,
    });
  } catch {
    return null;
  }
}
