/**
 * Fact-assertion verbs (derived-status design v3, Piece 4 + command→fact
 * mapping). Under the derived model, commands don't SET status — they assert
 * facts; status follows from derivation. Every verb here mutates frontmatter
 * facts and then runs the one authoritative recompute, reporting the derived
 * outcome (including when it differs from what the caller might expect —
 * honesty over surprise).
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expandHome, assignmentsDir as assignmentsDirFn } from '../utils/paths.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';
import {
  parseAssignmentFrontmatter,
  updateAssignmentFile,
  updateOverride,
  updatePlanApproval,
} from '../lifecycle/frontmatter.js';
import { latestPlanFile, planDigest } from '../lifecycle/facts.js';
import {
  recomputeAndWrite,
  resolveDeriveContext,
  type DeriveContext,
  type RecomputeResult,
} from '../lifecycle/recompute.js';

export interface DeriveVerbOptions {
  project?: string;
  dir?: string;
  agent?: string;
  reason?: string;
}

interface ResolvedTarget {
  assignmentDir: string;
  assignmentPath: string;
  projectDir: string | null;
}

async function resolveTarget(assignment: string, options: DeriveVerbOptions): Promise<ResolvedTarget> {
  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;

  if (options.project) {
    if (!isValidSlug(options.project)) throw new Error(`Invalid project slug "${options.project}".`);
    if (!isValidSlug(assignment)) throw new Error(`Invalid assignment slug "${assignment}".`);
    const projectDir = resolve(baseDir, options.project);
    const assignmentDir = resolve(projectDir, 'assignments', assignment);
    const assignmentPath = resolve(assignmentDir, 'assignment.md');
    if (!(await fileExists(assignmentPath))) {
      throw new Error(`Assignment "${assignment}" not found at ${assignmentPath}.`);
    }
    return { assignmentDir, assignmentPath, projectDir };
  }

  const resolved = await resolveAssignmentById(baseDir, assignmentsDirFn(), assignment);
  if (!resolved) {
    throw new Error(`Assignment "${assignment}" not found. Provide --project <slug> or a valid standalone UUID.`);
  }
  return {
    assignmentDir: resolved.assignmentDir,
    assignmentPath: resolve(resolved.assignmentDir, 'assignment.md'),
    projectDir: resolved.standalone ? null : resolve(resolved.assignmentDir, '..', '..'),
  };
}

/** Actor attribution: explicit --agent, else the bound session in cwd's
 * .syntaur/context.json, else 'human'. Metadata, not a correctness anchor. */
async function inferActor(options: DeriveVerbOptions): Promise<string> {
  if (options.agent) return `agent:${options.agent}`;
  try {
    const raw = await readFile(resolve(process.cwd(), '.syntaur', 'context.json'), 'utf-8');
    const ctx = JSON.parse(raw) as { sessionId?: string };
    if (ctx.sessionId) return `agent:${ctx.sessionId.slice(0, 8)}`;
  } catch {
    /* no bound session */
  }
  return 'human';
}

function reportDerived(label: string, result: RecomputeResult): void {
  const dims = result.dimensions;
  if (result.deferredTerminal) {
    console.log(`${label} — assignment is terminal; derivation deferred (reopen to re-enter).`);
    return;
  }
  const parts = [`status: ${result.status}`];
  if (dims) {
    parts.push(`phase: ${dims.phase}`, `disposition: ${dims.disposition}`);
    if (dims.status !== dims.derivedStatus) parts.push(`pinned (would otherwise be ${dims.derivedStatus})`);
    if (dims.nextAction) parts.push(`next: ${dims.nextAction}`);
  }
  console.log(`${label} — ${parts.join(' · ')}`);
  if (result.warning) console.warn(`Warning: ${result.warning}`);
}

/**
 * Shared spine for every fact verb. The mutation runs INSIDE
 * recomputeAndWrite's lock + CAS loop — one transaction with derivation — so
 * concurrent verbs can't lose updates and a concurrent completion can't be
 * overwritten with stale non-terminal content (codex code-review finding 2).
 * Terminal assignments surface a clear error instead of a silent defer.
 */
async function assertFact(
  assignment: string,
  options: DeriveVerbOptions,
  cause: string,
  mutate: (content: string, target: ResolvedTarget) => Promise<string> | string,
  label: string,
): Promise<RecomputeResult> {
  const target = await resolveTarget(assignment, options);
  const context = await resolveDeriveContext();

  const result = await recomputeAndWrite(target.assignmentPath, {
    cause,
    by: await inferActor(options),
    projectDir: target.projectDir,
    context,
    reason: options.reason,
    mutate: (content) => mutate(content, target),
  });
  if (result.deferredTerminal) {
    throw new Error(
      `Assignment is ${result.status} (terminal) — facts are frozen. Use \`syntaur reopen\` first.`,
    );
  }
  reportDerived(label, result);
  return result;
}

// ── plan approval ───────────────────────────────────────────────────────────

