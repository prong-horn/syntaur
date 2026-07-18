import { describe, expect, it } from 'vitest';
import { buildEngineInput, getCheckStates } from '../lifecycle/engine-input.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';
import type { AttestationEnv } from '../lifecycle/facts.js';
import type { AssignmentFrontmatter, AttestationRecord, Solicitation } from '../lifecycle/types.js';
import type { AssignmentFacts } from '../lifecycle/derive.js';
import type { StageWorkflow } from '../utils/stage-model.js';

// A workflow whose `reviewing` gate is a judged, commit-bound `codeReviewed`
// check with NO corresponding legacy `facts:` declaration (the blocker-1 case).
const WF: StageWorkflow = {
  id: 'w',
  stages: [
    { id: 'building', gate: [{ check: 'acAllChecked' }], next: [{ to: 'reviewing' }] },
    {
      id: 'reviewing',
      gate: [{ check: 'codeReviewed', by: 'not-author', judge: 'reviewer', binds: 'commit' }],
      next: [{ to: 'done' }],
    },
    { id: 'done', terminal: true },
  ],
  terminalFailure: 'failed',
};

const BASE = `---
id: a
slug: t
title: T
status: reviewing
priority: medium
created: "2026-07-09T00:00:00Z"
updated: "2026-07-09T00:00:00Z"
statusHistory: []
---
# T
`;

function fm(overrides: Partial<AssignmentFrontmatter>): AssignmentFrontmatter {
  return { ...parseAssignmentFrontmatter(BASE), ...overrides };
}

const HEAD = 'deadbeefcafe';
const env: AttestationEnv = { latestPlanFile: null, planDigest: null, headSha: HEAD };
const facts = {} as AssignmentFacts;

const rec = (o: Partial<AttestationRecord> = {}): AttestationRecord => ({
  fact: 'codeReviewed',
  actor: 'rev',
  verdict: 'approved',
  at: '2026-07-09T01:00:00Z',
  commit: HEAD,
  ...o,
});

describe('buildEngineInput', () => {
  it('builds evidence for a stage-only judged gate check with no legacy declaration (blocker-1)', () => {
    const input = buildEngineInput(fm({ attestations: [rec()] }), facts, WF, env);
    const ev = input.evidence['codeReviewed'];
    expect(ev).toBeDefined();
    expect(ev.records).toHaveLength(1);
    // commit binding matches the live HEAD env → valid.
    expect(ev.records[0].valid).toBe(true);
  });

  it('marks a stale-commit attestation invalid', () => {
    const input = buildEngineInput(fm({ attestations: [rec({ commit: 'oldsha' })] }), facts, WF, env);
    expect(input.evidence['codeReviewed'].records[0].valid).toBe(false);
  });

  it('computes solicitation currentness against the env', () => {
    const sols: Solicitation[] = [
      { check: 'codeReviewed', judge: 'reviewer', revisionBinding: HEAD, at: '2026-07-09T02:00:00Z', state: 'solicited' },
      { check: 'codeReviewed', revisionBinding: 'oldsha', at: '2026-07-09T03:00:00Z', state: 'solicited' },
    ];
    const input = buildEngineInput(fm({ solicitations: sols }), facts, WF, env);
    const ev = input.evidence['codeReviewed'];
    expect(ev.solicitations.map((s) => s.current)).toEqual([true, false]);
  });

  it('threads firedVerdicts → firedDissents and hold → held', () => {
    const input = buildEngineInput(fm({ firedVerdicts: ['k1', 'k2'], hold: true }), facts, WF, env);
    expect([...input.firedDissents].sort()).toEqual(['k1', 'k2']);
    expect(input.held).toBe(true);
  });
});

describe('getCheckStates (freeze read choke point)', () => {
  it('evaluates the current stage live when not frozen', () => {
    const states = getCheckStates(fm({ attestations: [rec()] }), facts, WF, env);
    expect(states).toHaveLength(1);
    expect(states[0].label).toBe('codeReviewed');
    expect(states[0].passed).toBe(true); // valid current attestation
  });

  it('returns the frozen snapshot verbatim for a terminal ticket (no live re-eval)', () => {
    // status=done (terminal), frozenChecks says codeReviewed passed — but there
    // is NO valid attestation now (stale commit). Freeze must ignore that.
    const frontmatter = fm({
      status: 'done',
      attestations: [rec({ commit: 'stale-after-cleanup' })],
      frozenChecks: [{ key: 'done:0', label: 'codeReviewed', passed: true }],
    });
    const states = getCheckStates(frontmatter, facts, WF, env);
    expect(states).toHaveLength(1);
    expect(states[0].passed).toBe(true); // frozen value, NOT the now-stale live eval
    expect(states[0].label).toBe('codeReviewed');
  });
});
