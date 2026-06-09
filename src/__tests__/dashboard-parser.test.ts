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

  it('parses externalIds', () => {
    const project = parseProject(PROJECT_MD);
    expect(project.externalIds).toHaveLength(1);
    expect(project.externalIds[0]).toEqual({
      system: 'jira',
      id: 'AUTH-42',
      url: 'https://jira.example.com/browse/AUTH-42',
    });
  });

  it('returns an empty externalIds array when frontmatter has none', () => {
    const PROJECT_NO_EXT = `---
id: x
slug: x
title: x
archived: false
created: "2026-03-15T09:00:00Z"
updated: "2026-03-15T09:00:00Z"
tags: []
---

# x`;
    const project = parseProject(PROJECT_NO_EXT);
    expect(project.externalIds).toEqual([]);
  });

  describe('repositories field', () => {
    const HEADER = `---
id: x
slug: x
title: x
archived: false
created: "2026-03-15T09:00:00Z"
updated: "2026-03-15T09:00:00Z"
tags: []`;

    it('returns [] when the field is absent (backward compat)', () => {
      const project = parseProject(`${HEADER}\n---\n\n# x`);
      expect(project.repositories).toEqual([]);
    });

    it('returns [] for the inline empty form `repositories: []`', () => {
      const project = parseProject(`${HEADER}\nrepositories: []\n---\n\n# x`);
      expect(project.repositories).toEqual([]);
    });

    it('parses the block-list form', () => {
      const project = parseProject(
        `${HEADER}\nrepositories:\n  - /repo/a\n  - /repo/b\n---\n\n# x`,
      );
      expect(project.repositories).toEqual(['/repo/a', '/repo/b']);
    });

    it('preserves paths with spaces (no quoting needed)', () => {
      const project = parseProject(
        `${HEADER}\nrepositories:\n  - /Users/me/has spaces/repo\n---\n\n# x`,
      );
      expect(project.repositories).toEqual(['/Users/me/has spaces/repo']);
    });

    it('strips paired quotes for paths with YAML-special characters', () => {
      const project = parseProject(
        `${HEADER}\nrepositories:\n  - "/Users/me/has: colon/repo"\n---\n\n# x`,
      );
      expect(project.repositories).toEqual(['/Users/me/has: colon/repo']);
    });

    it('does NOT support populated inline-array form (returns [])', () => {
      // parseListField only recognizes inline `[]` (empty) and block-list form.
      // Populated inline form `[a, b]` is unsupported by design.
      const project = parseProject(
        `${HEADER}\nrepositories: [/a, /b]\n---\n\n# x`,
      );
      expect(project.repositories).toEqual([]);
    });
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
  openQuestions: 1
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
    expect(status.needsAttention.openQuestions).toBe(1);
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

  it('defaults archive fields when absent (backward compatible)', () => {
    const assignment = parseAssignmentFull(ASSIGNMENT_WITH_DEPS);
    expect(assignment.archived).toBe(false);
    expect(assignment.archivedAt).toBeNull();
    expect(assignment.archivedReason).toBeNull();
  });

  it('parses archive fields when present', () => {
    const archived = parseAssignmentFull(
      ASSIGNMENT_WITH_DEPS.replace(
        'tags: []\n---',
        'tags: []\narchived: true\narchivedAt: "2026-05-31T12:00:00Z"\narchivedReason: stale\n---',
      ),
    );
    expect(archived.archived).toBe(true);
    expect(archived.archivedAt).toBe('2026-05-31T12:00:00Z');
    expect(archived.archivedReason).toBe('stale');
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

  it('keeps externalIds entries without a url, defaulting url to null', () => {
    const ASSIGNMENT_URL_LESS = `---
id: u-1
slug: link-less
title: Link-less External ID
status: pending
priority: medium
created: "2026-03-15T09:30:00Z"
updated: "2026-03-15T09:30:00Z"
assignee: null
externalIds:
  - system: linear
    id: ENG-7
  - system: jira
    id: PROJ-99
    url: https://jira.example.com/browse/PROJ-99
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

# Link-less External ID`;
    const assignment = parseAssignmentFull(ASSIGNMENT_URL_LESS);
    expect(assignment.externalIds).toHaveLength(2);
    expect(assignment.externalIds[0]).toEqual({
      system: 'linear',
      id: 'ENG-7',
      url: null,
    });
    expect(assignment.externalIds[1]).toEqual({
      system: 'jira',
      id: 'PROJ-99',
      url: 'https://jira.example.com/browse/PROJ-99',
    });
  });

  it('normalizes explicit null, empty, tilde, and quoted url scalars', () => {
    const ASSIGNMENT_QUIRKY_URLS = `---
id: u-2
slug: quirky-urls
title: Quirky URLs
status: pending
priority: medium
created: "2026-03-15T09:30:00Z"
updated: "2026-03-15T09:30:00Z"
assignee: null
externalIds:
  - system: jira
    id: A-1
    url: null
  - system: jira
    id: A-2
    url: ""
  - system: jira
    id: A-3
    url: "https://example.com/A-3"
  - system: jira
    id: A-4
    url: ~
  - system: jira
    id: A-5
    url:
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

# Quirky URLs`;
    const assignment = parseAssignmentFull(ASSIGNMENT_QUIRKY_URLS);
    expect(assignment.externalIds).toHaveLength(5);
    expect(assignment.externalIds[0].url).toBeNull();
    expect(assignment.externalIds[1].url).toBeNull();
    expect(assignment.externalIds[2].url).toBe('https://example.com/A-3');
    expect(assignment.externalIds[3].url).toBeNull();
    expect(assignment.externalIds[4].url).toBeNull();
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

describe('renderMemoryStub / renderResourceStub round-trip', () => {
  it('renderMemoryStub round-trips through parseMemory', async () => {
    const { renderMemoryStub } = await import('../templates/index-stubs.js');
    const stub = renderMemoryStub({
      slug: 'test-slug',
      name: 'Test Memory',
      projectSlug: 'sample-project',
      timestamp: '2026-05-08T13:00:00Z',
    });
    const m = parseMemory(stub);
    expect(m.name).toBe('Test Memory');
    expect(m.source).toBe('claude');
    expect(m.scope).toBe('project');
    expect(m.sourceAssignment).toBeNull();
    expect(m.relatedAssignments).toEqual([]);
    expect(m.tags).toEqual([]);
    expect(m.created).toBe('2026-05-08T13:00:00Z');
    expect(m.updated).toBe('2026-05-08T13:00:00Z');
  });

  it('renderResourceStub round-trips through parseResource', async () => {
    const { renderResourceStub } = await import('../templates/index-stubs.js');
    const stub = renderResourceStub({
      slug: 'test-slug',
      name: 'Test Resource',
      projectSlug: 'sample-project',
      timestamp: '2026-05-08T13:00:00Z',
    });
    const r = parseResource(stub);
    expect(r.name).toBe('Test Resource');
    expect(r.source).toBe('claude');
    expect(r.category).toBe('documentation');
    expect(r.relatedAssignments).toEqual([]);
    expect(r.created).toBe('2026-05-08T13:00:00Z');
    expect(r.updated).toBe('2026-05-08T13:00:00Z');
  });

  it('renderMemoryStub round-trips a colon-bearing name', async () => {
    const { renderMemoryStub } = await import('../templates/index-stubs.js');
    const stub = renderMemoryStub({
      slug: 'tricky',
      name: 'Memory: with colon and ampersand & special',
      projectSlug: 'sample-project',
      timestamp: '2026-05-08T13:00:00Z',
    });
    const m = parseMemory(stub);
    expect(m.name).toBe('Memory: with colon and ampersand & special');
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

describe('parseAssignmentFull — statusHistory parity', () => {
  // Same fixture parsed by both the dashboard parser and the lifecycle parser
  // must yield identical statusHistory (the two parsers are independent copies).
  const HISTORY_BLOCK = `statusHistory:
  - at: "2026-03-18T10:00:00Z"
    from: null
    to: draft
    command: create
    by: null
  - at: "2026-03-18T11:00:00Z"
    from: draft
    to: blocked
    command: block
    by: claude-1
    reason: waiting on API`;

  function fixture(historyPlacement: 'middle' | 'last'): string {
    const head = `---
id: p-1
slug: parity
title: "Parity"
status: blocked
priority: medium
created: "2026-03-18T10:00:00Z"
updated: "2026-03-18T11:00:00Z"
assignee: claude-1
externalIds: []`;
    const tail = `dependsOn: []
links: []
blockedReason: waiting on API
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []`;
    const fm =
      historyPlacement === 'last'
        ? `${head}\n${tail}\n${HISTORY_BLOCK}`
        : `${head}\n${HISTORY_BLOCK}\n${tail}`;
    return `${fm}\n---\n\n# Parity\n`;
  }

  it('matches the lifecycle parser (statusHistory in the middle)', async () => {
    const { parseAssignmentFrontmatter } = await import('../lifecycle/frontmatter.js');
    const content = fixture('middle');
    expect(parseAssignmentFull(content).statusHistory).toEqual(
      parseAssignmentFrontmatter(content).statusHistory,
    );
    expect(parseAssignmentFull(content).statusHistory).toHaveLength(2);
  });

  it('matches the lifecycle parser when statusHistory is the LAST key (EOF-safe)', async () => {
    const { parseAssignmentFrontmatter } = await import('../lifecycle/frontmatter.js');
    const content = fixture('last');
    const dashboard = parseAssignmentFull(content).statusHistory;
    const lifecycle = parseAssignmentFrontmatter(content).statusHistory;
    expect(dashboard).toEqual(lifecycle);
    expect(dashboard).toHaveLength(2);
    expect(dashboard[1]).toMatchObject({ to: 'blocked', command: 'block', reason: 'waiting on API' });
  });

  it('returns [] when statusHistory is absent or inline empty', () => {
    const base = fixture('middle').replace(HISTORY_BLOCK, 'statusHistory: []');
    expect(parseAssignmentFull(base).statusHistory).toEqual([]);
  });
});
