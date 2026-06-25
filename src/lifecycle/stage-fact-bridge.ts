/**
 * Stage → fact → status bridge.
 *
 * When an engagement STAGE-OPEN transition happens (a deliberate stage switch
 * driven by the `implement`/`review` verbs), assert the corresponding
 * session-stage fact on the assignment and let the derive engine recompute
 * status. This is what makes status track reality instead of self-reported
 * scalars drifting. See decision-record.md for the full design.
 *
 * Key properties:
 *   - ASYNC, command-layer: engagement-db is synchronous SQLite; this does file
 *     I/O + the per-assignment lock, so it runs AFTER the sync engagement switch
 *     commits (Decision 3).
 *   - Session-stage facts only — `implementationStarted` (implement open),
 *     `reviewRequested` (review open), plus the derived `reworkRequested`
 *     (implement after review). Current-state facts keep their own sources (AC1).
 *   - OPEN-only — never called on engagement close (AC2).
 *   - AC4: pre-detects the fact delta and only calls `recomputeAndWrite` when a
 *     fact actually changes; semantic-diff (never writes a no-change value, so a
 *     monotonic re-assert or a same-stage repeat is a true no-op).
 *   - Failures propagate (Decision 8); the only no-op is an unattributed
 *     engagement (assignment_id that doesn't resolve to a file).
 */

import { readFile } from 'node:fs/promises';
import { fileExists } from '../utils/fs.js';
import { parseAssignmentFrontmatter, updateAssignmentFile } from './frontmatter.js';
import type { AssignmentFrontmatter } from './types.js';
import { recomputeAndWrite, resolveDeriveContext } from './recompute.js';

export interface StageFactInput {
  /** Path to the target assignment.md (the caller resolves it — honours --dir
   * and avoids re-resolving by id against the wrong tree; codex finding). */
  assignmentPath: string;
  /** Project dir for dependency facts; null for standalone. */
  projectDir: string | null;
  /** The stage that just opened (`implement` | `review` | `plan` | …). */
  stage: string;
  /** The stage open before the switch FOR THIS ASSIGNMENT (null when none, or
   * when the prior engagement was for a different assignment — the caller must
   * only pass it when same-assignment). */
  prevStage?: string | null;
  /** Actor for the history entry — 'agent:<id>' | 'human' | 'system'. */
  by?: string | null;
}

type ScalarWrites = Partial<
  Pick<AssignmentFrontmatter, 'implementationStarted' | 'reviewRequested' | 'reworkRequested'>
>;

/**
 * Compute the SEMANTIC fact delta this stage-open implies — only fields whose
 * value would actually change are included (so an empty result means "no fact
 * change", and no scalar is ever written to its current value).
 */
function computeDelta(
  stage: string,
  prevStage: string | null | undefined,
  fm: AssignmentFrontmatter,
): ScalarWrites {
  const writes: ScalarWrites = {};
  if (stage === 'implement') {
    if (!fm.implementationStarted) writes.implementationStarted = true;
    // Rework: a new `implement` opened after `review` — keyed on the prior
    // engagement stage OR the current derived phase (review is reachable via
    // acAllChecked alone, so reviewRequested isn't a reliable signal).
    const afterReview = prevStage === 'review' || fm.phase === 'review';
    if (afterReview && !fm.reworkRequested) writes.reworkRequested = true;
  } else if (stage === 'review') {
    if (!fm.reviewRequested) writes.reviewRequested = true;
    if (fm.reworkRequested) writes.reworkRequested = false;
  }
  return writes;
}

export async function assertStageFactOnOpen(input: StageFactInput): Promise<void> {
  if (!(await fileExists(input.assignmentPath))) return; // nothing to assert against

  // AC4 fast-path: cheap pre-lock read to skip the recompute entirely when there
  // is clearly no fact change. This is only an OPTIMIZATION — the authoritative,
  // race-safe delta is re-derived from the fresh locked content in `mutate`.
  const pre = computeDelta(
    input.stage,
    input.prevStage,
    parseAssignmentFrontmatter(await readFile(input.assignmentPath, 'utf-8')),
  );
  if (Object.keys(pre).length === 0) return;

  const context = await resolveDeriveContext();

  const result = await recomputeAndWrite(input.assignmentPath, {
    cause: 'stage-open',
    by: input.by ?? 'system',
    projectDir: input.projectDir,
    context,
    mutate: (content) => {
      // Re-derive against the FRESH locked content so a concurrent same-assignment
      // stage write can't be clobbered by a stale pre-lock delta (codex r2).
      const writes = computeDelta(input.stage, input.prevStage, parseAssignmentFrontmatter(content));
      return Object.keys(writes).length > 0 ? updateAssignmentFile(content, writes) : content;
    },
  });
  // Terminal assignment ⇒ facts are frozen; refuse loudly (mirrors the verb's
  // assertFact behavior) instead of a silent "✓" with the fact unwritten.
  if (result.deferredTerminal) {
    throw new Error(
      `Assignment is ${result.status} (terminal) — facts are frozen. Use \`syntaur reopen\` first.`,
    );
  }
  // Don't swallow failures (Decision 8): a CAS-exhausted projection must be
  // visible now; re-running the verb repairs the half-applied state.
  if (result.warning) throw new Error(result.warning);
}