export async function planApproveCommand(assignment: string, options: DeriveVerbOptions): Promise<void> {
  await assertFact(
    assignment,
    options,
    'plan-approve',
    async (content, target) => {
      const planFile = await latestPlanFile(target.assignmentDir);
      if (!planFile) {
        throw new Error('No plan file found (plan.md / plan-v*.md). Write a plan before approving.');
      }
      const planContent = await readFile(resolve(target.assignmentDir, planFile), 'utf-8');
      return updatePlanApproval(content, {
        file: planFile,
        digest: planDigest(planContent),
        by: await inferActor(options),
        at: nowTimestamp(),
      });
    },
    'Plan approved (revision-bound)',
  );
}

export async function planUnapproveCommand(assignment: string, options: DeriveVerbOptions): Promise<void> {
  await assertFact(assignment, options, 'plan-unapprove', (content) => updatePlanApproval(content, null), 'Plan approval cleared');
}

// ── park / review / implementation facts ───────────────────────────────────

export async function parkCommand(assignment: string, options: DeriveVerbOptions): Promise<void> {
  await assertFact(
    assignment,
    options,
    'park',
    (content) => updateAssignmentFile(content, { parked: true }),
    'Parked',
  );
}

export async function unparkCommand(assignment: string, options: DeriveVerbOptions): Promise<void> {
  await assertFact(
    assignment,
    options,
    'unpark',
    (content) => updateAssignmentFile(content, { parked: false }),
    'Unparked',
  );
}

export async function requestReviewCommand(
  assignment: string,
  options: DeriveVerbOptions & { clear?: boolean },
): Promise<void> {
  await assertFact(
    assignment,
    options,
    options.clear ? 'review-request-clear' : 'request-review',
    (content) => updateAssignmentFile(content, { reviewRequested: !options.clear }),
    options.clear ? 'Review request cleared' : 'Review requested',
  );
}

/** Assert implementation has begun. The derived replacement for the old
 * imperative `implement`/`start` status write. Preserves the legacy side
 * effect: `--agent` sets the assignee when none is set yet. */
export async function implementStartedCommand(assignment: string, options: DeriveVerbOptions): Promise<void> {
  await assertFact(
    assignment,
    options,
    'implement',
    (content) => {
      let next = updateAssignmentFile(content, { implementationStarted: true });
      if (options.agent) {
        const fm = parseAssignmentFrontmatter(next);
        if (fm.assignee === null) {
          next = updateAssignmentFile(next, { assignee: options.agent });
        }
      }
      return next;
    },
    'Implementation started',
  );
}

// ── block / unblock (fact form) ─────────────────────────────────────────────

export async function blockFactCommand(
  assignment: string,
  options: DeriveVerbOptions & { reason?: string },
): Promise<void> {
  await assertFact(
    assignment,
    options,
    'block',
    (content) => updateAssignmentFile(content, { blockedReason: options.reason ?? '(unspecified)' }),
    'Blocked',
  );
}

export async function unblockFactCommand(assignment: string, options: DeriveVerbOptions): Promise<void> {
  await assertFact(
    assignment,
    options,
    'unblock',
    (content) => updateAssignmentFile(content, { blockedReason: null }),
    'Unblocked',
  );
}

// ── pin / unpin ─────────────────────────────────────────────────────────────

export async function statusPinCommand(
  assignment: string,
  status: string,
  options: DeriveVerbOptions,
): Promise<void> {
  const context: DeriveContext = await resolveDeriveContext();
  if (!context.knownStatusIds.has(status)) {
    throw new Error(`"${status}" is not a defined status id.`);
  }
  if (context.terminalStatuses.has(status)) {
    throw new Error(
      `Cannot pin to terminal status "${status}" — terminal is reached only via complete/fail (the gated path).`,
    );
  }
  await assertFact(
    assignment,
    options,
    'pin',
    async (content) =>
      updateOverride(content, {
        status,
        source: await inferActor(options),
        reason: options.reason ?? null,
        at: nowTimestamp(),
      }),
    `Pinned to ${status}`,
  );
}

export async function statusUnpinCommand(assignment: string, options: DeriveVerbOptions): Promise<void> {
  await assertFact(assignment, options, 'unpin', (content) => updateOverride(content, null), 'Unpinned');
}

// ── recompute (manual trigger / headless reconcile) ─────────────────────────

export async function recomputeCommand(
  assignment: string | undefined,
  options: DeriveVerbOptions & { all?: boolean },
): Promise<void> {
  const context = await resolveDeriveContext();
  if (options.all) {
    const { recomputeAll } = await import('../lifecycle/recompute.js');
    const config = await readConfig();
    const summary = await recomputeAll(
      options.dir ? expandHome(options.dir) : config.defaultProjectDir,
      assignmentsDirFn(),
      { cause: 'recompute', by: await inferActor(options), context },
    );
    console.log(
      `Recomputed ${summary.scanned} assignment(s): ${summary.changed} changed, ${summary.deferredTerminal} terminal (deferred).`,
    );
    for (const w of summary.warnings) console.warn(`Warning: ${w}`);
    return;
  }
  if (!assignment) throw new Error('Provide an assignment or --all.');
  const target = await resolveTarget(assignment, options);
  const result = await recomputeAndWrite(target.assignmentPath, {
    cause: 'recompute',
    by: await inferActor(options),
    projectDir: target.projectDir,
    context,
  });
  reportDerived(result.changed ? 'Recomputed' : 'Recomputed (no change)', result);
}
