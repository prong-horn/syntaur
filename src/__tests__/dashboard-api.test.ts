import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  listProjects,
  listAssignmentsBoard,
  getProjectDetail,
  getAssignmentDetail,
  getOverview,
  getAttention,
  getEditableDocument,
  getHelp,
} from '../dashboard/api.js';
import { createAgentSessionsRouter } from '../dashboard/api-agent-sessions.js';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function createProjectFiles(
  projectsDir: string,
  projectSlug: string,
  projectMd: string,
  assignments: Array<{
    slug: string;
    assignmentMd: string;
    planMd?: string;
    scratchpadMd?: string;
    handoffMd?: string;
    decisionMd?: string;
    progressMd?: string;
    commentsMd?: string;
  }> = [],
  statusMd?: string,
): Promise<void> {
  const projectPath = resolve(projectsDir, projectSlug);
  await mkdir(projectPath, { recursive: true });
  await writeFile(resolve(projectPath, 'project.md'), projectMd, 'utf-8');

  if (statusMd) {
    await writeFile(resolve(projectPath, '_status.md'), statusMd, 'utf-8');
  }

  for (const assignment of assignments) {
    const assignmentDir = resolve(projectPath, 'assignments', assignment.slug);
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(resolve(assignmentDir, 'assignment.md'), assignment.assignmentMd, 'utf-8');

    if (assignment.planMd) {
      await writeFile(resolve(assignmentDir, 'plan.md'), assignment.planMd, 'utf-8');
    }
    if (assignment.scratchpadMd) {
      await writeFile(resolve(assignmentDir, 'scratchpad.md'), assignment.scratchpadMd, 'utf-8');
    }
    if (assignment.handoffMd) {
      await writeFile(resolve(assignmentDir, 'handoff.md'), assignment.handoffMd, 'utf-8');
    }
    if (assignment.decisionMd) {
      await writeFile(resolve(assignmentDir, 'decision-record.md'), assignment.decisionMd, 'utf-8');
    }
    if (assignment.progressMd) {
      await writeFile(resolve(assignmentDir, 'progress.md'), assignment.progressMd, 'utf-8');
    }
    if (assignment.commentsMd) {
      await writeFile(resolve(assignmentDir, 'comments.md'), assignment.commentsMd, 'utf-8');
    }
  }
}

const COMMENTS_MD_ONE_OPEN_QUESTION = `---
assignment: test-assignment
entryCount: 1
generated: "2026-04-07T10:00:00Z"
updated: "2026-04-07T10:00:00Z"
---

# Comments

## q-1

**Recorded:** 2026-04-07T10:00:00Z
**Author:** codex-1
**Type:** question
**Resolved:** false

Waiting on approval?
`;

const PROJECT_MD = `---
id: test-123
slug: test-project
title: Test Project
archived: false
archivedAt: null
archivedReason: null
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
tags: []
---

# Test Project`;

// Use a recent date so this assignment is never stale (within the 7-day window)
const RECENT_DATE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

const ASSIGNMENT_MD = `---
id: a-123
slug: test-assignment
title: Test Assignment
status: in_progress
priority: high
created: "2026-03-20T10:00:00Z"
updated: "${RECENT_DATE}"
assignee: codex-1
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Test Assignment

## Questions & Answers

### Q: Waiting on approval?
**A:** pending`;

const BLOCKED_ASSIGNMENT_MD = `---
id: a-456
slug: blocked-assignment
title: Blocked Assignment
status: blocked
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-10T10:00:00Z"
assignee: codex-2
externalIds: []
dependsOn: []
blockedReason: Waiting on API credentials
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Blocked Assignment`;

const PLAN_MD = `---
assignment: test-assignment
status: in_progress
created: "2026-03-20T10:00:00Z"
updated: "${RECENT_DATE}"
---

# Plan

- [ ] Do something`;

const SCRATCHPAD_MD = `---
assignment: test-assignment
updated: "2026-04-07T11:00:00Z"
---

# Scratchpad

Some notes`;

