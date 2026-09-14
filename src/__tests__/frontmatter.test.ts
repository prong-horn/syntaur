import { describe, it, expect } from 'vitest';
import {
  parseTicketFrontmatter,
  updateTicketFile,
  updateTicketWorkspace,
  updatePlanBlock,
} from '../lifecycle/frontmatter.js';

const SIMPLE_TICKET = `---
id: test-id-123
slug: test-ticket
title: "Test Ticket"
project: null
template: feature
status: pending
priority: medium
blocked: null
parked: null
created: "2026-03-18T10:00:00Z"
updated: "2026-03-18T10:00:00Z"
assignee: null
depends_on: []
links: []
tags: []
workspace:
  repository: null
  worktree: null
  branch: null
  parentBranch: null
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
---

# Test Ticket

Body content here.
`;

const COMPLEX_TICKET = `---
id: complex-id-456
slug: complex-task
title: "Complex Task"
project: auth
template: feature
status: in_progress
priority: high
blocked: null
parked: null
created: "2026-03-15T09:30:00Z"
updated: "2026-03-18T14:30:00Z"
assignee: claude-1
depends_on:
  - design-auth-schema
links:
  - other-project/some-ticket
  - my-project/another-task
tags: []
workspace:
  repository: /Users/brennen/projects/auth-service
  worktree: /Users/brennen/projects/auth-service-worktrees/complex-task
  branch: feat/complex-task
  parentBranch: main
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
---

# Complex Task

Body content here.
`;

describe('parseTicketFrontmatter', () => {
  it('parses simple ticket with empty arrays and null fields', () => {
    const fm = parseTicketFrontmatter(SIMPLE_TICKET);
    expect(fm.id).toBe('test-id-123');
    expect(fm.slug).toBe('test-ticket');
    expect(fm.title).toBe('Test Ticket');
    expect(fm.status).toBe('pending');
    expect(fm.priority).toBe('medium');
    expect(fm.created).toBe('2026-03-18T10:00:00Z');
    expect(fm.updated).toBe('2026-03-18T10:00:00Z');
    expect(fm.assignee).toBeNull();
    expect(fm.depends_on).toEqual([]);
    expect(fm.links).toEqual([]);
    expect(fm.blocked).toBeNull();
    expect(fm.parked).toBeNull();
    expect(fm.workspace.repository).toBeNull();
    expect(fm.workspace.worktree).toBeNull();
    expect(fm.workspace.branch).toBeNull();
    expect(fm.workspace.parentBranch).toBeNull();
    expect(fm.tags).toEqual([]);
    expect(fm.plan.file).toBeNull();
  });

  it('parses ticket with populated fields', () => {
    const fm = parseTicketFrontmatter(COMPLEX_TICKET);
    expect(fm.status).toBe('in_progress');
    expect(fm.assignee).toBe('claude-1');
    expect(fm.depends_on).toEqual(['design-auth-schema']);
    expect(fm.links).toEqual(['other-project/some-ticket', 'my-project/another-task']);
    expect(fm.workspace.repository).toBe('/Users/brennen/projects/auth-service');
    expect(fm.workspace.worktree).toBe(
      '/Users/brennen/projects/auth-service-worktrees/complex-task',
    );
    expect(fm.workspace.branch).toBe('feat/complex-task');
    expect(fm.workspace.parentBranch).toBe('main');
  });

  it('throws on content without frontmatter', () => {
    expect(() => parseTicketFrontmatter('no frontmatter here')).toThrow('No frontmatter found');
  });
});

describe('updateTicketFile', () => {
  it('updates allow-listed fields only', () => {
    const result = updateTicketFile(SIMPLE_TICKET, {
      status: 'in_progress',
      blocked: 'Need API key',
      parked: 'Waiting on review',
      updated: '2026-03-18T16:00:00Z',
    });
    expect(result).toContain('status: in_progress');
    expect(result).toContain('blocked: Need API key');
    expect(result).toContain('parked: Waiting on review');
    expect(result).toContain('updated: "2026-03-18T16:00:00Z"');
    const fm = parseTicketFrontmatter(result);
    expect(fm.status).toBe('in_progress');
    expect(fm.blocked).toBe('Need API key');
    expect(fm.parked).toBe('Waiting on review');
  });

  it('round-trips quoted blocked values', () => {
    const result = updateTicketFile(SIMPLE_TICKET, {
      blocked: '"connection refused"',
    });
    expect(parseTicketFrontmatter(result).blocked).toBe('"connection refused"');
  });

  it('preserves the markdown body', () => {
    const body = '# Test Ticket\n\nBody content here.\n';
    const result = updateTicketFile(SIMPLE_TICKET, { status: 'review' });
    expect(result).toContain(body);
  });
});

describe('updateTicketWorkspace', () => {
  it('writes workspace.worktree field', () => {
    const next = updateTicketWorkspace(SIMPLE_TICKET, {
      worktree: '/tmp/wt',
    });
    const legacyWtKey = 'work' + 'treePath:';
    expect(next).toContain('worktree: /tmp/wt');
    expect(next).not.toContain(legacyWtKey);
    expect(parseTicketFrontmatter(next).workspace.worktree).toBe('/tmp/wt');
  });
});

describe('updatePlanBlock', () => {
  it('updates plan approval fields', () => {
    const next = updatePlanBlock(SIMPLE_TICKET, {
      file: 'plan.md',
      approvedAt: '2026-04-01T00:00:00Z',
      approvedBy: 'human',
    });
    const fm = parseTicketFrontmatter(next);
    expect(fm.plan.file).toBe('plan.md');
    expect(fm.plan.approvedAt).toBe('2026-04-01T00:00:00Z');
    expect(fm.plan.approvedBy).toBe('human');
  });
});
