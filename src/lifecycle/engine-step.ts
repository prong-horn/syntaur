/**
 * The engine step (WS-2, Task 2.4) — the in-lock, single-CAS-payload realization
 * of one `recomputeAndWrite` move on the MIGRATED path. Given the fresh content,
 * facts, and the ticket's `StageWorkflow`, it constructs the first move from an
 * {@link EngineMove}, runs the pure auto-cascade, and assembles ONE frontmatter
 * string carrying: status/phase/disposition, every hop's `statusHistory` entry,
 * `firedVerdicts`, the terminal `frozenChecks` freeze, and `gateOverrides`
 * (added + self-cleared). Pure string assembly — the caller does the CAS + write
 * + post-release side effects.
 *
 * Returns `null` to fall back to the ladder branch (defensive: the stored status
 * isn't a stage in this workflow).
 */

import type { AssignmentFacts } from './derive.js';
import type {
  AssignmentFrontmatter,
  FrozenCheck,
  GateOverride,
  Solicitation,
  StatusHistoryEntry,
} from './types.js';
import type { AttestationEnv } from './facts.js';
import type { DissentCause, Hop } from './stage-engine.js';
import type { StageWorkflow, WorkflowStage } from '../utils/stage-model.js';
import {
  advance,
  crossedGates,
  evaluateGate,
  evaluateRoutes,
  placeTicketCapped,
  resolveManualRoute,
} from './stage-engine.js';
import { buildEngineInput } from './engine-input.js';
import {
  appendStatusHistoryEntry,
  replaceFiredVerdicts,
  replaceGateOverrides,
  replaceSolicitations,
  updateAssignmentFile,
  writeFrozenChecks,
} from './frontmatter.js';

/** A write-move request into {@link recomputeAndWrite} on the migrated path. */
export interface EngineMove {
  kind: 'gate' | 'work-start' | 'manual' | 'manual-override' | 'reopen';
  /** Target stage id for `manual` / `manual-override` / `reopen`. */
  target?: string;
  /** Actor recorded on a forced move's `GateOverride` / history entry. */
  actor?: string;
  /** Work-start verb (WS-3 Task 0: `implement` / `request-review` / `rework`) —
   * matched against a route's `verb:` discriminator; a verb-less route matches
   * any move. Only meaningful for `kind: 'work-start'`. */
  verb?: string;
}

export interface EngineStepResult {
  nextContent: string;
  changed: boolean;
  finalStatus: string;
  /** The final stage is `terminal: true`. */
  terminalArrival: boolean;
  /** Terminal AND not the `terminalFailure` stage — a SUCCESSFUL completion. */
  successTerminal: boolean;
  /** Dissent causes newly fired THIS step (Task 2.7) — the caller copies each
   * one's `note` into `comments.md` after the CAS write (external side effect,
   * off the frontmatter CAS payload). Empty when no verdict route fired. */
  firedDissents: DissentCause[];
}

function stageById(workflow: StageWorkflow, id: string): WorkflowStage | undefined {
  return workflow.stages.find((s) => s.id === id);
}

/** The gate-passage snapshot of a stage as `FrozenCheck[]` (freeze storage). */
function freezeSnapshot(stage: WorkflowStage, input: ReturnType<typeof buildEngineInput>): FrozenCheck[] {
  return evaluateGate(stage, input).checks.map((c) => ({ key: c.key, label: c.label, passed: c.passed }));
}

function hopToHistory(hop: Hop, at: string, cause: string, by: string | null): StatusHistoryEntry {
  return {
    at,
    from: hop.from,
    to: hop.to,
    command: cause,
    by,
    trigger: hop.trigger,
    route: hop.route,
    gateSnapshot: hop.snapshot,
    ...(hop.dissent ? { dissent: hop.dissent } : {}),
  };
}

