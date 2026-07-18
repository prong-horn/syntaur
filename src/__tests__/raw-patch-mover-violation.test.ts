import { describe, expect, it } from 'vitest';
import { rawPatchMoverViolation } from '../dashboard/api-write.js';
import { parseAssignmentFull } from '../dashboard/parser.js';

/**
 * WS-2 Task 2.6 — the raw whole-document PATCH is default-deny on a migrated
 * assignment: only inert scalar-metadata edits pass; any field that moves a
 * ticket or alters derived/gate/pause state is rejected. This pins the exact
 * allow/reject list (the codex r5 `blockedReason` correction in particular).
 */

const BASE = `---
id: t-id
slug: t
title: "T"
project: p
status: in_progress
priority: medium
created: "2026-06-09T10:00:00Z"
updated: "2026-06-09T10:00:00Z"
assignee: null
externalIds: []
dependsOn: []
links: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
phase: in_progress
disposition: active
parked: false
reviewRequested: false
reworkRequested: false
implementationStarted: true
override: null
planApproval: null
facts: {}
attestations: []
statusHistory: []
hold: false
gateOverrides: []
frozenChecks: []
firedVerdicts: []
solicitations: []
---

# T

## Objective

Real.
`;

function violation(next: string): string | null {
  return rawPatchMoverViolation(parseAssignmentFull(BASE), parseAssignmentFull(next));
}

describe('rawPatchMoverViolation', () => {
  it('passes (null) when nothing changed', () => {
    expect(violation(BASE)).toBeNull();
  });

  it('permits inert scalar-metadata edits (title / priority / assignee / tags)', () => {
    expect(violation(BASE.replace('title: "T"', 'title: "T2"'))).toBeNull();
    expect(violation(BASE.replace('priority: medium', 'priority: high'))).toBeNull();
    expect(violation(BASE.replace('assignee: null', 'assignee: "agent:x"'))).toBeNull();
    expect(violation(BASE.replace('tags: []', 'tags: [urgent]'))).toBeNull();
  });

  // Each mover / derived / gate / pause field is rejected by its own name.
  const rejected: Array<[string, string]> = [
    ['status', BASE.replace('status: in_progress', 'status: completed')],
    ['disposition', BASE.replace('disposition: active', 'disposition: blocked')],
    ['phase', BASE.replace('phase: in_progress', 'phase: review')],
    ['parked', BASE.replace('parked: false', 'parked: true')],
    ['blockedReason', BASE.replace('blockedReason: null', 'blockedReason: "stuck"')],
    ['reviewRequested', BASE.replace('reviewRequested: false', 'reviewRequested: true')],
    ['reworkRequested', BASE.replace('reworkRequested: false', 'reworkRequested: true')],
    [
      'implementationStarted',
      BASE.replace('implementationStarted: true', 'implementationStarted: false'),
    ],
    [
      'override',
      BASE.replace(
        'override: null',
        'override:\n  status: in_progress\n  source: human\n  reason: null\n  at: "2026-06-09T10:00:00Z"',
      ),
    ],
    [
      'planApproval',
      BASE.replace(
        'planApproval: null',
        'planApproval:\n  file: plan.md\n  digest: d\n  by: human\n  at: "2026-06-09T10:00:00Z"',
      ),
    ],
    ['facts', BASE.replace('facts: {}', 'facts:\n  qaPassed: true')],
    [
      'attestations',
      BASE.replace(
        'attestations: []',
        'attestations:\n  - fact: codeReview\n    actor: human\n    verdict: approved\n    at: "t"',
      ),
    ],
    [
      'statusHistory',
      BASE.replace(
        'statusHistory: []',
        'statusHistory:\n  - at: "t"\n    from: in_progress\n    to: completed\n    command: complete\n    by: human',
      ),
    ],
    // WS-2 stage-engine fields (codex review blocker 1).
    ['hold', BASE.replace('hold: false', 'hold: true')],
    [
      'gateOverrides',
      BASE.replace(
        'gateOverrides: []',
        'gateOverrides:\n  - stage: building\n    key: "building:0"\n    label: acAllChecked\n    from: building\n    to: reviewing\n    actor: human\n    at: "t"',
      ),
    ],
    [
      'frozenChecks',
      BASE.replace(
        'frozenChecks: []',
        'frozenChecks:\n  - key: "building:0"\n    label: acAllChecked\n    passed: true',
      ),
    ],
    ['firedVerdicts', BASE.replace('firedVerdicts: []', 'firedVerdicts:\n  - "codeReviewed:human:t:none"')],
    [
      'solicitations',
      BASE.replace(
        'solicitations: []',
        'solicitations:\n  - check: codeReviewed\n    at: "t"\n    state: solicited',
      ),
    ],
  ];

  it.each(rejected)('rejects a change to `%s`', (field, next) => {
    expect(violation(next)).toBe(field);
  });

  it('blockedReason is NOT inert (codex r5) — a raw block bypasses the locked path', () => {
    // Regression guard: the derive of the `blocked` fact (which the engine's
    // isPaused reads) keys off blockedReason, so it must never be allow-listed.
    expect(violation(BASE.replace('blockedReason: null', 'blockedReason: "x"'))).toBe(
      'blockedReason',
    );
  });
});
