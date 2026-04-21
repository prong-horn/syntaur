import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
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
  }
}

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
  unansweredQuestions: 0
---

# Status`;

    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'test-assignment', assignmentMd: ASSIGNMENT_MD },
    ], statusMd);

    const result = await listProjects(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('active');
    expect(result[0].progress.in_progress).toBe(1);
    expect(result[0].needsAttention.unansweredQuestions).toBe(1);
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
