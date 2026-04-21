import { describe, it, expect } from 'vitest';
import {
  extractFrontmatter,
  parseProject,
  parseStatus,
  parseAssignmentSummary,
  parseAssignmentFull,
  parsePlan,
  parseScratchpad,
  parseHandoff,
  parseDecisionRecord,
  parseResource,
  parseMemory,
  extractMermaidGraph,
} from '../dashboard/parser.js';

describe('extractFrontmatter', () => {
  it('extracts frontmatter and body from a standard file', () => {
    const content = '---\nkey: value\n---\n\nBody content here.';
    const [fm, body] = extractFrontmatter(content);
    expect(fm).toBe('key: value');
    expect(body).toBe('Body content here.');
  });

  it('returns empty frontmatter and full body when no delimiters', () => {
    const content = 'No frontmatter here.';
    const [fm, body] = extractFrontmatter(content);
    expect(fm).toBe('');
    expect(body).toBe('No frontmatter here.');
  });
});

describe('parseProject', () => {
  const PROJECT_MD = `---
id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
slug: build-auth-system
title: Build Authentication System
archived: false
archivedAt: null
archivedReason: null
created: "2026-03-15T09:00:00Z"
updated: "2026-03-15T09:00:00Z"
externalIds:
  - system: jira
    id: AUTH-42
    url: https://jira.example.com/browse/AUTH-42
tags: []
---

# Build Authentication System

Overview content.`;

  it('parses project frontmatter correctly', () => {
    const project = parseProject(PROJECT_MD);
    expect(project.slug).toBe('build-auth-system');
    expect(project.title).toBe('Build Authentication System');
    expect(project.archived).toBe(false);
    expect(project.created).toBe('2026-03-15T09:00:00Z');
    expect(project.tags).toEqual([]);
  });

  it('extracts the body content', () => {
    const project = parseProject(PROJECT_MD);
    expect(project.body).toContain('Build Authentication System');
    expect(project.body).toContain('Overview content.');
  });
});

describe('parseStatus', () => {
  const STATUS_MD = `---
project: build-auth-system
generated: "2026-03-18T14:30:00Z"
status: active
progress:
  total: 3
  completed: 1
  in_progress: 1
  blocked: 0
  pending: 1
  review: 0
  failed: 0
needsAttention:
  blockedCount: 0
  failedCount: 0
  unansweredQuestions: 1
---

# Project Status`;

  it('parses status and progress counts', () => {
    const status = parseStatus(STATUS_MD);
    expect(status.project).toBe('build-auth-system');
    expect(status.status).toBe('active');
    expect(status.progress.total).toBe(3);
    expect(status.progress.completed).toBe(1);
    expect(status.progress.in_progress).toBe(1);
    expect(status.progress.pending).toBe(1);
  });

  it('parses needsAttention counts', () => {
    const status = parseStatus(STATUS_MD);
    expect(status.needsAttention.blockedCount).toBe(0);
    expect(status.needsAttention.unansweredQuestions).toBe(1);
  });
});

describe('parseAssignmentSummary', () => {
  const ASSIGNMENT_MD = `---
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
links: []
blockedReason: null
workspace:
  repository: /Users/test/repo
  worktreePath: null
  branch: feat/auth-schema
  parentBranch: main
tags: []
---

# Design Auth Database Schema`;

  it('parses key summary fields', () => {
    const summary = parseAssignmentSummary(ASSIGNMENT_MD);
    expect(summary.slug).toBe('design-auth-schema');
    expect(summary.title).toBe('Design Auth Database Schema');
    expect(summary.status).toBe('completed');
    expect(summary.priority).toBe('high');
    expect(summary.assignee).toBe('claude-2');
    expect(summary.dependsOn).toEqual([]);
    expect(summary.links).toEqual([]);
  });
});

describe('parseAssignmentFull', () => {
  const ASSIGNMENT_WITH_DEPS = `---
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
links:
  - other-project/some-task
blockedReason: null
workspace:
  repository: /Users/test/projects/auth-service
  worktreePath: /Users/test/worktrees/impl
  branch: feat/jwt-middleware
  parentBranch: main
tags: []
---

# JWT Middleware

Body here.`;

  it('parses all fields including dependencies and workspace', () => {
    const assignment = parseAssignmentFull(ASSIGNMENT_WITH_DEPS);
    expect(assignment.slug).toBe('implement-jwt-middleware');
    expect(assignment.status).toBe('in_progress');
    expect(assignment.assignee).toBe('claude-1');
    expect(assignment.dependsOn).toEqual(['design-auth-schema']);
    expect(assignment.links).toEqual(['other-project/some-task']);
    expect(assignment.workspace.branch).toBe('feat/jwt-middleware');
    expect(assignment.workspace.repository).toBe('/Users/test/projects/auth-service');
  });

  it('parses externalIds', () => {
    const assignment = parseAssignmentFull(ASSIGNMENT_WITH_DEPS);
    expect(assignment.externalIds).toHaveLength(1);
    expect(assignment.externalIds[0]).toEqual({
      system: 'jira',
      id: 'AUTH-43',
      url: 'https://jira.example.com/browse/AUTH-43',
    });
  });
});