const HANDOFF_MD = `---
assignment: test-assignment
updated: "2026-04-07T12:00:00Z"
handoffCount: 1
---

# Handoff Log

## Handoff 1

Initial handoff`;

const DECISION_MD = `---
assignment: test-assignment
updated: "2026-04-07T13:00:00Z"
decisionCount: 1
---

# Decision Record

## Decision 1

Keep it simple`;

describe('listProjects', () => {
  it('returns empty array for a missing directory', async () => {
    const result = await listProjects(resolve(testDir, 'missing'));
    expect(result).toEqual([]);
  });

  it('uses source-first assignment state even when _status.md disagrees', async () => {
    const statusMd = `---
project: test-project
generated: "2026-03-20T10:00:00Z"
status: completed
progress:
  total: 1
  completed: 1
  in_progress: 0
  blocked: 0
  pending: 0
  review: 0
  failed: 0
needsAttention:
  blockedCount: 0
  failedCount: 0
  openQuestions: 0
---

# Status`;

    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      {
        slug: 'test-assignment',
        assignmentMd: ASSIGNMENT_MD,
        commentsMd: COMMENTS_MD_ONE_OPEN_QUESTION,
      },
    ], statusMd);

    const result = await listProjects(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('active');
    expect(result[0].progress.in_progress).toBe(1);
    expect(result[0].needsAttention.openQuestions).toBe(1);
  });
});

describe('getProjectDetail', () => {
  it('returns null for a missing project', async () => {
    const result = await getProjectDetail(testDir, 'missing');
    expect(result).toBeNull();
  });

  it('returns project detail with source-first assignments and derived graph fallback', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'test-assignment', assignmentMd: ASSIGNMENT_MD },
    ]);

    const result = await getProjectDetail(testDir, 'test-project');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('active');
    expect(result!.assignments[0].slug).toBe('test-assignment');
    expect(result!.dependencyGraph).toBeNull();
  });
});

describe('getAssignmentDetail', () => {
  it('returns null for a missing assignment', async () => {
    const result = await getAssignmentDetail(testDir, 'test-project', 'missing');
    expect(result).toBeNull();
  });

  it('returns assignment detail with companion document metadata and transitions', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      {
        slug: 'test-assignment',
        assignmentMd: ASSIGNMENT_MD,
        planMd: PLAN_MD,
        scratchpadMd: SCRATCHPAD_MD,
        handoffMd: HANDOFF_MD,
        decisionMd: DECISION_MD,
      },
    ]);

    const result = await getAssignmentDetail(testDir, 'test-project', 'test-assignment');
    expect(result).not.toBeNull();
    expect(result!.plan?.status).toBe('in_progress');
    expect(result!.scratchpad?.updated).toBe('2026-04-07T11:00:00Z');
    expect(result!.handoff?.handoffCount).toBe(1);
    expect(result!.decisionRecord?.decisionCount).toBe(1);
    expect(result!.availableTransitions.map((action) => action.command)).toContain('review');
  });

  it('attaches progress and comments when the files exist', async () => {
    const progressMd = `---
assignment: test-assignment
entryCount: 2
generated: "2026-04-07T10:00:00Z"
updated: "2026-04-07T14:00:00Z"
---

# Progress

## 2026-04-07T14:00:00Z

Second entry.

## 2026-04-07T12:00:00Z

First entry.
`;

    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      {
        slug: 'test-assignment',
        assignmentMd: ASSIGNMENT_MD,
        progressMd,
        commentsMd: COMMENTS_MD_ONE_OPEN_QUESTION,
      },
    ]);

    const result = await getAssignmentDetail(testDir, 'test-project', 'test-assignment');
    expect(result).not.toBeNull();
    expect(result!.progress).not.toBeNull();
    expect(result!.progress!.entryCount).toBe(2);
    expect(result!.progress!.entries).toHaveLength(2);
    expect(result!.progress!.entries[0].timestamp).toBe('2026-04-07T14:00:00Z');
    expect(result!.comments).not.toBeNull();
    expect(result!.comments!.entries[0].type).toBe('question');
    expect(result!.comments!.entries[0].resolved).toBe(false);
  });

  it('leaves progress and comments null when the files are absent', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'test-assignment', assignmentMd: ASSIGNMENT_MD },
    ]);
    const result = await getAssignmentDetail(testDir, 'test-project', 'test-assignment');
    expect(result).not.toBeNull();
    expect(result!.progress).toBeNull();
    expect(result!.comments).toBeNull();
  });
});

