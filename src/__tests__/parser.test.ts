import { describe, it, expect } from 'vitest';
import {
  parseFrontmatter,
  extractBody,
  parseSessionsTable,
  countUnansweredQuestions,
  parseLatestDecision,
} from '../rebuild/parser.js';

describe('parseFrontmatter', () => {
  it('parses flat key-value pairs', () => {
    const content = `---
slug: my-assignment
title: "My Assignment"
status: pending
priority: high
---
# Body`;
    const fm = parseFrontmatter(content);
    expect(fm['slug']).toBe('my-assignment');
    expect(fm['title']).toBe('My Assignment');
    expect(fm['status']).toBe('pending');
    expect(fm['priority']).toBe('high');
  });

  it('parses numbers', () => {
    const content = `---
decisionCount: 3
total: 0
---`;
    const fm = parseFrontmatter(content);
    expect(fm['decisionCount']).toBe(3);
    expect(fm['total']).toBe(0);
  });

  it('parses booleans', () => {
    const content = `---
archived: false
enabled: true
---`;
    const fm = parseFrontmatter(content);
    expect(fm['archived']).toBe(false);
    expect(fm['enabled']).toBe(true);
  });

  it('parses null', () => {
    const content = `---
assignee: null
blockedReason: null
---`;
    const fm = parseFrontmatter(content);
    expect(fm['assignee']).toBe(null);
    expect(fm['blockedReason']).toBe(null);
  });

  it('parses inline empty array', () => {
    const content = `---
tags: []
externalIds: []
---`;
    const fm = parseFrontmatter(content);
    expect(fm['tags']).toEqual([]);
    expect(fm['externalIds']).toEqual([]);
  });

  it('parses block array of scalars', () => {
    const content = `---
dependsOn:
  - design-auth-schema
  - implement-jwt-middleware
---`;
    const fm = parseFrontmatter(content);
    expect(fm['dependsOn']).toEqual([
      'design-auth-schema',
      'implement-jwt-middleware',
    ]);
  });

  it('parses block array of objects', () => {
    const content = `---
externalIds:
  - system: jira
    id: AUTH-43
    url: https://jira.example.com/browse/AUTH-43
---`;
    const fm = parseFrontmatter(content);
    expect(fm['externalIds']).toEqual([
      {
        system: 'jira',
        id: 'AUTH-43',
        url: 'https://jira.example.com/browse/AUTH-43',
      },
    ]);
  });

  it('parses nested object', () => {
    const content = `---
workspace:
  repository: /Users/brennen/projects/auth-service
  worktreePath: /Users/brennen/projects/auth-worktrees/task
  branch: feat/auth
  parentBranch: main
---`;
    const fm = parseFrontmatter(content);
    expect(fm['workspace']).toEqual({
      repository: '/Users/brennen/projects/auth-service',
      worktreePath: '/Users/brennen/projects/auth-worktrees/task',
      branch: 'feat/auth',
      parentBranch: 'main',
    });
  });

  it('parses nested object with null values', () => {
    const content = `---
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
---`;
    const fm = parseFrontmatter(content);
    expect(fm['workspace']).toEqual({
      repository: null,
      worktreePath: null,
      branch: null,
      parentBranch: null,
    });
  });

  it('returns empty object for missing frontmatter', () => {
    const content = `# No frontmatter here`;
    expect(parseFrontmatter(content)).toEqual({});
  });

  it('parses the full design-auth-schema assignment frontmatter', () => {
    const content = `---
id: d1e2f3a4-b5c6-7890-abcd-111111111111
slug: design-auth-schema
title: Design Auth Database Schema
status: completed
priority: high
created: "2026-03-15T09:30:00Z"
updated: "2026-03-17T10:00:00Z"
assignee: claude-2
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: /Users/brennen/projects/auth-service
  worktreePath: /Users/brennen/projects/auth-service-worktrees/design-auth-schema
  branch: feat/auth-schema
  parentBranch: main
tags: []
---`;
    const fm = parseFrontmatter(content);
    expect(fm['slug']).toBe('design-auth-schema');
    expect(fm['status']).toBe('completed');
    expect(fm['assignee']).toBe('claude-2');
    expect(fm['externalIds']).toEqual([]);
    expect(fm['dependsOn']).toEqual([]);
    expect(fm['blockedReason']).toBe(null);
    expect(fm['workspace']).toEqual({
      repository: '/Users/brennen/projects/auth-service',
      worktreePath:
        '/Users/brennen/projects/auth-service-worktrees/design-auth-schema',
      branch: 'feat/auth-schema',
      parentBranch: 'main',
    });
    expect(fm['tags']).toEqual([]);
  });

  it('parses the full implement-jwt-middleware assignment frontmatter', () => {
    const content = `---
id: d1e2f3a4-b5c6-7890-abcd-222222222222
slug: implement-jwt-middleware
title: Implement JWT Authentication Middleware
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
blockedReason: null
workspace:
  repository: /Users/brennen/projects/auth-service
  worktreePath: /Users/brennen/projects/auth-service-worktrees/implement-jwt-middleware
  branch: feat/jwt-middleware
  parentBranch: main
tags: []
---`;
    const fm = parseFrontmatter(content);
    expect(fm['slug']).toBe('implement-jwt-middleware');
    expect(fm['status']).toBe('in_progress');
    expect(fm['assignee']).toBe('claude-1');
    expect(fm['externalIds']).toEqual([
      {
        system: 'jira',
        id: 'AUTH-43',
        url: 'https://jira.example.com/browse/AUTH-43',
      },
    ]);
    expect(fm['dependsOn']).toEqual(['design-auth-schema']);
    expect(fm['tags']).toEqual([]);
  });
});

