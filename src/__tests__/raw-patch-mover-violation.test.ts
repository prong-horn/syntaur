import { describe, expect, it } from 'vitest';
import { rawPatchMoverViolation } from '../dashboard/api-write.js';
import { parseTicketFull } from '../dashboard/parser.js';

const BASE = `---
id: t-id
slug: t
title: "T"
project: p
template: feature
status: in_progress
priority: medium
blocked: null
parked: null
created: "2026-06-09T10:00:00Z"
updated: "2026-06-09T10:00:00Z"
assignee: null
depends_on: []
links: []
workspace:
  repository: null
  worktree: null
  branch: null
  parentBranch: null
tags: []
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
---

# T

## Objective

Real.
`;

function violation(next: string): string | null {
  return rawPatchMoverViolation(parseTicketFull(BASE), parseTicketFull(next));
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

  const rejected: Array<[string, string]> = [
    ['status', BASE.replace('status: in_progress', 'status: done')],
    ['parked', BASE.replace('parked: null', 'parked: "waiting"')],
    ['blocked', BASE.replace('blocked: null', 'blocked: "stuck"')],
    [
      'plan',
      BASE.replace(
        'approvedDigest: null',
        'approvedDigest: d',
      ),
    ],
  ];

  it.each(rejected)('rejects a change to `%s`', (field, next) => {
    expect(violation(next)).toBe(field);
  });

  it('blocked is NOT inert — a raw block bypasses the verb path', () => {
    expect(violation(BASE.replace('blocked: null', 'blocked: "x"'))).toBe('blocked');
  });
});