describe('listAssignmentsBoard standalone support', () => {
  it('includes standalone assignments with projectSlug: null', async () => {
    const { getAssignmentDetailById, listAssignmentsBoard } = await import('../dashboard/api.js');
    const assignmentsDir = resolve(testDir, 'standalone');
    await mkdir(assignmentsDir, { recursive: true });
    const uuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
    const dir = resolve(assignmentsDir, uuid);
    await mkdir(dir, { recursive: true });
    await writeFile(
      resolve(dir, 'assignment.md'),
      `---
id: ${uuid}
slug: my-standalone
title: My Standalone
project: null
type: feature
status: pending
priority: medium
created: "2026-04-20T10:00:00Z"
updated: "2026-04-20T10:00:00Z"
assignee: null
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# My Standalone`,
      'utf-8',
    );

    const board = await listAssignmentsBoard(testDir, assignmentsDir);
    const item = board.assignments.find((a) => a.id === uuid);
    expect(item).toBeTruthy();
    expect(item!.projectSlug).toBeNull();
    expect(item!.projectTitle).toBeNull();
    expect(item!.projectWorkspace).toBeNull();
    expect(item!.slug).toBe('my-standalone');

    const detail = await getAssignmentDetailById(testDir, assignmentsDir, uuid);
    expect(detail).not.toBeNull();
    expect(detail!.projectSlug).toBeNull();
    expect(detail!.dependsOn).toEqual([]);
  });

  it('returns null from getAssignmentDetailById for an unknown id', async () => {
    const { getAssignmentDetailById } = await import('../dashboard/api.js');
    const assignmentsDir = resolve(testDir, 'standalone');
    await mkdir(assignmentsDir, { recursive: true });
    const detail = await getAssignmentDetailById(testDir, assignmentsDir, 'no-such-id');
    expect(detail).toBeNull();
  });

  it('surfaces standalone workspaceGroup as projectWorkspace on the board item', async () => {
    const assignmentsDir = resolve(testDir, 'standalone');
    await mkdir(assignmentsDir, { recursive: true });
    const uuid = 'cccccccc-1111-2222-3333-dddddddddddd';
    const dir = resolve(assignmentsDir, uuid);
    await mkdir(dir, { recursive: true });
    await writeFile(
      resolve(dir, 'assignment.md'),
      `---
id: ${uuid}
slug: workspace-scoped
title: Workspace Scoped Standalone
project: null
workspaceGroup: syntaur
type: feature
status: pending
priority: medium
created: "2026-04-22T10:00:00Z"
updated: "2026-04-22T10:00:00Z"
assignee: null
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Workspace Scoped Standalone`,
      'utf-8',
    );

    const board = await listAssignmentsBoard(testDir, assignmentsDir);
    const item = board.assignments.find((a) => a.id === uuid);
    expect(item).toBeTruthy();
    expect(item!.projectWorkspace).toBe('syntaur');
  });
});

