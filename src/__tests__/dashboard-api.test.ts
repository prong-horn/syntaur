import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { listMissions, getMissionDetail, getAssignmentDetail } from '../dashboard/api.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function createMissionFiles(
  missionsDir: string,
  missionSlug: string,
  missionMd: string,
  assignments: Array<{ slug: string; assignmentMd: string; planMd?: string }> = [],
  statusMd?: string,
): Promise<void> {
  const missionPath = resolve(missionsDir, missionSlug);
  await mkdir(missionPath, { recursive: true });
  await writeFile(resolve(missionPath, 'mission.md'), missionMd, 'utf-8');

  if (statusMd) {
    await writeFile(resolve(missionPath, '_status.md'), statusMd, 'utf-8');
  }

  for (const a of assignments) {
    const aDir = resolve(missionPath, 'assignments', a.slug);
    await mkdir(aDir, { recursive: true });
    await writeFile(resolve(aDir, 'assignment.md'), a.assignmentMd, 'utf-8');
    if (a.planMd) {
      await writeFile(resolve(aDir, 'plan.md'), a.planMd, 'utf-8');
    }
  }
}

const MISSION_MD = `---
id: test-123
slug: test-mission
title: Test Mission
archived: false
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
tags: []
---

# Test Mission`;

const ASSIGNMENT_MD = `---
id: a-123
slug: test-assignment
title: Test Assignment
status: in_progress
priority: high
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
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

# Test Assignment`;

const PLAN_MD = `---
assignment: test-assignment
status: in_progress
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
---

# Plan

- [ ] Do something`;

describe('listMissions', () => {
  it('returns empty array for non-existent directory', async () => {
    const result = await listMissions(resolve(testDir, 'nonexistent'));
    expect(result).toEqual([]);
  });

  it('returns empty array for empty directory', async () => {
    const result = await listMissions(testDir);
    expect(result).toEqual([]);
  });

  it('lists missions with computed progress when _status.md is missing', async () => {
    await createMissionFiles(testDir, 'test-mission', MISSION_MD, [
      { slug: 'test-assignment', assignmentMd: ASSIGNMENT_MD },
    ]);

    const result = await listMissions(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('test-mission');
    expect(result[0].title).toBe('Test Mission');
    expect(result[0].progress.total).toBe(1);
    expect(result[0].progress.in_progress).toBe(1);
  });

  it('uses _status.md when available', async () => {
    const statusMd = `---
mission: test-mission
generated: "2026-03-20T10:00:00Z"
status: active
progress:
  total: 2
  completed: 1
  in_progress: 1
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

    await createMissionFiles(testDir, 'test-mission', MISSION_MD, [], statusMd);

    const result = await listMissions(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('active');
    expect(result[0].progress.total).toBe(2);
    expect(result[0].progress.completed).toBe(1);
  });
});

describe('getMissionDetail', () => {
  it('returns null for non-existent mission', async () => {
    const result = await getMissionDetail(testDir, 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns full mission detail with assignments', async () => {
    await createMissionFiles(testDir, 'test-mission', MISSION_MD, [
      { slug: 'test-assignment', assignmentMd: ASSIGNMENT_MD },
    ]);

    const result = await getMissionDetail(testDir, 'test-mission');
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('test-mission');
    expect(result!.assignments).toHaveLength(1);
    expect(result!.assignments[0].slug).toBe('test-assignment');
    expect(result!.assignments[0].status).toBe('in_progress');
  });
});

describe('getAssignmentDetail', () => {
  it('returns null for non-existent assignment', async () => {
    const result = await getAssignmentDetail(testDir, 'test-mission', 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns full assignment detail with plan', async () => {
    await createMissionFiles(testDir, 'test-mission', MISSION_MD, [
      { slug: 'test-assignment', assignmentMd: ASSIGNMENT_MD, planMd: PLAN_MD },
    ]);

    const result = await getAssignmentDetail(testDir, 'test-mission', 'test-assignment');
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('test-assignment');
    expect(result!.status).toBe('in_progress');
    expect(result!.plan).not.toBeNull();
    expect(result!.plan!.status).toBe('in_progress');
    expect(result!.plan!.body).toContain('Do something');
  });

  it('returns null plan when plan.md does not exist', async () => {
    await createMissionFiles(testDir, 'test-mission', MISSION_MD, [
      { slug: 'test-assignment', assignmentMd: ASSIGNMENT_MD },
    ]);

    const result = await getAssignmentDetail(testDir, 'test-mission', 'test-assignment');
    expect(result).not.toBeNull();
    expect(result!.plan).toBeNull();
  });
});
