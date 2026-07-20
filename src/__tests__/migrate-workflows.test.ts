/**
 * WS-3 (`syntaur migrate-workflows`) — the migration + compat suite.
 *
 * Every fs-touching test runs against an mkdtemp root via `SYNTAUR_HOME`
 * (mirroring engine-recompute-integration.test.ts) — NEVER the real
 * `~/.syntaur`. The compiler tests (T1/T2) are pure.
 */
import { describe, it, expect } from 'vitest';
import {
  compileLadderWorkflow,
  classifyStatuses,
  COMPILE_SEMANTIC_CAVEAT,
} from '../lifecycle/ladder-compile.js';
import { advance, evaluateRoutes, placeTicket, type EngineInput } from '../lifecycle/stage-engine.js';
import { findWorkflowStructureProblems } from '../utils/doctor/checks/workflows.js';
import { parseWorkflowFile, serializeWorkflowFile } from '../utils/workflow-file.js';
import { DEFAULT_DERIVE_CONFIG } from '../utils/derive-config.js';
import type { StatusConfig } from '../utils/config.js';
import type { StageWorkflow } from '../utils/stage-model.js';
import type { AssignmentFacts } from '../lifecycle/derive.js';

// ── Fixtures: the LIVE default-workflow bundle (verified 2026-07-13) ─────────
// Mirrors the real config.md `workflows.default`: 11 definitions (incl. the
// orphans `planning`/`code_review` and the pause states `blocked`/`parked`),
// no `derive:`/`transitions:` block → the built-in DEFAULT_DERIVE_CONFIG.

const LIVE_DEFAULT_BUNDLE: StatusConfig = {
  statuses: [
    { id: 'draft', label: 'Draft' },
    { id: 'ready_for_planning', label: 'Ready for Planning' },
    { id: 'ready_to_implement', label: 'Ready to Implement' },
    { id: 'planning', label: 'Planning' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'code_review', label: 'Code Review' },
    { id: 'review', label: 'Review' },
    { id: 'blocked', label: 'Blocked' },
    { id: 'completed', label: 'Completed', terminal: true },
    { id: 'failed', label: 'Failed', terminal: true },
    { id: 'parked', label: 'Parked' },
  ],
  order: [
    'draft',
    'ready_for_planning',
    'planning',
    'ready_to_implement',
    'in_progress',
    'code_review',
    'review',
    'blocked',
    'completed',
    'failed',
    'parked',
  ],
  transitions: [],
};

/** The concrete compiled `default` workflow the plan mandates (T1). */
const EXPECTED_DEFAULT: StageWorkflow = {
  id: 'default',
  stages: [
    {
      id: 'draft',
      gate: [{ check: '', condition: 'hasRealObjective:true AND acRealTotal > 0' }],
      next: [{ to: 'ready_for_planning', on: 'gate' }],
    },
    {
      id: 'ready_for_planning',
      gate: [{ check: '', condition: 'planApproved:true' }],
      next: [{ to: 'ready_to_implement', on: 'gate' }],
    },
    {
      // NO gate — the residual is only the retired implementationStarted fact.
      id: 'ready_to_implement',
      next: [{ to: 'in_progress', on: 'work-start', verb: 'implement' }],
    },
    {
      id: 'in_progress',
      gate: [{ check: '', condition: 'acAllChecked:true AND NOT reworkRequested:true' }],
      next: [
        { to: 'review', on: 'gate' },
        { to: 'review', on: 'work-start', verb: 'request-review' },
        { to: 'completed', on: 'manual' },
      ],
    },
    {
      id: 'review',
      next: [
        { to: 'in_progress', on: 'work-start', verb: 'rework' },
        { to: 'completed', on: 'manual' },
        { to: 'failed', on: 'manual' },
      ],
    },
    { id: 'completed', terminal: true, reopen: 'review' },
    { id: 'failed', terminal: true, reopen: 'review' },
  ],
  flags: {
    blocked: { when: 'blocked:true' },
    parked: { when: 'parked:true' },
    hold: {},
  },
  terminalFailure: 'failed',
};

function facts(overrides: Partial<AssignmentFacts> = {}): AssignmentFacts {
  return {
    hasRealObjective: false,
    acRealTotal: 0,
    acRealChecked: 0,
    acAllChecked: false,
    planExists: false,
    planApproved: false,
    workspaceSet: false,
    implementationStarted: false,
    depsSatisfied: true,
    unresolvedQuestions: 0,
    blocked: false,
    parked: false,
    reviewRequested: false,
    reworkRequested: false,
    pinned: false,
    ...overrides,
  } as AssignmentFacts;
}

function engineInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return { facts: facts(), evidence: {}, firedDissents: new Set(), ...overrides };
}

// ── T1: the ladder → StageWorkflow compiler ──────────────────────────────────