describe('listWorkspaces standalone discovery', () => {
  async function writeStandalone(
    assignmentsDir: string,
    uuid: string,
    workspaceGroup: string | null,
  ): Promise<void> {
    const dir = resolve(assignmentsDir, uuid);
    await mkdir(dir, { recursive: true });
    const wsLine = workspaceGroup ? `\nworkspaceGroup: ${workspaceGroup}` : '';
    await writeFile(
      resolve(dir, 'assignment.md'),
      `---
id: ${uuid}
slug: example
title: Example
project: null${wsLine}
type: feature
status: pending
priority: medium
created: "2026-04-22T10:00:00Z"
updated: "2026-04-22T10:00:00Z"
assignee: null
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Example`,
      'utf-8',
    );
  }

  it('includes standalone workspaceGroup values when no projects use that workspace', async () => {
    const { listWorkspaces } = await import('../dashboard/api.js');
    const assignmentsDir = resolve(testDir, 'standalone');
    await mkdir(assignmentsDir, { recursive: true });
    await writeStandalone(
      assignmentsDir,
      'eeeeeeee-1111-2222-3333-ffffffffffff',
      'syntaur',
    );

    const result = await listWorkspaces(testDir, assignmentsDir);
    expect(result.workspaces).toContain('syntaur');
  });

  it('sets hasUngrouped: true when a standalone has no workspaceGroup', async () => {
    const { listWorkspaces } = await import('../dashboard/api.js');
    const assignmentsDir = resolve(testDir, 'standalone');
    await mkdir(assignmentsDir, { recursive: true });
    await writeStandalone(
      assignmentsDir,
      'ffffffff-1111-2222-3333-000000000000',
      null,
    );

    const result = await listWorkspaces(testDir, assignmentsDir);
    expect(result.hasUngrouped).toBe(true);
  });

  it('locks in the workspace filter contract: items with projectWorkspace === slug or === null', async () => {
    // Fixture: (a) workspace-scoped standalone, (b) project-nested in syntaur workspace, (c) ungrouped standalone.
    const assignmentsDir = resolve(testDir, 'standalone');
    await mkdir(assignmentsDir, { recursive: true });
    const wsScopedId = '11111111-aaaa-bbbb-cccc-222222222222';
    const ungroupedId = '33333333-aaaa-bbbb-cccc-444444444444';
    await writeStandalone(assignmentsDir, wsScopedId, 'syntaur');
    await writeStandalone(assignmentsDir, ungroupedId, null);

    await createProjectFiles(
      testDir,
      'nested-proj',
      `---
id: aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa
slug: nested-proj
title: Nested Project
archived: false
archivedAt: null
archivedReason: null
created: "2026-04-22T10:00:00Z"
updated: "2026-04-22T10:00:00Z"
externalIds: []
tags: []
workspace: syntaur
---

# Nested Project`,
      [
        {
          slug: 'nested-task',
          assignmentMd: `---
id: bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb
slug: nested-task
title: Nested Task
project: nested-proj
type: feature
status: pending
priority: medium
created: "2026-04-22T10:00:00Z"
updated: "2026-04-22T10:00:00Z"
assignee: null
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Nested Task`,
        },
      ],
    );

    const board = await listAssignmentsBoard(testDir, assignmentsDir);

    const inSyntaur = board.assignments.filter((a) => a.projectWorkspace === 'syntaur');
    const inSyntaurIds = new Set(inSyntaur.map((a) => a.id));
    expect(inSyntaurIds.has(wsScopedId)).toBe(true);
    expect(inSyntaurIds.has('bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb')).toBe(true);
    expect(inSyntaurIds.has(ungroupedId)).toBe(false);

    const ungrouped = board.assignments.filter((a) => a.projectWorkspace === null);
    const ungroupedIds = new Set(ungrouped.map((a) => a.id));
    expect(ungroupedIds.has(ungroupedId)).toBe(true);
    expect(ungroupedIds.has(wsScopedId)).toBe(false);
  });
});

