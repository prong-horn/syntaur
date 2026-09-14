import { describe, expect, it } from 'vitest';
import { toggleAcceptanceCriterion } from '../dashboard/acceptance-criteria.js';

const TICKET_WITH_CRITERIA = `---
id: ticket-1
slug: test-ticket
title: Test Ticket
status: pending
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
assignee: codex-1
externalIds: []
depends_on: []
blockedReason: null
workspace:
  repository: null
  worktree: null
  branch: null
  parentBranch: null
tags: []
---

# Test Ticket

## Objective

Ship the dashboard patch.

## Acceptance Criteria

- [ ] First criterion
- [x] Second criterion

## Context

Notes go here.
`;

describe('toggleAcceptanceCriterion', () => {
  it('toggles an unchecked criterion to checked without changing other content', () => {
    const result = toggleAcceptanceCriterion(TICKET_WITH_CRITERIA, 0, true);
    expect('error' in result).toBe(false);
    expect((result as { content: string }).content).toContain('- [x] First criterion');
    expect((result as { content: string }).content).toContain('- [x] Second criterion');
    expect((result as { content: string }).content).toContain('## Context');
  });

  it('toggles a checked criterion back to unchecked', () => {
    const result = toggleAcceptanceCriterion(TICKET_WITH_CRITERIA, 1, false);
    expect('error' in result).toBe(false);
    expect((result as { content: string }).content).toContain('- [ ] Second criterion');
  });

  it('rejects a missing Acceptance Criteria section', () => {
    expect(toggleAcceptanceCriterion('# No checklist here', 0, true)).toEqual({
      error: 'Acceptance Criteria section not found.',
    });
  });

  it('rejects an out-of-range checklist index', () => {
    expect(toggleAcceptanceCriterion(TICKET_WITH_CRITERIA, 3, true)).toEqual({
      error: 'Acceptance criteria item 3 not found.',
    });
  });
});
