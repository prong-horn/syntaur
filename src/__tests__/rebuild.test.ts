import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createMissionCommand } from '../commands/create-mission.js';
import { createAssignmentCommand } from '../commands/create-assignment.js';
import { rebuildCommand } from '../commands/rebuild.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-rebuild-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

/**
 * Helper: write file content to a path within the test mission.
 */
async function writeTestFile(
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = resolve(testDir, 'test-mission', relativePath);
  await writeFile(fullPath, content, 'utf-8');
}

describe('rebuildCommand', () => {
  it('rebuilds a mission with assignments, sessions, Q&A, and decisions', async () => {
    // Scaffold the mission and assignments
    await createMissionCommand('Test Mission', { dir: testDir });
    await createAssignmentCommand('First Task', {
      mission: 'test-mission',
      dir: testDir,
      priority: 'high',
    });
    await createAssignmentCommand('Second Task', {
      mission: 'test-mission',
      dir: testDir,
      priority: 'medium',
      dependsOn: 'first-task',
    });

    // Populate first-task as completed with a session and decision
    await writeTestFile(
      'assignments/first-task/assignment.md',
      `---
id: aaaaaaaa-bbbb-cccc-dddd-111111111111
slug: first-task
title: First Task
status: completed
priority: high
created: "2026-03-15T09:00:00Z"
updated: "2026-03-17T10:00:00Z"
assignee: claude-1
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

# First Task

## Objective
Do the first task.

## Sessions

| Session ID | Agent | Started | Ended | Status |
|------------|-------|---------|-------|--------|
| tmux:first-1 | claude-1 | 2026-03-16T09:00:00Z | 2026-03-17T10:00:00Z | completed |

## Questions & Answers

No questions yet.

## Progress

### 2026-03-17T10:00:00Z
Completed the task.
`,
    );

    await writeTestFile(
      'assignments/first-task/plan.md',
      `---
assignment: first-task
status: completed
created: "2026-03-15T09:00:00Z"
updated: "2026-03-17T10:00:00Z"
---

# Plan: First Task
`,
    );

    await writeTestFile(
      'assignments/first-task/decision-record.md',
      `---
assignment: first-task
updated: "2026-03-16T11:00:00Z"
decisionCount: 1
---

# Decision Record

## Decision 1: Use approach A

**Date:** 2026-03-16T11:00:00Z
**Status:** accepted
**Context:** Needed to decide.
**Decision:** Use approach A.
**Consequences:** Simple.
`,
    );

    // Populate second-task as in_progress with active session and unanswered Q
    await writeTestFile(
      'assignments/second-task/assignment.md',
      `---
id: aaaaaaaa-bbbb-cccc-dddd-222222222222
slug: second-task
title: Second Task
status: in_progress
priority: medium
created: "2026-03-15T09:00:00Z"
updated: "2026-03-18T14:00:00Z"
assignee: claude-2
externalIds: []
dependsOn:
  - first-task
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Second Task

## Objective
Do the second task.

## Sessions

| Session ID | Agent | Started | Ended | Status |
|------------|-------|---------|-------|--------|
| tmux:second-1 | claude-2 | 2026-03-18T10:00:00Z | null | active |

## Questions & Answers

### Q: What approach should I use?
**Asked:** 2026-03-18T11:00:00Z
**A:** pending

## Progress

### 2026-03-18T14:00:00Z
Started working.
`,
    );

    await writeTestFile(
      'assignments/second-task/plan.md',
      `---
assignment: second-task
status: approved
created: "2026-03-15T09:00:00Z"
updated: "2026-03-18T10:00:00Z"
---

# Plan: Second Task
`,
    );

    await writeTestFile(
      'assignments/second-task/decision-record.md',
      `---
assignment: second-task
updated: "2026-03-15T09:00:00Z"
decisionCount: 0
---

# Decision Record

No decisions recorded yet.
`,
    );

    // Add a resource file
    await writeFile(
      resolve(
        testDir,
        'test-mission',
        'resources',
        'test-resource.md',
      ),
      `---
type: resource
name: Test Resource
source: human
category: documentation
sourceUrl: null
sourceAssignment: null
relatedAssignments:
  - first-task
  - second-task
created: "2026-03-15T09:00:00Z"
updated: "2026-03-15T09:00:00Z"
---

# Test Resource

Some resource content.
`,
      'utf-8',
    );

    // Add a memory file
    await writeFile(
      resolve(
        testDir,
        'test-mission',
        'memories',
        'test-memory.md',
      ),
      `---
type: memory
name: Test Memory
source: claude-1
sourceAssignment: first-task
relatedAssignments:
  - second-task
scope: mission
created: "2026-03-17T09:00:00Z"
updated: "2026-03-17T09:00:00Z"
tags:
  - testing
---

# Test Memory

Some memory content.
`,
      'utf-8',
    );

    // Run rebuild
    await rebuildCommand({ mission: 'test-mission', dir: testDir });

    // Verify _index-assignments.md
    const indexAssignments = await readFile(
      resolve(testDir, 'test-mission', '_index-assignments.md'),
      'utf-8',
    );
    expect(indexAssignments).toContain('total: 2');
    expect(indexAssignments).toContain('completed: 1');
    expect(indexAssignments).toContain('in_progress: 1');
    expect(indexAssignments).toContain(
      '[first-task](./assignments/first-task/assignment.md)',
    );
    expect(indexAssignments).toContain(
      '[second-task](./assignments/second-task/assignment.md)',
    );

    // Verify _index-plans.md
    const indexPlans = await readFile(
      resolve(testDir, 'test-mission', '_index-plans.md'),
      'utf-8',
    );
    expect(indexPlans).toContain(
      '[first-task](./assignments/first-task/plan.md)',
    );
    expect(indexPlans).toContain('completed');
    expect(indexPlans).toContain(
      '[second-task](./assignments/second-task/plan.md)',
    );
    expect(indexPlans).toContain('approved');

    // Verify _index-decisions.md
    const indexDecisions = await readFile(
      resolve(testDir, 'test-mission', '_index-decisions.md'),
      'utf-8',
    );
    expect(indexDecisions).toContain('Use approach A');
    expect(indexDecisions).toContain('accepted');
    // second-task has 0 decisions — should NOT appear
    expect(indexDecisions).not.toContain(
      '[second-task]',
    );

    // Verify _index-sessions.md
    const indexSessions = await readFile(
      resolve(testDir, 'test-mission', '_index-sessions.md'),
      'utf-8',
    );
    expect(indexSessions).toContain('activeSessions: 1');
    expect(indexSessions).toContain('tmux:second-1');
    expect(indexSessions).toContain('claude-2');
    // Completed session should NOT appear
    expect(indexSessions).not.toContain('tmux:first-1');

    // Verify _status.md
    const statusMd = await readFile(
      resolve(testDir, 'test-mission', '_status.md'),
      'utf-8',
    );
    expect(statusMd).toContain('status: active');
    expect(statusMd).toContain('total: 2');
    expect(statusMd).toContain('completed: 1');
    expect(statusMd).toContain('unansweredQuestions: 1');
    expect(statusMd).toContain('[x]');
    expect(statusMd).toContain('graph TD');
    expect(statusMd).toContain(
      'first-task:::completed --> second-task:::in_progress',
    );
    expect(statusMd).toContain("classDef completed fill:#22c55e");
    expect(statusMd).toContain('1 unanswered');

    // Verify manifest.md
    const manifest = await readFile(
      resolve(testDir, 'test-mission', 'manifest.md'),
      'utf-8',
    );
    expect(manifest).toContain('mission: test-mission');
    expect(manifest).toContain(
      '[Mission Overview](./mission.md)',
    );

    // Verify resources/_index.md
    const resourcesIndex = await readFile(
      resolve(
        testDir,
        'test-mission',
        'resources',
        '_index.md',
      ),
      'utf-8',
    );
    expect(resourcesIndex).toContain('total: 1');
    expect(resourcesIndex).toContain(
      '[test-resource](./test-resource.md)',
    );
    expect(resourcesIndex).toContain('documentation');

    // Verify memories/_index.md
    const memoriesIndex = await readFile(
      resolve(
        testDir,
        'test-mission',
        'memories',
        '_index.md',
      ),
      'utf-8',
    );
    expect(memoriesIndex).toContain('total: 1');
    expect(memoriesIndex).toContain(
      '[test-memory](./test-memory.md)',
    );
    expect(memoriesIndex).toContain('mission');
  });

  it('rebuilds an empty mission (zero assignments)', async () => {
    await createMissionCommand('Empty Mission', {
      dir: testDir,
    });

    await rebuildCommand({
      mission: 'empty-mission',
      dir: testDir,
    });

    const statusMd = await readFile(
      resolve(testDir, 'empty-mission', '_status.md'),
      'utf-8',
    );
    expect(statusMd).toContain('status: pending');
    expect(statusMd).toContain('total: 0');
    expect(statusMd).toContain('No assignments yet.');

    const indexAssignments = await readFile(
      resolve(
        testDir,
        'empty-mission',
        '_index-assignments.md',
      ),
      'utf-8',
    );
    expect(indexAssignments).toContain('total: 0');
  });

  it('rebuilds all missions with --all', async () => {
    await createMissionCommand('Mission One', {
      dir: testDir,
    });
    await createMissionCommand('Mission Two', {
      dir: testDir,
    });

    await rebuildCommand({ all: true, dir: testDir });

    // Both missions should have rebuilt _status.md
    const status1 = await readFile(
      resolve(testDir, 'mission-one', '_status.md'),
      'utf-8',
    );
    expect(status1).toContain('status: pending');

    const status2 = await readFile(
      resolve(testDir, 'mission-two', '_status.md'),
      'utf-8',
    );
    expect(status2).toContain('status: pending');
  });

  it('throws when neither --mission nor --all is provided', async () => {
    await expect(
      rebuildCommand({ dir: testDir }),
    ).rejects.toThrow('Either --mission');
  });

  it('throws when mission does not exist', async () => {
    await expect(
      rebuildCommand({
        mission: 'nonexistent',
        dir: testDir,
      }),
    ).rejects.toThrow('not found');
  });
});