describe('referencedBy backlinks', () => {
  it('lists A under B.referencedBy when A links to B via relative path in its comments', async () => {
    const { getAssignmentDetail } = await import('../dashboard/api.js');
    const commentsWithLink = `---
assignment: source-a
entryCount: 1
generated: "2026-04-20T10:00:00Z"
updated: "2026-04-20T10:00:00Z"
---

# Comments

## c-1

**Recorded:** 2026-04-20T10:00:00Z
**Author:** claude-1
**Type:** note

See [target](../target-b/assignment.md) for context.
`;

    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      {
        slug: 'source-a',
        assignmentMd: ASSIGNMENT_MD.replace('slug: test-assignment', 'slug: source-a').replace('id: a-123', 'id: a-111'),
        commentsMd: commentsWithLink,
      },
      {
        slug: 'target-b',
        assignmentMd: ASSIGNMENT_MD.replace('slug: test-assignment', 'slug: target-b').replace('id: a-123', 'id: a-222'),
      },
    ]);

    const detail = await getAssignmentDetail(testDir, 'test-project', 'target-b');
    expect(detail).not.toBeNull();
    const refs = detail!.referencedBy;
    const ref = refs.find((r) => r.sourceSlug === 'source-a');
    expect(ref).toBeTruthy();
    expect(ref!.mentions).toBeGreaterThanOrEqual(1);
    expect(ref!.sourceProjectSlug).toBe('test-project');
  });

  it('caps referencedBy at 50 entries', async () => {
    const { getAssignmentDetail } = await import('../dashboard/api.js');
    const target: Array<{ slug: string; assignmentMd: string; commentsMd?: string }> = [
      {
        slug: 'target',
        assignmentMd: ASSIGNMENT_MD.replace('slug: test-assignment', 'slug: target').replace('id: a-123', 'id: t-id'),
      },
    ];
    for (let i = 0; i < 60; i++) {
      target.push({
        slug: `src-${i}`,
        assignmentMd: ASSIGNMENT_MD.replace('slug: test-assignment', `slug: src-${i}`).replace('id: a-123', `id: src-${i}`),
        commentsMd: `---
assignment: src-${i}
entryCount: 1
generated: "2026-04-20T10:00:00Z"
updated: "2026-04-20T10:00:00Z"
---

# Comments

## c-1

**Recorded:** 2026-04-20T10:00:00Z
**Author:** a
**Type:** note

link: [t](../target/assignment.md)
`,
      });
    }
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, target);

    const detail = await getAssignmentDetail(testDir, 'test-project', 'target');
    expect(detail!.referencedBy.length).toBe(50);
  });
});

describe('listAssignmentsBoard', () => {
  it('returns assignments from every project with project context and transitions', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'test-assignment', assignmentMd: ASSIGNMENT_MD },
    ]);
    await createProjectFiles(testDir, 'second-project', `---
id: project-2
slug: second-project
title: Second Project
archived: false
archivedAt: null
archivedReason: null
created: "2026-03-19T10:00:00Z"
updated: "2026-03-19T10:00:00Z"
tags: []
---

# Second Project`, [
      { slug: 'blocked-assignment', assignmentMd: BLOCKED_ASSIGNMENT_MD },
    ]);

    const result = await listAssignmentsBoard(testDir);

    expect(result.assignments).toHaveLength(2);
    expect(result.assignments.map((assignment) => assignment.projectSlug).sort()).toEqual([
      'second-project',
      'test-project',
    ]);
    expect(result.assignments.find((assignment) => assignment.slug === 'blocked-assignment'))
      .toMatchObject({
        projectTitle: 'Second Project',
        blockedReason: 'Waiting on API credentials',
        status: 'blocked',
      });
    expect(
      result.assignments.find((assignment) => assignment.slug === 'test-assignment')
        ?.availableTransitions.map((action) => action.command),
    ).toContain('review');
  });
});

