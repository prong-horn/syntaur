/**
 * Fact-assertion verbs (derived-status design v3, Piece 4 + command→fact
 * mapping). Under the derived model, commands don't SET status — they assert
 * facts; status follows from derivation. Every verb here mutates frontmatter
 * facts and then runs the one authoritative recompute, reporting the derived
 * outcome (including when it differs from what the caller might expect —
 * honesty over surprise).
 */

import { readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { expandHome, assignmentsDir as assignmentsDirFn } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { resolveAssignmentById, type ResolvedAssignment } from '../utils/assignment-resolver.js';
import {
  parseAssignmentFrontmatter,
  updateAssignmentFile,
  updateFactsMap,
  updateOverride,
  updatePlanApproval,
  upsertAttestation,
} from '../lifecycle/frontmatter.js';
import { canonicalizeFactValue, latestPlanFile, planDigest } from '../lifecycle/facts.js';
import { captureHeadSha } from '../utils/git-worktree.js';
import type { AttestationRecord } from '../lifecycle/types.js';
import {
  recomputeAndWrite,
  resolveDeriveContext,
  isDeriveMigrated,
  type DeriveContext,
  type RecomputeResult,
} from '../lifecycle/recompute.js';
import { emitEvent } from '../lifecycle/event-emit.js';
import { checkDependencies } from '../lifecycle/transitions.js';
import { resolveAssignmentTarget } from '../utils/assignment-target.js';
import {
  resolveSessionEngagement,
  latestBindingForSessionId,
  switchSessionStage,
} from '../utils/engagement-binding.js';
import { assertMayMutate } from '../utils/session-id.js';
import { assertStageFactOnOpen } from '../lifecycle/stage-fact-bridge.js';

export interface DeriveVerbOptions {
  project?: string;
  dir?: string;
  agent?: string;
  reason?: string;
  cwd?: string;
  /**
   * Explicit, caller-supplied session id (the SessionEnd cleanup hook passes
   * `--session-id`). When set, the implicit recompute target is keyed on THIS
   * session's latest engagement (open-else-latest) rather than the caller's
   * own-session resolution — an explicit id is EXPLICIT provenance, so it may
   * drive a mutation without a positional selector.
   */
  sessionId?: string;
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

/**
 * Emit a non-status audit event for a resolved derive target (best-effort).
 * Resolves the assignment `id` from the freshly-written file and the project
 * slug from the resolved project dir (null for standalone). Never throws.
 */
async function emitDeriveEvent(
  target: ResolvedTarget,
  type: string,
  actor: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    const fm = parseAssignmentFrontmatter(await readFile(target.assignmentPath, 'utf-8'));
    emitEvent({
      assignmentId: fm.id,
      projectSlug: target.projectDir ? basename(target.projectDir) : null,
      type,
      actor,
      details,
    });
  } catch {
    /* best-effort: a failed audit emit must never break the verb */
  }
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
  extra?: { context?: DeriveContext; auditMutation?: boolean },
): Promise<RecomputeResult> {
  const target = await resolveTarget(assignment, options);
  const context = extra?.context ?? (await resolveDeriveContext());

  const result = await recomputeAndWrite(target.assignmentPath, {
    cause,
    by: await inferActor(options),
    projectDir: target.projectDir,
    context,
    reason: options.reason,
    mutate: (content) => mutate(content, target),
    auditMutation: extra?.auditMutation,
  });
  if (result.deferredTerminal) {
    throw new Error(
      `Assignment is ${result.status} (terminal) — facts are frozen. Use \`syntaur reopen\` first.`,
    );
  }
  if (result.warning) {
    // CAS retries exhausted — the fact mutation did NOT land. Failing loudly
    // beats a silent success (codex r2 finding 5).
    throw new Error(result.warning);
  }
  reportDerived(label, result);
  return result;
}

// ── plan approval ───────────────────────────────────────────────────────────

export async function planApproveCommand(assignment: string, options: DeriveVerbOptions): Promise<void> {
  let approvedFile: string | null = null;
  await assertFact(
    assignment,
    options,
    'plan-approve',
    async (content, target) => {
      const planFile = await latestPlanFile(target.assignmentDir);
      if (!planFile) {
        throw new Error('No plan file found (plan.md / plan-v*.md). Write a plan before approving.');
      }
      approvedFile = planFile;
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
  // Audit event (best-effort) — emitted only after the verb succeeds.
  const target = await resolveTarget(assignment, options);
  await emitDeriveEvent(target, 'plan-approval', await inferActor(options), { file: approvedFile });
}

export async function planUnapproveCommand(assignment: string, options: DeriveVerbOptions): Promise<void> {
  await assertFact(assignment, options, 'plan-unapprove', (content) => updatePlanApproval(content, null), 'Plan approval cleared');
}

// ── custom asserted facts + attestations ────────────────────────────────────

/**
 * `syntaur fact set <assignment> <name> <value>` — assert a declared bool/number
 * custom fact through the assertFact spine. The name must be in the ACCEPTED
 * declaration list (a collision-skipped / malformed declaration is "not declared"
 * here too) and the value must coerce to the declared type. Records an audit
 * entry even when no dimension moves (AC9). NOT gated on the migrate-derive
 * marker — explicit verbs always run.
 */
export async function factSetCommand(
  assignment: string,
  name: string,
  value: string,
  options: DeriveVerbOptions,
): Promise<void> {
  const context = await resolveDeriveContext();
  const decl = context.factDeclarations.find((d) => d.name === name);
  if (!decl || (decl.type !== 'bool' && decl.type !== 'number')) {
    throw new Error(
      `"${name}" is not a declared custom fact (bool/number). Declare it under statuses.facts in config.md.`,
    );
  }
  const canonical = canonicalizeFactValue(decl.type, value);
  if (canonical === null) {
    throw new Error(`"${value}" is not a valid ${decl.type} value for fact "${name}".`);
  }
  await assertFact(
    assignment,
    options,
    'fact-set',
    (content) => updateFactsMap(content, name, canonical),
    `Fact ${name} = ${canonical}`,
    { context, auditMutation: true },
  );
  // Audit event (best-effort) — emitted only after the verb succeeds.
  const target = await resolveTarget(assignment, options);
  await emitDeriveEvent(target, 'fact-set', await inferActor(options), { name, value: canonical });
}

/**
 * `syntaur attest <assignment> <fact> [--agent] [--verdict] [--note]` — record
 * an attestation (default verdict `approved`). The binding snapshot is captured
 * inside the mutate transaction: binds:plan → latest plan file + digest (errors
 * when no plan); binds:commit → workspace HEAD sha read off the fresh content
 * (errors when unanchorable); binds:none → no snapshot. One record per actor —
 * re-attesting replaces it. Records an audit entry (AC9).
 */
export async function attestCommand(
  assignment: string,
  fact: string,
  options: DeriveVerbOptions & { verdict?: string; note?: string },
): Promise<void> {
  const context = await resolveDeriveContext();
  const decl = context.factDeclarations.find((d) => d.name === fact);
  if (!decl || decl.type !== 'attestation') {
    throw new Error(
      `"${fact}" is not a declared attestation fact. Declare it (type: attestation) under statuses.facts in config.md.`,
    );
  }
  const rawVerdict = options.verdict ?? 'approved';
  if (rawVerdict !== 'approved' && rawVerdict !== 'changes-requested') {
    throw new Error(`Invalid verdict "${rawVerdict}" — expected approved or changes-requested.`);
  }
  const verdict = rawVerdict as 'approved' | 'changes-requested';
  const actor = await inferActor(options);
  const binds = decl.binds;

  await assertFact(
    assignment,
    options,
    'attest',
    async (content, target) => {
      const record: AttestationRecord = {
        fact,
        actor,
        verdict,
        at: nowTimestamp(),
        ...(options.note ? { note: options.note } : {}),
      };
      if (binds === 'plan') {
        const planFile = await latestPlanFile(target.assignmentDir);
        if (!planFile) {
          throw new Error(
            'No plan file found (plan.md / plan-v*.md). Write a plan before attesting a binds:plan fact.',
          );
        }
        const planContent = await readFile(resolve(target.assignmentDir, planFile), 'utf-8');
        record.file = planFile;
        record.digest = planDigest(planContent);
      } else if (binds === 'commit') {
        const fm = parseAssignmentFrontmatter(content);
        const dir = fm.workspace.worktreePath ?? fm.workspace.repository;
        const sha = dir ? await captureHeadSha(dir) : null;
        if (!sha) {
          throw new Error(
            'Cannot record a binds:commit attestation — no workspace path is set or it is not a git repo. Set workspace.worktreePath/repository first.',
          );
        }
        record.commit = sha;
      }
      return upsertAttestation(content, record);
    },
    `Attested ${fact} (${verdict})`,
    { context, auditMutation: true },
  );
  // Audit event (best-effort) — emitted only after the verb succeeds.
  const target = await resolveTarget(assignment, options);
  await emitDeriveEvent(target, 'attestation', actor, { fact, verdict });
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

/**
 * Drive a session-stage fact from a deliberate stage transition: gate the
 * session's provenance, switch its engagement to `stage`, then let the
 * stage-fact bridge assert the fact + recompute (stage-fact-status-bridge,
 * Decisions 1/9). With no resolvable session (bare-human CLI), fall back to the
 * legacy direct fact write — a documented escape hatch.
 */
async function applyStageFact(
  assignment: string,
  options: DeriveVerbOptions,
  target: ResolvedTarget,
  fm: ReturnType<typeof parseAssignmentFrontmatter>,
  stage: 'implement' | 'review',
  label: string,
  context: DeriveContext,
): Promise<void> {
  // Refuse terminal assignments BEFORE switching the engagement — facts are
  // frozen, so a stage switch would leave the engagement ahead of a fact that
  // can't be written (mirrors assertFact's terminal refusal; codex r2).
  if (context.terminalStatuses.has(fm.status)) {
    throw new Error(
      `Assignment is ${fm.status} (terminal) — facts are frozen. Use \`syntaur reopen\` first.`,
    );
  }
  const cwd = options.cwd ?? process.cwd();
  const se = await resolveSessionEngagement(cwd);
  if (se) {
    assertMayMutate(se.session, { hasSelector: true });
    const sw = await switchSessionStage({
      sessionId: se.session.id,
      assignmentId: fm.id,
      projectSlug: fm.project,
      assignmentSlug: fm.slug,
      stage,
    });
    // Rework keys on the prior stage FOR THIS ASSIGNMENT only — a session that
    // was reviewing a DIFFERENT assignment must not mark this one as rework
    // (codex finding). Pass the resolved path so --dir is honoured.
    const prevStage =
      sw.previous && sw.previous.assignment_id === fm.id ? sw.previous.stage : null;
    await assertStageFactOnOpen({
      assignmentPath: target.assignmentPath,
      projectDir: target.projectDir,
      prevStage,
      stage,
      by: await inferActor(options),
    });
    console.log(`✓ ${label}`);
    return;
  }
  // Sessionless fallback (legacy escape hatch): direct fact write.
  const write =
    stage === 'implement' ? { implementationStarted: true } : { reviewRequested: true };
  await assertFact(
    assignment,
    options,
    stage === 'implement' ? 'implement' : 'request-review',
    (content) => updateAssignmentFile(content, write),
    label,
    { context },
  );
}

export async function requestReviewCommand(
  assignment: string,
  options: DeriveVerbOptions & { clear?: boolean },
): Promise<void> {
  if (options.clear) {
    // Clearing review is a deliberate explicit human act, not a stage-open —
    // keep it a direct fact mutation (stage-fact-status-bridge Decision 10).
    await assertFact(
      assignment,
      options,
      'review-request-clear',
      (content) => updateAssignmentFile(content, { reviewRequested: false }),
      'Review request cleared',
    );
    return;
  }
  const target = await resolveTarget(assignment, options);
  const context = await resolveDeriveContext();
  const fm = parseAssignmentFrontmatter(await readFile(target.assignmentPath, 'utf-8'));
  await applyStageFact(assignment, options, target, fm, 'review', 'Review requested', context);
}

/** Assert implementation has begun. The derived replacement for the old
 * imperative `implement`/`start` status write. Preserves the legacy side
 * effect: `--agent` sets the assignee when none is set yet. */
export async function implementStartedCommand(assignment: string, options: DeriveVerbOptions): Promise<void> {
  const target = await resolveTarget(assignment, options);
  const context = await resolveDeriveContext();

  // Non-blocking unmet-dependency warning. We WARN, never refuse — refusing
  // would diverge from the legacy transition behavior (transitions.ts) and
  // could trap legitimate work; the divergence is surfaced (here + as a
  // needs-attention reason) rather than faked in the phase ladder.
  const fm = parseAssignmentFrontmatter(await readFile(target.assignmentPath, 'utf-8'));
  if (fm.dependsOn.length > 0 && target.projectDir) {
    const dep = await checkDependencies(target.projectDir, fm.dependsOn, context.terminalStatuses);
    if (!dep.satisfied) {
      console.warn(`Warning: starting with unmet dependencies: ${dep.unmet.join(', ')}`);
    }
  }

  // The `--agent` assignee write stays a verb concern, DECOUPLED from the
  // stage-fact bridge (the bridge early-returns on an empty fact delta and would
  // otherwise drop an assignee-only update; stage-fact-status-bridge Decision 10).
  if (options.agent && fm.assignee === null) {
    await assertFact(
      assignment,
      options,
      'implement',
      (content) => {
        const innerFm = parseAssignmentFrontmatter(content);
        return innerFm.assignee === null
          ? updateAssignmentFile(content, { assignee: options.agent! })
          : content;
      },
      'Assignee set',
      { context },
    );
  }

  // Engagement-sourced `implementationStarted`: switch the session's engagement
  // to the `implement` stage and let the bridge assert the fact + recompute.
  await applyStageFact(assignment, options, target, fm, 'implement', 'Implementation started', context);
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
  options: DeriveVerbOptions & { all?: boolean; ifMigrated?: boolean },
): Promise<void> {
  // `--if-migrated` makes this honor the same migration gate the implicit
  // sweeps use (D6) — so a SessionEnd hook firing `recompute` can't re-derive
  // pre-migration assignments during rollout. A bare `syntaur recompute`
  // (explicit human/agent act) stays ungated.
  if (options.ifMigrated && !(await isDeriveMigrated())) return;

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
  // No positional arg resolves the active assignment from the session's OPEN
  // engagement — so `syntaur recompute` works from an assignment workspace
  // (e.g. a SessionEnd hook) without threading slugs. resolveAssignmentTarget
  // covers all three shapes: --project + slug, bare UUID, and the session's
  // open engagement. The legacy .syntaur/context.json assignment scalar is no
  // longer a resolution source.
  //
  // recompute MUTATES derived assignment state, so gate the implicit
  // (engagement-resolved) path: a session whose id was resolved from a WEAK
  // source (transcript scan / legacy hint) cannot drive a mutation without an
  // explicit target. The positional slug/UUID is that explicit selector.
  const cwd = options.cwd ?? process.cwd();
  const hasSelector = Boolean(assignment) || Boolean(options.project);
  // The engagement edge lives in the session DB; ensure it's open first
  // (idempotent — no-op if already initialized).
  const { initSessionDb } = await import('../dashboard/session-db.js');
  initSessionDb();

  let resolved: ResolvedAssignment;
  if (options.sessionId) {
    // EXPLICIT caller-supplied session id (the SessionEnd hook). Key the target
    // on THIS session's latest engagement (open-else-latest) — by now the hook's
    // `session stop` has already CLOSED the ending session's engagement, so we
    // must accept the latest closed interval. An explicit id is EXPLICIT
    // provenance, so it may drive a mutation with no positional selector; we
    // still run assertMayMutate for symmetry (it passes).
    assertMayMutate({ id: options.sessionId, provenance: 'EXPLICIT' }, { hasSelector });
    resolved = await resolveAssignmentTarget(assignment, {
      project: options.project,
      dir: options.dir,
      cwd,
      resolveEngagement: async () => latestBindingForSessionId(options.sessionId!),
    });
  } else {
    // No explicit id: resolve the caller's OWN session and gate on its open
    // engagement (WEAK-source sessions can't mutate without a selector).
    const se = await resolveSessionEngagement(cwd);
    if (se) assertMayMutate(se.session, { hasSelector });
    resolved = await resolveAssignmentTarget(assignment, {
      project: options.project,
      dir: options.dir,
      cwd,
      resolveEngagement: async () => se?.open ?? null,
    });
  }
  const projectDir = resolved.standalone ? null : resolve(resolved.assignmentDir, '..', '..');
  const result = await recomputeAndWrite(resolve(resolved.assignmentDir, 'assignment.md'), {
    cause: 'recompute',
    by: await inferActor(options),
    projectDir,
    context,
  });
  reportDerived(result.changed ? 'Recomputed' : 'Recomputed (no change)', result);
}