describe('parsePlan', () => {
  const PLAN_MD = `---
assignment: design-auth-schema
status: completed
created: "2026-03-15T09:30:00Z"
updated: "2026-03-17T10:00:00Z"
---

# Plan

- [x] Task 1
- [ ] Task 2`;

  it('parses plan frontmatter and body', () => {
    const plan = parsePlan(PLAN_MD);
    expect(plan.assignment).toBe('design-auth-schema');
    expect(plan.status).toBe('completed');
    expect(plan.body).toContain('Task 1');
  });
});

describe('parseScratchpad', () => {
  const SCRATCHPAD_MD = `---
assignment: design-auth-schema
updated: "2026-03-17T09:00:00Z"
---

# Scratchpad

Notes here.`;

  it('parses scratchpad', () => {
    const sp = parseScratchpad(SCRATCHPAD_MD);
    expect(sp.assignment).toBe('design-auth-schema');
    expect(sp.body).toContain('Notes here.');
  });
});

describe('parseHandoff', () => {
  const HANDOFF_MD = `---
assignment: design-auth-schema
updated: "2026-03-17T10:00:00Z"
handoffCount: 1
---

# Handoff Log

## Handoff 1
Details.`;

  it('parses handoff with count', () => {
    const h = parseHandoff(HANDOFF_MD);
    expect(h.assignment).toBe('design-auth-schema');
    expect(h.handoffCount).toBe(1);
    expect(h.body).toContain('Handoff 1');
  });
});

describe('parseDecisionRecord', () => {
  const DECISION_MD = `---
assignment: design-auth-schema
updated: "2026-03-16T11:00:00Z"
decisionCount: 1
---

# Decision Record

## Decision 1
Details.`;

  it('parses decision record with count', () => {
    const d = parseDecisionRecord(DECISION_MD);
    expect(d.assignment).toBe('design-auth-schema');
    expect(d.decisionCount).toBe(1);
    expect(d.body).toContain('Decision 1');
  });
});

describe('parseResource', () => {
  const RESOURCE_MD = `---
type: resource
name: Auth Requirements
source: human
category: documentation
sourceUrl: null
sourceAssignment: null
relatedAssignments:
  - design-auth-schema
  - implement-jwt-middleware
created: "2026-03-15T09:00:00Z"
updated: "2026-03-15T09:00:00Z"
---

# Auth Requirements

Content.`;

  it('parses resource with related assignments', () => {
    const r = parseResource(RESOURCE_MD);
    expect(r.name).toBe('Auth Requirements');
    expect(r.source).toBe('human');
    expect(r.category).toBe('documentation');
    expect(r.relatedAssignments).toEqual(['design-auth-schema', 'implement-jwt-middleware']);
  });
});

describe('parseMemory', () => {
  const MEMORY_MD = `---
type: memory
name: PostgreSQL Connection Pooling
source: claude-2
sourceAssignment: design-auth-schema
relatedAssignments:
  - design-auth-schema
  - implement-jwt-middleware
scope: project
created: "2026-03-17T09:00:00Z"
updated: "2026-03-17T09:00:00Z"
tags:
  - postgresql
  - performance
---

# PostgreSQL Connection Pooling

Content.`;

  it('parses memory with all fields', () => {
    const m = parseMemory(MEMORY_MD);
    expect(m.name).toBe('PostgreSQL Connection Pooling');
    expect(m.source).toBe('claude-2');
    expect(m.scope).toBe('project');
    expect(m.sourceAssignment).toBe('design-auth-schema');
    expect(m.relatedAssignments).toEqual(['design-auth-schema', 'implement-jwt-middleware']);
  });
});

describe('extractMermaidGraph', () => {
  it('extracts mermaid definition from markdown body', () => {
    const body = '# Status\n\n```mermaid\ngraph TD\n    A --> B\n```\n\nFooter.';
    const graph = extractMermaidGraph(body);
    expect(graph).toBe('graph TD\n    A --> B');
  });

  it('returns null when no mermaid block', () => {
    expect(extractMermaidGraph('No graph here.')).toBeNull();
  });
});