describe('overview and attention', () => {
  it('returns first-run onboarding state for an empty workspace', async () => {
    const result = await getOverview(testDir);
    expect(result.firstRun).toBe(true);
    expect(result.stats.activeProjects).toBe(0);
    expect(result.attention).toHaveLength(0);
  });

  it('builds overview stats, recent activity, and attention items from source files', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'test-assignment', assignmentMd: ASSIGNMENT_MD, planMd: PLAN_MD },
      { slug: 'blocked-assignment', assignmentMd: BLOCKED_ASSIGNMENT_MD },
    ]);

    const overview = await getOverview(testDir);
    const attention = await getAttention(testDir);

    expect(overview.firstRun).toBe(false);
    expect(overview.stats.activeProjects).toBe(1);
    expect(overview.stats.inProgressAssignments).toBe(1);
    expect(overview.stats.blockedAssignments).toBe(1);
    expect(overview.stats.staleAssignments).toBe(1);
    expect(overview.recentActivity[0].href).toContain('/projects/test-project');

    expect(attention.items[0].severity).toBe('high');
    expect(attention.items.some((item) => item.reason.includes('7 days'))).toBe(true);
  });
});

describe('help and editable documents', () => {
  it('returns the structured help model with only implemented commands', async () => {
    const help = await getHelp();
    const commandNames = help.commands.map((command) => command.command);

    expect(commandNames).toContain('syntaur dashboard');
    expect(commandNames).toContain('syntaur create-project');
    expect(commandNames).not.toContain('syntaur rebuild');
    expect(help.coreConcepts.some((concept) => concept.term === 'Project')).toBe(true);
  });

  it('returns editable document payloads for project and assignment files', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'test-assignment', assignmentMd: ASSIGNMENT_MD },
    ]);

    const projectDoc = await getEditableDocument(testDir, 'project', 'test-project');
    const assignmentDoc = await getEditableDocument(
      testDir,
      'assignment',
      'test-project',
      'test-assignment',
    );

    expect(projectDoc?.documentType).toBe('project');
    expect(projectDoc?.content).toContain('Test Project');
    expect(assignmentDoc?.documentType).toBe('assignment');
    expect(assignmentDoc?.content).toContain('Test Assignment');
  });
});


describe('POST /api/agent-sessions', () => {
  let server: Server;
  let port: number;
  let dbDir: string;

  beforeEach(async () => {
    resetSessionDb();
    dbDir = await mkdtemp(join(tmpdir(), 'syntaur-apidb-'));
    initSessionDb(resolve(dbDir, 'syntaur.db'));

    const app = express();
    app.use(express.json());
    app.use('/api/agent-sessions', createAgentSessionsRouter(dbDir));

    await new Promise<void>((ready) => {
      server = app.listen(0, () => ready());
    });
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    closeSessionDb();
    await rm(dbDir, { recursive: true, force: true });
  });

  it('returns 400 when sessionId is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'claude' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/sessionId/);
  });

  it('returns 400 when agent is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'abc' }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts sessionId + transcriptPath and returns 201', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude',
        sessionId: 'real-id-123',
        transcriptPath: '/tmp/transcript.jsonl',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sessionId).toBe('real-id-123');

    const listRes = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`);
    const listBody = await listRes.json();
    expect(listBody.sessions).toHaveLength(1);
    expect(listBody.sessions[0].sessionId).toBe('real-id-123');
    expect(listBody.sessions[0].transcriptPath).toBe('/tmp/transcript.jsonl');
  });

  it('re-registering without path does not clobber the existing stored path', async () => {
    // First registration carries a real path.
    await fetch(`http://127.0.0.1:${port}/api/agent-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude',
        sessionId: 'sid-upsert',
        path: '/real/cwd',
      }),
    });

    // Second registration omits path (SessionStart hook case).
    const res2 = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude',
        sessionId: 'sid-upsert',
        transcriptPath: '/tmp/transcript.jsonl',
      }),
    });
    expect(res2.status).toBe(201);

    const listRes = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`);
    const listBody = await listRes.json();
    const row = listBody.sessions.find((s: any) => s.sessionId === 'sid-upsert');
    expect(row).toBeTruthy();
    expect(row.path).toBe('/real/cwd'); // preserved, not overwritten with ''
    expect(row.transcriptPath).toBe('/tmp/transcript.jsonl'); // enriched
  });
});