describe('compileLadderWorkflow — the compiled default (T1)', () => {
  const { workflow, report } = compileLadderWorkflow('default', LIVE_DEFAULT_BUNDLE);

  it('compiles the live default bundle to EXACTLY the plan-mandated workflow', () => {
    expect(workflow).toEqual(EXPECTED_DEFAULT);
  });

  it('ready_to_implement has NO gate route — no auto-advance on a gate recompute (round-2 B3)', () => {
    const rti = workflow.stages.find((s) => s.id === 'ready_to_implement')!;
    expect(rti.gate).toBeUndefined();
    expect(rti.next?.every((r) => r.on !== 'gate')).toBe(true);
    // A ticket sitting there with planApproved:true does NOT move on a cascade…
    const result = advance(rti, workflow, engineInput({ facts: facts({ planApproved: true }) }));
    expect(result.final).toBe('ready_to_implement');
    expect(result.path).toEqual([]);
    // …and moves ONLY on the implement work-start verb.
    expect(evaluateRoutes(rti, workflow, engineInput(), 'work-start', 'implement')?.route.to).toBe(
      'in_progress',
    );
    expect(evaluateRoutes(rti, workflow, engineInput(), 'work-start', 'request-review')).toBeNull();
  });

  it('passes the doctor structural checks (terminals reachable, no unknown targets)', () => {
    expect(findWorkflowStructureProblems(workflow)).toEqual([]);
  });

  it('round-trips through parseWorkflowFile with zero issues; terminal_failure is the on-disk key', () => {
    const serialized = serializeWorkflowFile(workflow);
    expect(serialized).toContain('terminal_failure: failed');
    const { workflow: parsed, issues } = parseWorkflowFile(serialized);
    expect(issues).toEqual([]);
    expect(parsed.terminalFailure).toBe('failed');
    expect(parsed).toEqual(workflow);
  });

  it('placement stops honestly at ready_to_implement (waiting stage exits only by work-start)', () => {
    const placed = placeTicket(
      workflow,
      engineInput({
        facts: facts({ hasRealObjective: true, acRealTotal: 3, planApproved: true }),
      }),
    );
    expect(placed).toBe('ready_to_implement');
  });

  it('emits the forced-decision report: work-start verbs, terminals, flags, caveat', () => {
    expect(report.workflowId).toBe('default');
    expect(report.terminals).toEqual(['completed', 'failed']);
    expect(report.flags).toEqual({ blocked: 'blocked:true', parked: 'parked:true', hold: null });
    expect(report.caveat).toBe(COMPILE_SEMANTIC_CAVEAT);
    // The three retired-fact routes each surface as a forced decision with a verb.
    const verbs = report.decisions.filter((d) => d.outcome === 'work-start' && d.verb);
    expect(verbs.map((d) => d.verb)).toContain('implement');
    expect(verbs.map((d) => d.verb)).toContain('request-review');
    expect(verbs.map((d) => d.verb)).toContain('rework');
    // The implied-conjunct removal is documented (planApproved at ready_to_implement).
    expect(
      report.decisions.some((d) => d.outcome === 'implied' && d.conjunct === 'planApproved:true'),
    ).toBe(true);
  });
});

// ── T2: orphan + status classification ───────────────────────────────────────

describe('classifyStatuses / orphans (T2, decision D2)', () => {
  const { report } = compileLadderWorkflow('default', LIVE_DEFAULT_BUNDLE);

  it('surfaces exactly planning/code_review as orphan forced-decisions (delete-if-unused)', () => {
    expect(report.orphans.map((o) => o.id)).toEqual(['planning', 'code_review']);
    for (const o of report.orphans) expect(o.decision).toBe('delete-if-unused');
  });

  it('classifies blocked/parked as flags (not orphans), completed/failed as terminals, review as a rung', () => {
    const { rungs, terminals, flagIds, orphans } = classifyStatuses(
      LIVE_DEFAULT_BUNDLE,
      DEFAULT_DERIVE_CONFIG,
    );
    expect(rungs.has('review')).toBe(true); // a real rung, NOT an orphan (D2)
    expect(terminals).toEqual(['completed', 'failed']);
    expect(flagIds.has('blocked')).toBe(true);
    expect(flagIds.has('parked')).toBe(true);
    expect(orphans).toEqual(['planning', 'code_review']);
  });

  it('no compiled route targets an undefined stage', () => {
    const { workflow } = compileLadderWorkflow('default', LIVE_DEFAULT_BUNDLE);
    const ids = new Set(workflow.stages.map((s) => s.id));
    for (const s of workflow.stages) {
      for (const r of s.next ?? []) expect(ids.has(r.to)).toBe(true);
      if (s.reopen) expect(ids.has(s.reopen)).toBe(true);
    }
  });
});