export function computeEngineStep(input: {
  content: string;
  frontmatter: AssignmentFrontmatter;
  facts: AssignmentFacts;
  workflow: StageWorkflow;
  env: AttestationEnv;
  move: EngineMove;
  cause: string;
  by: string | null;
  reason?: string;
  at: string;
}): EngineStepResult | null {
  const { content, frontmatter, facts, workflow, env, move, cause, by, reason, at } = input;
  const currentStage = stageById(workflow, frontmatter.status);
  if (!currentStage) return null; // stored status isn't a stage here → ladder fallback

  const engineInput = buildEngineInput(frontmatter, facts, workflow, env);

  // ── 1. The forced first move (if any) → landing stage + forced history ─────
  const history: StatusHistoryEntry[] = [];
  const addedOverrides: GateOverride[] = [];
  let clearFreezeAndOverrides = false;
  let landing = currentStage;

  const forced = (to: WorkflowStage, entry: Omit<StatusHistoryEntry, 'at' | 'command' | 'by'>): void => {
    history.push({ at, command: cause, by, ...entry });
    landing = to;
  };

  switch (move.kind) {
    case 'gate':
      break; // no forced move — advance from the current stage
    case 'work-start': {
      const step = evaluateRoutes(currentStage, workflow, engineInput, 'work-start', move.verb);
      const to = step ? stageById(workflow, step.route.to) : undefined;
      if (step && to) {
        forced(to, { from: currentStage.id, to: to.id, trigger: 'work-start', route: step.route });
      }
      break;
    }
    case 'manual': {
      const resolved = move.target
        ? resolveManualRoute(currentStage, workflow, move.target)
        : { error: 'manual move requires a target' };
      const to = 'route' in resolved ? stageById(workflow, resolved.route.to) : undefined;
      if ('route' in resolved && to) {
        forced(to, { from: currentStage.id, to: to.id, trigger: 'manual', route: resolved.route });
      }
      break;
    }
    case 'manual-override': {
      const to = move.target ? stageById(workflow, move.target) : undefined;
      if (to && to.id !== currentStage.id) {
        const crossed = crossedGates(workflow, currentStage.id, to.id, engineInput);
        for (const g of crossed) {
          addedOverrides.push({
            // The gate's OWN stage (codex review major 3), NOT the move source —
            // a multi-stage a→c override stamps b's gate against stage b.
            stage: g.stage ?? currentStage.id,
            key: g.key,
            label: g.label,
            from: currentStage.id,
            to: to.id,
            actor: move.actor ?? by ?? 'human',
            at,
            ...(reason ? { reason } : {}),
          });
        }
        forced(to, {
          from: currentStage.id,
          to: to.id,
          trigger: 'manual-override',
          gateSnapshot: crossed,
          ...(reason ? { reason } : {}),
        });
      }
      break;
    }
    case 'reopen': {
      const cap = currentStage.reopen ?? move.target ?? workflow.stages[0]?.id ?? currentStage.id;
      const placed = placeTicketCapped(workflow, engineInput, cap);
      const to = stageById(workflow, placed);
      clearFreezeAndOverrides = true;
      if (to && to.id !== currentStage.id) {
        forced(to, { from: currentStage.id, to: to.id, trigger: 'reopen', ...(reason ? { reason } : {}) });
      } else {
        landing = to ?? currentStage;
      }
      break;
    }
  }

  // ── 2. Auto-cascade from the landing stage (reopen is a deliberate placement,
  //       so it does not re-cascade forward and undo the reopen) ──────────────
  const advanceResult = move.kind === 'reopen' ? null : advance(landing, workflow, engineInput);
  if (advanceResult) {
    for (const hop of advanceResult.path) history.push(hopToHistory(hop, at, cause, by));
  }

  const finalStatus = history.length > 0 ? history[history.length - 1].to : currentStage.id;
  const finalStage = stageById(workflow, finalStatus) ?? currentStage;
  const terminalArrival = finalStage.terminal === true;
  const successTerminal = terminalArrival && finalStage.id !== workflow.terminalFailure;

  // ── 3. Assemble the ONE CAS payload ────────────────────────────────────────
  const disposition = terminalArrival
    ? 'terminal'
    : facts.blocked
      ? 'blocked'
      : facts.parked
        ? 'parked'
        : 'active';

  const statusChanged = finalStatus !== frontmatter.status;
  const newFired = advanceResult ? advanceResult.firedDissents : [];
  // The dissent causes for the keys fired this step (Task 2.7) — carried on the
  // cascade hops. The caller copies each note to comments.md post-write.
  const firedDissents: DissentCause[] = (advanceResult?.path ?? [])
    .map((hop) => hop.dissent)
    .filter((d): d is DissentCause => Boolean(d));

  // Solicitation lifecycle (Task 2.7): a solicitation whose check just fired a
  // verdict route transitions `solicited → rendered`. Matched on the check id;
  // only OPEN (`solicited`) records flip. Reorder-safe by construction (check id
  // is stable). Persisted in the CAS payload below.
  const renderedChecks = new Set(firedDissents.map((d) => d.check));
  const nextSolicitations: Solicitation[] | null =
    renderedChecks.size > 0 && (frontmatter.solicitations ?? []).some(
      (s) => s.state === 'solicited' && renderedChecks.has(s.check),
    )
      ? (frontmatter.solicitations ?? []).map((s) =>
          s.state === 'solicited' && renderedChecks.has(s.check)
            ? { ...s, state: 'rendered' as const }
            : s,
        )
      : null;

  // gateOverrides: compute the NEXT set up front (so a self-clear-only change
  // still counts as `changed` below — codex review major 2). Reopen clears them
  // entirely; otherwise self-clear any whose OWN gate (its stage, key+label) now
  // passes, then append the new stamps.
  const existingOverrides = frontmatter.gateOverrides ?? [];
  let nextGateOverrides: GateOverride[] | null = null; // null ⇒ leave as-is
  if (clearFreezeAndOverrides) {
    nextGateOverrides = [];
  } else if (addedOverrides.length > 0 || existingOverrides.length > 0) {
    // Evaluate each override's ORIGINATING stage (memoized), not just the final
    // stage — an override for an earlier gate must clear once THAT gate passes
    // even while the ticket sits in a later stage (codex review major 2).
    const liveByStage = new Map<string, Map<string, { label: string; passed: boolean }>>();
    const liveChecksFor = (stageId: string): Map<string, { label: string; passed: boolean }> => {
      let m = liveByStage.get(stageId);
      if (!m) {
        const stage = stageById(workflow, stageId);
        m = new Map(
          (stage ? evaluateGate(stage, engineInput).checks : []).map(
            (c) => [c.key, { label: c.label, passed: c.passed }] as const,
          ),
        );
        liveByStage.set(stageId, m);
      }
      return m;
    };
    const kept = existingOverrides.filter((o) => {
      const live = liveChecksFor(o.stage).get(o.key);
      // Cleared only when the live gate at the override's own stage (same key AND
      // label) now passes. An unresolvable stage/key is left in place (dangling).
      return !(live && live.label === o.label && live.passed);
    });
    nextGateOverrides = [...kept, ...addedOverrides];
  }
  const overridesChanged =
    nextGateOverrides !== null &&
    JSON.stringify(nextGateOverrides) !== JSON.stringify(existingOverrides);

  // A pause-flag flip (block/unblock, park/unpark) changes `disposition` without
  // moving a stage — the ladder recomputes disposition on every derive, so the
  // engine must too, else a migrated park/block leaves a stale disposition. An
  // absent disposition is implicitly `active`, so a plain no-op derive on a
  // fresh/active ticket is NOT a change (only a real flip to parked/blocked is).
  const dispositionChanged = disposition !== (frontmatter.disposition ?? 'active');
  const changed =
    statusChanged ||
    newFired.length > 0 ||
    overridesChanged ||
    clearFreezeAndOverrides ||
    dispositionChanged ||
    nextSolicitations !== null;

  if (!changed) {
    return {
      nextContent: content,
      changed: false,
      finalStatus,
      terminalArrival,
      successTerminal,
      firedDissents,
    };
  }

  let next = updateAssignmentFile(content, {
    status: finalStatus,
    phase: finalStatus,
    disposition,
    updated: at,
  });

  for (const entry of history) next = appendStatusHistoryEntry(next, entry);

  // firedVerdicts: accumulate the newly-fired edge-triggered dissent keys.
  if (newFired.length > 0) {
    const merged = Array.from(new Set([...(frontmatter.firedVerdicts ?? []), ...newFired]));
    next = replaceFiredVerdicts(next, merged);
  }

  if (nextGateOverrides !== null) next = replaceGateOverrides(next, nextGateOverrides);

  // frozenChecks: freeze at a terminal arrival; clear on reopen.
  if (clearFreezeAndOverrides) {
    next = writeFrozenChecks(next, null);
  } else if (terminalArrival) {
    next = writeFrozenChecks(next, freezeSnapshot(finalStage, engineInput));
  }

  // solicitations: persist the `solicited → rendered` transitions computed above.
  if (nextSolicitations !== null) {
    next = replaceSolicitations(next, nextSolicitations);
  }

  return {
    nextContent: next,
    changed: true,
    finalStatus,
    terminalArrival,
    successTerminal,
    firedDissents,
  };
}
