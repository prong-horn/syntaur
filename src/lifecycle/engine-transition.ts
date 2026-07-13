/**
 * The migrated-path transition adapter (WS-2, Task 2.6). When `stages-migrated`
 * is set AND the ticket resolves a per-file `StageWorkflow`, a lifecycle command
 * (`complete`/`fail`/`reopen`) is realized as an ENGINE move through the locked
 * `recomputeAndWrite` — so no lockless `executeTransition` mover survives the
 * marker flip. Returns `null` to signal "not migrated / no workflow / not an
 * engine command" → the caller runs the legacy `executeTransition*` path,
 * byte-for-byte unchanged.
 *
 * Shared by BOTH the CLI (`_lifecycle-helper`) and the dashboard transition
 * routes, so the two surfaces never diverge.
 */

import { readFile } from 'node:fs/promises';
import { fileExists } from '../utils/fs.js';
import type { StageWorkflow } from '../utils/stage-model.js';
import type { AssignmentStatus, TransitionResult } from './types.js';
import type { EngineMove } from './engine-step.js';
import {
  isStagesMigrated,
  recomputeAndWrite,
  resolveRecomputeContext,
} from './recompute.js';
import { parseAssignmentFrontmatter } from './frontmatter.js';
import { runTerminalSideEffects, type LinkedTodosLookup } from './linked-todos.js';
import { linkedAssignmentRef } from './transitions.js';

/**
 * Whether the stage ENGINE is active for THIS assignment: the `stages-migrated`
 * marker is set AND the ticket resolves to a per-file StageWorkflow. Bare
 * `isStagesMigrated()` is NOT sufficient (codex review blockers 3+4) — a
 * marker-set assignment with no per-file workflow is the intended rollout-dormant
 * state and stays on the ladder. Used to gate the raw-PATCH mover guard and any
 * other site that must distinguish "engine owns this ticket" from "marker set".
 */
export async function isEngineActiveForAssignment(
  assignmentPath: string,
  projectDir: string | null,
): Promise<boolean> {
  if (!(await isStagesMigrated())) return false;
  if (!(await fileExists(assignmentPath))) return false;
  const { workflowResolver } = await resolveRecomputeContext();
  const fm = parseAssignmentFrontmatter(await readFile(assignmentPath, 'utf-8'));
  return (await workflowResolver.stageWorkflowFor(fm, projectDir)) !== null;
}

/** The engine commands this adapter handles. Others (`block`/`unblock`/`shape`/
 *  `plan-ready`/…) fall through to the ladder — their engine forms are WS-4. */
function commandToMove(command: string, workflow: StageWorkflow, actor: string | null): EngineMove | null {
  if (command === 'reopen') return { kind: 'reopen', actor: actor ?? undefined };
  if (command === 'complete') {
    // Force to the SUCCESS terminal stage (the terminal that isn't the failure
    // one). `crossedGates` stamps overrides only for gates actually bypassed —
    // so a legitimately-passing complete stamps nothing.
    const target = workflow.stages.find((s) => s.terminal && s.id !== workflow.terminalFailure);
    return target ? { kind: 'manual-override', target: target.id, actor: actor ?? undefined } : null;
  }
  if (command === 'fail') {
    // ONLY the declared failure terminal — never fall back to "the first
    // terminal", which could be the SUCCESS terminal and would auto-complete
    // linked todos on a `fail` (codex review major 1). A workflow with no
    // failure terminal is rejected up in runEngineTransition.
    const tf = workflow.terminalFailure;
    return tf ? { kind: 'manual-override', target: tf, actor: actor ?? undefined } : null;
  }
  return null;
}

/** True when the workflow declares a failure terminal that resolves to a real
 * terminal stage — the precondition for a `fail` engine move. */
function hasFailureTerminal(workflow: StageWorkflow): boolean {
  return (
    workflow.terminalFailure !== undefined &&
    workflow.stages.some((s) => s.id === workflow.terminalFailure && s.terminal === true)
  );
}

