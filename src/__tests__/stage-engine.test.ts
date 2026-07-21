import { describe, it, expect } from 'vitest';
import {
  evaluateCheck,
  evaluateCheckState,
  evaluateGate,
  placeTicket,
  evaluateRoutes,
  resolveManualRoute,
  advance,
  checkRegressions,
  detectAutoRouteCycles,
  dissentKey,
  type EngineInput,
  type CheckEvidence,
} from '../lifecycle/stage-engine.js';
// Aliasability (WS-1 AC) is proven authoritatively by `dashboard/tsconfig.json`
// (which maps `@shared/stage-engine` + includes the module) under the dashboard
// `tsc -b` build, plus the browser-safe purity guard in workflow-resolve.test.ts.
import type { StageWorkflow, WorkflowStage, StageCheck } from '../utils/stage-model.js';
import type { AssignmentFacts } from '../lifecycle/derive.js';
import type { AttestationRecord, Solicitation } from '../lifecycle/types.js';

// ── builders ─────────────────────────────────────────────────────────────────

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

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return { facts: facts(), evidence: {}, firedDissents: new Set(), ...overrides };
}

function rec(overrides: Partial<AttestationRecord> = {}): AttestationRecord {
  return {
    fact: 'codeReviewed',
    actor: 'reviewer',
    verdict: 'approved',
    at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function solicit(overrides: Partial<Solicitation> = {}): Solicitation {
  return { check: 'codeReviewed', at: '2026-01-01T00:00:00Z', state: 'solicited', ...overrides };
}

function evidence(
  records: CheckEvidence['records'] = [],
  solicitations: CheckEvidence['solicitations'] = [],
): CheckEvidence {
  return { records, solicitations };
}

const stage = (s: Partial<WorkflowStage> & { id: string }): WorkflowStage => s;

// ── placeTicket (AC: placement function) ─────────────────────────────────────

describe('placeTicket', () => {
  const linear: StageWorkflow = {
    id: 'w',
    stages: [
      stage({ id: 'a', gate: [{ check: 'hasRealObjective' }], next: [{ to: 'b' }] }),
      stage({ id: 'b', gate: [{ check: 'planApproved' }], next: [{ to: 'done' }] }),
      stage({ id: 'done', terminal: true }),
    ],
  };

  it('ladder-equivalent: stops at the deepest stage whose upstream spine gates pass', () => {
    // Only a's gate passes → placement lands at b (b's gate fails).
    expect(placeTicket(linear, input({ facts: facts({ hasRealObjective: true }) }))).toBe('b');
    // Both pass → lands at the terminal.
    expect(
      placeTicket(linear, input({ facts: facts({ hasRealObjective: true, planApproved: true }) })),
    ).toBe('done');
    // Nothing passes → stays at the entry.
    expect(placeTicket(linear, input())).toBe('a');
  });

  it('rework fixture: placement ≠ naive-highest — a judged gate with no evidence stops it', () => {
    const wf: StageWorkflow = {
      id: 'w',
      stages: [
        stage({ id: 'implementing', gate: [{ check: 'acAllChecked' }], next: [{ to: 'reviewing' }] }),
        stage({
          id: 'reviewing',
          gate: [{ check: 'codeReviewed', by: 'not-author', judge: 'reviewer' }],
          next: [{ to: 'done' }],
        }),
        stage({ id: 'done', terminal: true }),
      ],
    };
    // acAllChecked passes, but the judged review has no attestation → awaiting →
    // placement stops at reviewing, NOT at done (the naive-highest answer).
    expect(placeTicket(wf, input({ facts: facts({ acAllChecked: true }) }))).toBe('reviewing');
  });

  it('branch fixture: a stage with >1 forward gate route is not a spine — placement stops there', () => {
    const wf: StageWorkflow = {
      id: 'w',
      stages: [
        stage({ id: 'a', next: [{ to: 'b' }, { to: 'c' }] }),
        stage({ id: 'b', terminal: true }),
        stage({ id: 'c', terminal: true }),
      ],
    };
    expect(placeTicket(wf, input())).toBe('a');
  });
});

// ── evaluateCheckState (AC: four check states) ───────────────────────────────

describe('evaluateCheckState', () => {
  const check: StageCheck = { check: 'codeReviewed', judge: 'reviewer' };

  it('pass: one valid approval', () => {
    expect(evaluateCheckState(check, evidence([{ record: rec(), valid: true }]))).toBe('pass');
  });

  it('fail: any valid dissent vetoes a co-present valid approval', () => {
    const ev = evidence([
      { record: rec({ verdict: 'approved', actor: 'r1' }), valid: true },
      { record: rec({ verdict: 'changes-requested', actor: 'r2' }), valid: true },
    ]);
    expect(evaluateCheckState(check, ev)).toBe('fail');
  });

  it('awaiting: no evidence at all (unrendered judged check never auto-passes)', () => {
    expect(evaluateCheckState(check, evidence())).toBe('awaiting');
  });

  it('awaiting: an open, current solicitation', () => {
    expect(evaluateCheckState(check, evidence([], [{ solicitation: solicit(), current: true }]))).toBe(
      'awaiting',
    );
  });

  it('stale: an approval that is no longer valid, with no open current solicitation', () => {
    const ev = evidence(
      [{ record: rec({ verdict: 'approved' }), valid: false }],
      [{ solicitation: solicit({ state: 'rendered' }), current: false }],
    );
    expect(evaluateCheckState(check, ev)).toBe('stale');
  });

  it('a non-current / rendered solicitation does not yield awaiting', () => {
    // Only a rendered (non-open) solicitation, no records → default awaiting, but
    // NOT because of the solicitation (proven via the stale case above).
    expect(
      evaluateCheckState(check, evidence([], [{ solicitation: solicit({ state: 'rendered' }), current: true }])),
    ).toBe('awaiting');
  });

  it('quorum is advisory in Phase 1: quorum:2 passes on one valid approval (decision #7)', () => {
    const q: StageCheck = { check: 'codeReviewed', judge: 'reviewer', quorum: 2 };
    expect(evaluateCheckState(q, evidence([{ record: rec(), valid: true }]))).toBe('pass');
    expect(
      evaluateCheckState(
        q,
        evidence([
          { record: rec({ actor: 'r1' }), valid: true },
          { record: rec({ actor: 'r2' }), valid: true },
        ]),
      ),
    ).toBe('pass');
  });
});

// ── evaluateCheck disambiguation (AC: routes/gate semantics) ─────────────────

describe('evaluateCheck disambiguation', () => {
  it('bare fact name resolves by facts-bag lookup', () => {
    const r = evaluateCheck({ check: 'hasRealObjective' }, 's', 0, input({ facts: facts({ hasRealObjective: true }) }));
    expect(r).toMatchObject({ kind: 'computed', passed: true, state: 'pass', key: 's:0' });
  });

  it('unknown bare name surfaces an issue and does NOT pass (never AQL-compiled)', () => {
    const r = evaluateCheck({ check: 'notAFact' }, 's', 1, input());
    expect(r.passed).toBe(false);
    expect(r.issue).toContain('unknown check');
  });

  it('an explicit condition compiles and evaluates against facts', () => {
    const r = evaluateCheck({ check: '', condition: 'acRealTotal > 0' }, 's', 0, input({ facts: facts({ acRealTotal: 3 }) }));
    expect(r.passed).toBe(true);
    expect(r.label).toBe('acRealTotal > 0');
  });

  it('an expression in the `check` field (not a plain identifier) compiles as AQL', () => {
    const r = evaluateCheck({ check: 'acRealTotal > 0' }, 's', 0, input({ facts: facts({ acRealTotal: 2 }) }));
    expect(r.passed).toBe(true);
  });

  it('a malformed condition surfaces an issue and never throws', () => {
    const r = evaluateCheck({ check: '', condition: 'acRealTotal >' }, 's', 0, input());
    expect(r.passed).toBe(false);
    expect(r.issue).toBeTruthy();
  });

  it('`not:` verdict-export holds while the export stands, clears when absent', () => {
    const held = evaluateCheck(
      { check: '', not: 'codeReviewedChangesRequested' },
      's',
      0,
      input({ facts: facts({ codeReviewedChangesRequested: true } as Partial<AssignmentFacts>) }),
    );
    expect(held.passed).toBe(false);
    expect(held.label).toBe('not codeReviewedChangesRequested');
    const clear = evaluateCheck(
      { check: '', not: 'codeReviewedChangesRequested' },
      's',
      0,
      input({ facts: facts({ codeReviewedChangesRequested: false } as Partial<AssignmentFacts>) }),
    );
    expect(clear.passed).toBe(true);
  });

  it('a numeric fact used as a bare check flags an issue', () => {
    const r = evaluateCheck({ check: 'acRealTotal' }, 's', 0, input({ facts: facts({ acRealTotal: 5 }) }));
    expect(r.issue).toContain('not a boolean');
  });
});

// ── evaluateGate / snapshot keys ─────────────────────────────────────────────

describe('evaluateGate', () => {
  it('passes only when every check passes; empty gate passes', () => {
    const s = stage({ id: 'a', gate: [{ check: 'hasRealObjective' }, { check: 'planExists' }] });
    expect(evaluateGate(s, input({ facts: facts({ hasRealObjective: true, planExists: true }) })).passed).toBe(true);
    expect(evaluateGate(s, input({ facts: facts({ hasRealObjective: true }) })).passed).toBe(false);
    expect(evaluateGate(stage({ id: 'b' }), input()).passed).toBe(true);
  });

  it('positional keys distinguish two condition-only entries in one gate', () => {
    const s = stage({
      id: 'a',
      gate: [
        { check: '', condition: 'acRealTotal > 0' },
        { check: '', condition: 'acRealChecked > 0' },
      ],
    });
    const g = evaluateGate(s, input({ facts: facts({ acRealTotal: 1, acRealChecked: 0 }) }));
    expect(g.checks.map((c) => c.key)).toEqual(['a:0', 'a:1']);
    expect(g.checks[0].passed).toBe(true);
    expect(g.checks[1].passed).toBe(false);
  });
});

// ── evaluateRoutes / resolveManualRoute (AC: route evaluation) ───────────────

describe('evaluateRoutes', () => {
  const wf: StageWorkflow = {
    id: 'w',
    stages: [
      stage({
        id: 'ready',
        next: [{ to: 'implementing', on: 'work-start' }],
      }),
      stage({
        id: 'reviewing',
        gate: [{ check: 'codeReviewed', judge: 'reviewer' }],
        next: [{ to: 'done' }],
        onDissent: 'implementing',
      }),
      stage({ id: 'implementing' }),
      stage({ id: 'done', terminal: true }),
    ],
  };

  it('gate: fires the on:gate route only when the whole gate passes', () => {
    const reviewing = wf.stages[1];
    expect(evaluateRoutes(reviewing, wf, input(), 'gate')).toBeNull();
    const passing = input({ evidence: { codeReviewed: evidence([{ record: rec(), valid: true }]) } });
    expect(evaluateRoutes(reviewing, wf, passing, 'gate')?.route.to).toBe('done');
  });

  it('work-start: leaves a waiting stage on activity', () => {
    expect(evaluateRoutes(wf.stages[0], wf, input(), 'work-start')?.route.to).toBe('implementing');
  });

  // ── verb discriminator (WS-3 Task 0 / Decision 4) ──────────────────────────
  it('work-start: a verb-less route matches ANY work-start move (legacy behavior preserved)', () => {
    // No verb on the route → matches a bare move AND any verb-carrying move.
    expect(evaluateRoutes(wf.stages[0], wf, input(), 'work-start')?.route.to).toBe('implementing');
    expect(evaluateRoutes(wf.stages[0], wf, input(), 'work-start', 'implement')?.route.to).toBe(
      'implementing',
    );
  });

  it('work-start: a verb\'d route matches ONLY the same verb', () => {
    const s = stage({
      id: 'in_progress',
      next: [{ to: 'review', on: 'work-start', verb: 'request-review' }],
    });
    const local: StageWorkflow = { id: 'w', stages: [s, stage({ id: 'review' })] };
    // `implement` at a stage whose only work-start route is verb: request-review
    // fires NOTHING (the round-3 blocker: it must not advance to review).
    expect(evaluateRoutes(s, local, input(), 'work-start', 'implement')).toBeNull();
    // A bare (verb-less) move does not match a verb'd route either.
    expect(evaluateRoutes(s, local, input(), 'work-start')).toBeNull();
    // The matching verb moves.
    expect(evaluateRoutes(s, local, input(), 'work-start', 'request-review')?.route.to).toBe('review');
  });

  it('work-start: verb selects among multiple verb\'d routes', () => {
    const s = stage({
      id: 'review',
      next: [
        { to: 'in_progress', on: 'work-start', verb: 'rework' },
        { to: 'done', on: 'work-start', verb: 'request-review' },
      ],
    });
    const local: StageWorkflow = {
      id: 'w',
      stages: [s, stage({ id: 'in_progress' }), stage({ id: 'done' })],
    };
    expect(evaluateRoutes(s, local, input(), 'work-start', 'rework')?.route.to).toBe('in_progress');
    expect(evaluateRoutes(s, local, input(), 'work-start', 'request-review')?.route.to).toBe('done');
    expect(evaluateRoutes(s, local, input(), 'work-start', 'implement')).toBeNull();
  });

  it('verdict: a valid un-fired dissent fires onDissent; a fired one does not', () => {
    const dissent = rec({ verdict: 'changes-requested', actor: 'rev' });
    const withDissent = input({ evidence: { codeReviewed: evidence([{ record: dissent, valid: true }]) } });
    const fired = evaluateRoutes(wf.stages[1], wf, withDissent, 'verdict');
    expect(fired?.route.to).toBe('implementing');
    expect(fired?.dissent?.key).toBe(dissentKey('codeReviewed', dissent));

    const already = input({
      evidence: { codeReviewed: evidence([{ record: dissent, valid: true }]) },
      firedDissents: new Set([dissentKey('codeReviewed', dissent)]),
    });
    expect(evaluateRoutes(wf.stages[1], wf, already, 'verdict')).toBeNull();
  });

  it('resolveManualRoute resolves only on:manual routes, not auto (gate/work-start) edges', () => {
    const s = stage({
      id: 'a',
      next: [
        { to: 'auto', on: 'gate' },
        { to: 'sidebar', on: 'manual' },
      ],
    });
    const local: StageWorkflow = {
      id: 'w',
      stages: [s, stage({ id: 'auto', terminal: true }), stage({ id: 'sidebar', terminal: true })],
    };
    expect(resolveManualRoute(s, local, 'sidebar')).toEqual({ route: { to: 'sidebar', on: 'manual' } });
    // An on:gate edge is NOT a manual route (distinct trigger kinds).
    const gateErr = resolveManualRoute(s, local, 'auto');
    expect('error' in gateErr && gateErr.error).toContain('manual routes are: sidebar');
    const err = resolveManualRoute(s, local, 'nope');
    expect('error' in err && err.error).toContain('manual routes are: sidebar');
  });
});

// ── advance (AC: cascade fixpoint) ───────────────────────────────────────────

describe('advance', () => {
  it('multi-hop auto-advance runs as a fixpoint in one call', () => {
    const wf: StageWorkflow = {
      id: 'w',
      stages: [
        stage({ id: 'a', gate: [{ check: 'hasRealObjective' }], next: [{ to: 'b' }] }),
        stage({ id: 'b', gate: [{ check: 'planExists' }], next: [{ to: 'c' }] }),
        stage({ id: 'c', terminal: true }),
      ],
    };
    const r = advance(wf.stages[0], wf, input({ facts: facts({ hasRealObjective: true, planExists: true }) }));
    expect(r.final).toBe('c');
    expect(r.path.map((h) => `${h.from}->${h.to}`)).toEqual(['a->b', 'b->c']);
    expect(r.capped).toBe(false);
  });

  it('a judged review with no evidence is a natural brake mid-cascade', () => {
    const wf: StageWorkflow = {
      id: 'w',
      stages: [
        stage({ id: 'a', gate: [{ check: 'acAllChecked' }], next: [{ to: 'reviewing' }] }),
        stage({ id: 'reviewing', gate: [{ check: 'codeReviewed', judge: 'reviewer' }], next: [{ to: 'done' }] }),
        stage({ id: 'done', terminal: true }),
      ],
    };
    const r = advance(wf.stages[0], wf, input({ facts: facts({ acAllChecked: true }) }));
    expect(r.final).toBe('reviewing');
  });

  it('hop cap = stage count guards an empty-gate cycle (no infinite loop)', () => {
    const wf: StageWorkflow = {
      id: 'w',
      stages: [
        stage({ id: 'a', next: [{ to: 'b' }] }),
        stage({ id: 'b', next: [{ to: 'a' }] }),
      ],
    };
    const r = advance(wf.stages[0], wf, input());
    expect(r.capped).toBe(true);
    expect(r.path.length).toBe(2);
  });

  it('a dissent fires once, then the `not:` hold pins the ticket (no ping-pong); the key is returned', () => {
    const dissent = rec({ fact: 'codeReviewed', verdict: 'changes-requested', actor: 'rev' });
    const wf: StageWorkflow = {
      id: 'w',
      stages: [
        stage({
          id: 'reviewing',
          gate: [{ check: 'codeReviewed', judge: 'reviewer' }],
          next: [{ to: 'done' }],
          onDissent: 'implementing',
        }),
        stage({
          id: 'implementing',
          gate: [{ check: 'acAllChecked' }, { check: '', not: 'codeReviewedChangesRequested' }],
          next: [{ to: 'reviewing' }],
        }),
        stage({ id: 'done', terminal: true }),
      ],
    };
    const r = advance(
      wf.stages[0],
      wf,
      input({
        facts: facts({ acAllChecked: true, codeReviewedChangesRequested: true } as Partial<AssignmentFacts>),
        evidence: { codeReviewed: evidence([{ record: dissent, valid: true }]) },
      }),
    );
    // reviewing → implementing (verdict), then implementing's `not:` hold blocks
    // the return to reviewing → cascade stops at implementing.
    expect(r.final).toBe('implementing');
    expect(r.path.map((h) => `${h.from}->${h.to}`)).toEqual(['reviewing->implementing']);
    expect(r.firedDissents).toEqual([dissentKey('codeReviewed', dissent)]);
  });

  it('does not auto-advance a paused ticket (blocked/parked/held); manual routes stay allowed', () => {
    const wf: StageWorkflow = {
      id: 'w',
      stages: [
        stage({
          id: 'a',
          gate: [{ check: 'hasRealObjective' }],
          next: [{ to: 'b' }, { to: 'sidebar', on: 'manual' }],
        }),
        stage({ id: 'b', terminal: true }),
        stage({ id: 'sidebar', terminal: true }),
      ],
    };
    const passing = facts({ hasRealObjective: true });
    expect(advance(wf.stages[0], wf, input({ facts: facts({ hasRealObjective: true, blocked: true }) })).final).toBe('a');
    expect(advance(wf.stages[0], wf, input({ facts: facts({ hasRealObjective: true, parked: true }) })).final).toBe('a');
    expect(advance(wf.stages[0], wf, input({ facts: passing, held: true })).final).toBe('a');
    // Not paused → advances normally.
    expect(advance(wf.stages[0], wf, input({ facts: passing })).final).toBe('b');
    // A manual move stays allowed even while paused (resolveManualRoute ignores pause).
    expect(resolveManualRoute(wf.stages[0], wf, 'sidebar')).toEqual({ route: { to: 'sidebar', on: 'manual' } });
  });
});

// ── checkRegressions (AC: regression policy) ─────────────────────────────────

describe('checkRegressions', () => {
  const wf: StageWorkflow = {
    id: 'w',
    stages: [stage({ id: 'a', gate: [{ check: 'planApproved' }] }), stage({ id: 'done', terminal: true })],
  };

  it('flags a check that admitted the ticket and has since gone false', () => {
    const traversed = [{ stage: 'a', snapshot: [{ key: 'a:0', label: 'planApproved', passed: true }] }];
    const findings = checkRegressions(traversed, wf, input({ facts: facts({ planApproved: false }) }));
    expect(findings).toEqual([{ stage: 'a', key: 'a:0', label: 'planApproved', policy: 'flag' }]);
  });

  it('does not flag an overridden passage (it never passed)', () => {
    const traversed = [
      { stage: 'a', snapshot: [{ key: 'a:0', label: 'planApproved', passed: true, overridden: true }] },
    ];
    expect(checkRegressions(traversed, wf, input({ facts: facts({ planApproved: false }) }))).toEqual([]);
  });

  it('does not flag when the check still passes', () => {
    const traversed = [{ stage: 'a', snapshot: [{ key: 'a:0', label: 'planApproved', passed: true }] }];
    expect(checkRegressions(traversed, wf, input({ facts: facts({ planApproved: true }) }))).toEqual([]);
  });

  it('does not flag when the live predicate at that key differs from the snapshot (gate edited)', () => {
    // The live gate at a:0 is now `hasRealObjective`, but the snapshot captured
    // `planApproved` at a:0 → labels differ → skip, no false regression, even
    // though hasRealObjective is false.
    const edited: StageWorkflow = {
      id: 'w',
      stages: [stage({ id: 'a', gate: [{ check: 'hasRealObjective' }] }), stage({ id: 'done', terminal: true })],
    };
    const traversed = [{ stage: 'a', snapshot: [{ key: 'a:0', label: 'planApproved', passed: true }] }];
    expect(checkRegressions(traversed, edited, input({ facts: facts({ hasRealObjective: false }) }))).toEqual([]);
  });
});

// ── detectAutoRouteCycles (AC: cascade cycle validation) ─────────────────────

describe('detectAutoRouteCycles', () => {
  it('empty-gate on:gate cycle → error', () => {
    const wf: StageWorkflow = {
      id: 'w',
      stages: [stage({ id: 'a', next: [{ to: 'b' }] }), stage({ id: 'b', next: [{ to: 'a' }] })],
    };
    const diags = detectAutoRouteCycles(wf);
    expect(diags.length).toBe(1);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].path.sort()).toEqual(['a', 'b']);
  });

  it('guarded on:gate cycle (both stages gated) → warning', () => {
    const wf: StageWorkflow = {
      id: 'w',
      stages: [
        stage({ id: 'a', gate: [{ check: 'x' }], next: [{ to: 'b' }] }),
        stage({ id: 'b', gate: [{ check: 'y' }], next: [{ to: 'a' }] }),
      ],
    };
    const diags = detectAutoRouteCycles(wf);
    expect(diags.length).toBe(1);
    expect(diags[0].severity).toBe('warning');
  });

  it('no cycle → no diagnostics; non-gate (manual/work-start) loops are ignored', () => {
    const acyclic: StageWorkflow = {
      id: 'w',
      stages: [stage({ id: 'a', next: [{ to: 'done' }] }), stage({ id: 'done', terminal: true })],
    };
    expect(detectAutoRouteCycles(acyclic)).toEqual([]);
    const manualLoop: StageWorkflow = {
      id: 'w',
      stages: [
        stage({ id: 'a', next: [{ to: 'b', on: 'work-start' }] }),
        stage({ id: 'b', next: [{ to: 'a', on: 'manual' }, { to: 'done' }] }),
        stage({ id: 'done', terminal: true }),
      ],
    };
    expect(detectAutoRouteCycles(manualLoop)).toEqual([]);
  });
});