describe('extractBody', () => {
  it('returns content after closing ---', () => {
    const content = `---
slug: test
---

# Title

Body content here.`;
    const body = extractBody(content);
    expect(body).toContain('# Title');
    expect(body).toContain('Body content here.');
  });

  it('returns full content when no frontmatter', () => {
    const content = `# No frontmatter\n\nJust body.`;
    expect(extractBody(content)).toBe(content);
  });
});

describe('parseSessionsTable', () => {
  it('parses active and completed sessions', () => {
    const body = `
## Sessions

| Session ID | Agent | Started | Ended | Status |
|------------|-------|---------|-------|--------|
| tmux:syntaur-jwt-1 | claude-1 | 2026-03-17T10:30:00Z | null | active |
| tmux:syntaur-jwt-0 | claude-1 | 2026-03-16T09:00:00Z | 2026-03-16T18:00:00Z | completed |

## Progress`;
    const sessions = parseSessionsTable(body);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toEqual({
      sessionId: 'tmux:syntaur-jwt-1',
      agent: 'claude-1',
      started: '2026-03-17T10:30:00Z',
      ended: null,
      status: 'active',
    });
    expect(sessions[1]).toEqual({
      sessionId: 'tmux:syntaur-jwt-0',
      agent: 'claude-1',
      started: '2026-03-16T09:00:00Z',
      ended: '2026-03-16T18:00:00Z',
      status: 'completed',
    });
  });

  it('returns empty array when no sessions table', () => {
    const body = `## Sessions\n\nNo sessions yet.\n\n## Progress`;
    expect(parseSessionsTable(body)).toEqual([]);
  });

  it('returns empty array for empty table', () => {
    const body = `
## Sessions

| Session ID | Agent | Started | Ended | Status |
|------------|-------|---------|-------|--------|

## Questions & Answers`;
    expect(parseSessionsTable(body)).toEqual([]);
  });
});

describe('countUnansweredQuestions', () => {
  it('counts pending answers', () => {
    const body = `
## Questions & Answers

### Q: First question?
**Asked:** 2026-03-18T11:00:00Z
**A:** pending

### Q: Second question?
**Asked:** 2026-03-18T12:00:00Z
**A:** This is a real answer.

### Q: Third question?
**Asked:** 2026-03-18T13:00:00Z
**A:** pending`;
    expect(countUnansweredQuestions(body)).toBe(2);
  });

  it('returns 0 when no questions', () => {
    const body = `## Questions & Answers\n\nNo questions yet.`;
    expect(countUnansweredQuestions(body)).toBe(0);
  });

  it('returns 0 when all answered', () => {
    const body = `
### Q: A question?
**Asked:** 2026-03-18T11:00:00Z
**A:** A real answer here.`;
    expect(countUnansweredQuestions(body)).toBe(0);
  });
});

describe('parseLatestDecision', () => {
  it('parses single decision', () => {
    const body = `
# Decision Record

## Decision 1: Use PostgreSQL for user store

**Date:** 2026-03-16T11:00:00Z
**Status:** accepted
**Context:** Some context.
**Decision:** Use PostgreSQL.
**Consequences:** Simplifies operations.`;
    const result = parseLatestDecision(body);
    expect(result).toEqual({
      title: 'Use PostgreSQL for user store',
      status: 'accepted',
    });
  });

  it('returns the last decision when multiple exist', () => {
    const body = `
## Decision 1: First decision

**Status:** superseded

## Decision 2: Second decision

**Status:** accepted`;
    const result = parseLatestDecision(body);
    expect(result).toEqual({
      title: 'Second decision',
      status: 'accepted',
    });
  });

  it('returns null when no decisions', () => {
    const body = `# Decision Record\n\nNo decisions recorded yet.`;
    expect(parseLatestDecision(body)).toBe(null);
  });
});
