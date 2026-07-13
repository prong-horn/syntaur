/**
 * Node-side glue between stored frontmatter and the pure engine (WS-2, Task 2.3).
 * The engine (`stage-engine.ts`) is pure and takes pre-evaluated inputs; this
 * module builds those inputs from disk-bound state — the `AttestationDetail →
 * CheckEvidence` adapter (WS-1 handoff dep 5), solicitation currentness (dep 2),
 * `firedDissents` (dep 1), `held` (dep 3), and the terminal freeze read (dep 4).
 *
 * NOT imported by the pure engine (keeps it Node-free). Sourced from the
 * WORKFLOW's judged gate checks, NOT the legacy `facts:` declarations — the
 * default workflow's `codeReviewed` gate is not a declared fact (codex r2).
 */

import type { AssignmentFacts } from './derive.js';
import type { AssignmentFrontmatter } from './types.js';
import type { StageCheck, StageWorkflow } from '../utils/stage-model.js';
import {
  type AttestationEnv,
  isAttestationValid,
  isSolicitationCurrent,
} from './facts.js';
import {
  type CheckEvidence,
  type EngineInput,
  type EvaluatedCheck,
  evaluateGate,
} from './stage-engine.js';

/** A gate check is judged (attestation-bearing) when it declares a judge marker
 *  or a revision binding — a superset of the engine's declarative markers, so
 *  building evidence for it also flips the engine's `isJudged` evidence clause. */
function isJudgedCheck(check: StageCheck): boolean {
  return (
    check.check !== '' &&
    (check.by !== undefined ||
      check.judge !== undefined ||
      check.quorum !== undefined ||
      check.binds !== undefined)
  );
}

/** Normalize a check's `binds` to the three validity modes. */
function normalizeBinds(binds: string | undefined): 'plan' | 'commit' | 'none' {
  return binds === 'commit' ? 'commit' : binds === 'plan' ? 'plan' : 'none';
}

/**
 * Adapt stored frontmatter into the pure engine's {@link EngineInput}. Evidence
 * is keyed by judged-check name, built by scanning EVERY stage's gate (not just
 * the current stage — a route may re-enter a stage, and the engine keys evidence
 * globally). `env` must come from {@link resolveBindingEnv} so a stage-only
 * `binds:commit` gate validates against a live HEAD.
 */
export function buildEngineInput(
  frontmatter: AssignmentFrontmatter,
  facts: AssignmentFacts,
  workflow: StageWorkflow,
  env: AttestationEnv,
): EngineInput {
  const records = frontmatter.attestations ?? [];
  const solicitations = frontmatter.solicitations ?? [];
  const evidence: Record<string, CheckEvidence> = {};

  for (const stage of workflow.stages) {
    for (const check of stage.gate ?? []) {
      if (!isJudgedCheck(check)) continue;
      const name = check.check;
      if (name in evidence) continue; // one entry per check name (engine keys by name)
      const binds = normalizeBinds(check.binds);
      evidence[name] = {
        records: records
          .filter((r) => r.fact === name)
          .map((record) => ({ record, valid: isAttestationValid(record, binds, env) })),
        solicitations: solicitations
          .filter((s) => s.check === name)
          .map((solicitation) => ({
            solicitation,
            current: isSolicitationCurrent(solicitation.revisionBinding, binds, env),
          })),
      };
    }
  }

  return {
    facts,
    evidence,
    firedDissents: new Set(frontmatter.firedVerdicts ?? []),
    held: frontmatter.hold,
  };
}

/**
 * The single freeze read choke point (WS-2 handoff dep 4; codex r2 finding 2).
 * Returns the per-check states for the ticket's CURRENT stage. For a TERMINAL
 * (frozen) ticket it reconstructs from the stored `frozenChecks` snapshot +
 * static gate metadata WITHOUT reading any evidence — so worktree cleanup can't
 * retroactively flip a done ticket's gate. Otherwise it evaluates live.
 *
 * DEPENDS ON {@link buildEngineInput} (never the reverse — no cycle). Scoped to
 * STAGE-CHECK reads: the migrated dashboard stage-detail + board, and the
 * recompute-side regression. Legacy FACT reads stay live and are out of scope.
 */
export function getCheckStates(
  frontmatter: AssignmentFrontmatter,
  facts: AssignmentFacts,
  workflow: StageWorkflow,
  env: AttestationEnv,
): EvaluatedCheck[] {
  const stage = workflow.stages.find((s) => s.id === frontmatter.status);
  if (!stage) return [];

  if (frontmatter.frozenChecks !== null) {
    // Frozen (terminal): reconstruct from the snapshot + the stage's gate
    // metadata by positional key. NO evidence read — the frozen `passed` wins.
    const gateByKey = new Map<string, { check: StageCheck; kind: 'computed' | 'judged' }>();
    (stage.gate ?? []).forEach((check, index) => {
      gateByKey.set(`${stage.id}:${index}`, {
        check,
        kind: isJudgedCheck(check) ? 'judged' : 'computed',
      });
    });
    return frontmatter.frozenChecks.map((fc): EvaluatedCheck => {
      const meta = gateByKey.get(fc.key);
      return {
        key: fc.key,
        label: fc.label,
        check: meta?.check ?? { check: fc.label },
        kind: meta?.kind ?? 'judged',
        state: fc.passed ? 'pass' : 'fail',
        passed: fc.passed,
      };
    });
  }

  return evaluateGate(stage, buildEngineInput(frontmatter, facts, workflow, env)).checks;
}
