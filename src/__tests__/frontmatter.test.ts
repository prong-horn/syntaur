import { describe, it, expect } from 'vitest';
import { parseAssignmentFrontmatter, updateAssignmentFile } from '../lifecycle/frontmatter.js';

const SIMPLE_ASSIGNMENT = `---
id: test-id-123
slug: test-assignment
title: "Test Assignment"
status: pending
priority: medium
created: "2026-03-18T10:00:00Z"
updated: "2026-03-18T10:00:00Z"
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
---

# Test Assignment

Body content here.
`;

const COMPLEX_ASSIGNMENT = `---
id: complex-id-456
slug: complex-task
title: "Complex Task"
status: in_progress
priority: high
created: "2026-03-15T09:30:00Z"
updated: "2026-03-18T14:30:00Z"
assignee: claude-1
externalIds:
  - system: jira
    id: AUTH-43
    url: https://jira.example.com/browse/AUTH-43
dependsOn:
  - design-auth-schema
links:
  - other-project/some-assignment
  - my-project/another-task
blockedReason: null
workspace:
  repository: /Users/brennen/projects/auth-service
  worktreePath: /Users/brennen/projects/auth-service-worktrees/complex-task
  branch: feat/complex-task
  parentBranch: main
tags: []
---

# Complex Task

Body content here.
`;

describe('parseAssignmentFrontmatter', () => {
  it('parses simple assignment with empty arrays and null fields', () => {
    const fm = parseAssignmentFrontmatter(SIMPLE_ASSIGNMENT);
    expect(fm.id).toBe('test-id-123');
    expect(fm.slug).toBe('test-assignment');
    expect(fm.title).toBe('Test Assignment');
    expect(fm.status).toBe('pending');
    expect(fm.priority).toBe('medium');
    expect(fm.created).toBe('2026-03-18T10:00:00Z');
    expect(fm.updated).toBe('2026-03-18T10:00:00Z');
    expect(fm.assignee).toBeNull();
    expect(fm.externalIds).toEqual([]);
    expect(fm.dependsOn).toEqual([]);
    expect(fm.links).toEqual([]);
    expect(fm.blockedReason).toBeNull();
    expect(fm.workspace.repository).toBeNull();
    expect(fm.workspace.worktreePath).toBeNull();
    expect(fm.workspace.branch).toBeNull();
    expect(fm.workspace.parentBranch).toBeNull();
    expect(fm.tags).toEqual([]);
  });

  it('parses assignment with populated fields', () => {
    const fm = parseAssignmentFrontmatter(COMPLEX_ASSIGNMENT);
    expect(fm.status).toBe('in_progress');
    expect(fm.assignee).toBe('claude-1');
    expect(fm.dependsOn).toEqual(['design-auth-schema']);
    expect(fm.links).toEqual(['other-project/some-assignment', 'my-project/another-task']);
    expect(fm.workspace.repository).toBe('/Users/brennen/projects/auth-service');
    expect(fm.workspace.branch).toBe('feat/complex-task');
    expect(fm.workspace.parentBranch).toBe('main');
  });

  it('parses externalIds with nested objects', () => {
    const fm = parseAssignmentFrontmatter(COMPLEX_ASSIGNMENT);
    expect(fm.externalIds.length).toBe(1);
    expect(fm.externalIds[0]).toEqual({
      system: 'jira',
      id: 'AUTH-43',
      url: 'https://jira.example.com/browse/AUTH-43',
    });
  });

  it('throws on content without frontmatter', () => {
    expect(() => parseAssignmentFrontmatter('no frontmatter here')).toThrow(
      'No frontmatter found',
    );
  });
});

describe('updateAssignmentFile', () => {
  it('updates status field', () => {
    const result = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      status: 'in_progress',
    });
    expect(result).toContain('status: in_progress');
    expect(result).not.toContain('status: pending');
  });

  it('updates assignee from null to a name', () => {
    const result = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      assignee: 'claude-3',
    });
    expect(result).toContain('assignee: claude-3');
    expect(result).not.toContain('assignee: null');
  });

  it('updates assignee from a name back to null', () => {
    const result = updateAssignmentFile(COMPLEX_ASSIGNMENT, {
      assignee: null,
    });
    expect(result).toContain('assignee: null');
    expect(result).not.toContain('assignee: claude-1');
  });

  it('updates blockedReason to a string value', () => {
    const result = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      blockedReason: 'Waiting for API key',
    });
    expect(result).toContain('blockedReason: Waiting for API key');
  });

  it('updates blockedReason back to null', () => {
    const withReason = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      blockedReason: 'some reason',
    });
    const result = updateAssignmentFile(withReason, {
      blockedReason: null,
    });
    expect(result).toContain('blockedReason: null');
  });

  it('updates timestamp with quotes', () => {
    const result = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      updated: '2026-03-18T15:00:00Z',
    });
    expect(result).toContain('updated: "2026-03-18T15:00:00Z"');
  });

  it('preserves the markdown body unchanged', () => {
    const body = '# Test Assignment\n\nBody content here.\n';
    const result = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      status: 'in_progress',
      assignee: 'claude-1',
      updated: '2026-03-18T15:00:00Z',
    });
    expect(result).toContain(body);
  });

  it('updates multiple fields at once', () => {
    const result = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      status: 'blocked',
      blockedReason: 'Need API key',
      updated: '2026-03-18T16:00:00Z',
    });
    expect(result).toContain('status: blocked');
    expect(result).toContain('blockedReason: Need API key');
    expect(result).toContain('updated: "2026-03-18T16:00:00Z"');
  });
});