export async function runEngineTransition(input: {
  assignmentPath: string;
  projectDir: string | null;
  command: string;
  by: string | null;
  reason?: string;
  linkedTodosLookup?: LinkedTodosLookup;
}): Promise<TransitionResult | null> {
  if (!(await isStagesMigrated())) return null;
  if (!(await fileExists(input.assignmentPath))) return null;

  const { context, workflowResolver } = await resolveRecomputeContext();
  const fm = parseAssignmentFrontmatter(await readFile(input.assignmentPath, 'utf-8'));
  const workflow = await workflowResolver.stageWorkflowFor(fm, input.projectDir);
  if (!workflow) return null; // no per-file workflow → ladder
  // The ticket's stored status must be a stage in this workflow, else the engine
  // step returns null and recomputeAndWrite silently falls to the ladder DERIVE
  // (which does not execute the transition) — a stale/mismatched status must
  // instead fall through to the real `executeTransition` (mirrors the engine's
  // own `currentStage` guard). Without this, a migrated complete/fail on a
  // non-stage status would silently no-op.
  if (!workflow.stages.some((s) => s.id === fm.status)) return null;

  // `fail` requires a declared failure terminal; refuse loudly rather than
  // silently moving to a success terminal (codex review major 1).
  if (input.command === 'fail' && !hasFailureTerminal(workflow)) {
    return {
      success: false,
      message: `Workflow "${workflow.id}" declares no failure terminal (terminal_failure) — cannot fail this assignment.`,
      fromStatus: fm.status,
    };
  }

  const move = commandToMove(input.command, workflow, input.by);
  if (!move) return null; // not an engine command → ladder

  const fromStatus = fm.status;
  const result = await recomputeAndWrite(input.assignmentPath, {
    cause: input.command,
    by: input.by,
    projectDir: input.projectDir,
    context,
    workflowResolver,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    engineMove: move,
  });

  if (result.warning) {
    return { success: false, message: result.warning, fromStatus };
  }
  if (result.deferredTerminal) {
    return {
      success: false,
      message: `Assignment is ${result.status} (terminal). Use \`syntaur reopen\` first.`,
      fromStatus,
    };
  }

  // Terminal side effects run AFTER the locked write returned (lock released):
  // linked-todo completion on a success terminal, reopen on `reopen`.
  await runTerminalSideEffects(input.linkedTodosLookup, fm.id, linkedAssignmentRef(fm), {
    isSuccessTerminal: result.successTerminal === true,
    isReopen: input.command === 'reopen',
  });

  return {
    success: true,
    message: `${fromStatus} → ${result.status}`,
    fromStatus,
    toStatus: result.status as AssignmentStatus,
  };
}

/**
 * The migrated realization of a dashboard status-override / board free-drag
 * (WS-2, Task 2.6). A SET to status `X` becomes a `manual-override` engine move
 * to stage `X` — `crossedGates` stamps a `GateOverride` for each FORWARD failing
 * gate bypassed (a backward drag stamps none). A CLEAR (unpin) has no engine
 * analogue (position is authoritative on the migrated path) → refused, deferred
 * to WS-4. Terminal targets are refused (terminal only via complete/fail),
 * mirroring the ladder route's guard. Returns `null` when not migrated / no
 * per-file workflow → the caller runs the legacy pin path unchanged.
 */
export type EngineOverrideResult =
  | { ok: true; status: string }
  | { ok: false; code: number; message: string };

export async function runEngineOverride(input: {
  assignmentPath: string;
  projectDir: string | null;
  status: string | null; // null ⇒ clear/unpin
  by: string | null;
  reason?: string;
}): Promise<EngineOverrideResult | null> {
  if (!(await isStagesMigrated())) return null;
  if (!(await fileExists(input.assignmentPath))) return null;

  const { context, workflowResolver } = await resolveRecomputeContext();
  const fm = parseAssignmentFrontmatter(await readFile(input.assignmentPath, 'utf-8'));
  const workflow = await workflowResolver.stageWorkflowFor(fm, input.projectDir);
  if (!workflow) return null; // no per-file workflow → ladder pin
  // Current status must be a stage here, else the engine step no-ops through the
  // ladder derive (see runEngineTransition) → fall through to the legacy pin.
  if (!workflow.stages.some((s) => s.id === fm.status)) return null;

  if (input.status === null) {
    return {
      ok: false,
      code: 400,
      message:
        'Clearing a pin is not available on a migrated workflow — stage position is authoritative. Use a transition/move.',
    };
  }
  const target = workflow.stages.find((s) => s.id === input.status);
  if (!target) {
    return { ok: false, code: 400, message: `"${input.status}" is not a stage in this workflow.` };
  }
  if (target.terminal) {
    return {
      ok: false,
      code: 400,
      message: `"${input.status}" is terminal — use the complete/fail transition, not a drag.`,
    };
  }

  const result = await recomputeAndWrite(input.assignmentPath, {
    cause: 'pin',
    by: input.by,
    projectDir: input.projectDir,
    context,
    workflowResolver,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    engineMove: { kind: 'manual-override', target: input.status, actor: input.by ?? undefined },
  });
  if (result.deferredTerminal) {
    return { ok: false, code: 409, message: 'Assignment is terminal — reopen it first.' };
  }
  if (result.warning) {
    return { ok: false, code: 503, message: result.warning };
  }
  return { ok: true, status: result.status };
}
