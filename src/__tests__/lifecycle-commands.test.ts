import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createMissionCommand } from '../commands/create-mission.js';
import { createAssignmentCommand } from '../commands/create-assignment.js';
import { executeTransition, executeAssign } from '../lifecycle/index.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-lifecycle-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function readAssignmentContent(
  missionSlug: string,
  assignmentSlug: string,
): Promise<string> {
  return readFile(
    resolve(testDir, missionSlug, 'assignments', assignmentSlug, 'assignment.md'),
    'utf-8',
  );
}

describe('lifecycle integration', () => {
  const missionSlug = 'test-mission';

  beforeEach(async () => {
    await createMissionCommand('Test Mission', { dir: testDir });
    await createAssignmentCommand('Task B', {
      mission: missionSlug,
      dir: testDir,
    });
    await createAssignmentCommand('Task A', {
      mission: missionSlug,
      dir: testDir,
      dependsOn: 'task-b',
    });
  });

  it('assign sets assignee without changing status', async () => {
    const missionDir = resolve(testDir, missionSlug);
    const result = await executeAssign(missionDir, 'task-a', 'claude-1');
    expect(result.success).toBe(true);

    const content = await readAssignmentContent(missionSlug, 'task-a');
    expect(content).toContain('assignee: claude-1');
    expect(content).toContain('status: pending');
  });

  it('start succeeds with unmet dependencies but includes warning', async () => {
    const missionDir = resolve(testDir, missionSlug);
    await executeAssign(missionDir, 'task-a', 'claude-1');

    const result = await executeTransition(missionDir, 'task-a', 'start');
    expect(result.success).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain('unmet dependencies');

    const content = await readAssignmentContent(missionSlug, 'task-a');
    expect(content).toContain('status: in_progress');
  });

  it('start succeeds on assignment with no dependencies', async () => {
    const missionDir = resolve(testDir, missionSlug);
    const result = await executeTransition(missionDir, 'task-b', 'start', {
      agent: 'claude-2',
    });
    expect(result.success).toBe(true);

    const content = await readAssignmentContent(missionSlug, 'task-b');
    expect(content).toContain('status: in_progress');
    expect(content).toContain('assignee: claude-2');
  });

  it('full lifecycle: start -> complete dependency, then start -> block -> unblock -> review -> complete dependent', async () => {
    const missionDir = resolve(testDir, missionSlug);

    // Start and complete task-b (no deps)
    await executeTransition(missionDir, 'task-b', 'start', { agent: 'claude-2' });
    await executeTransition(missionDir, 'task-b', 'complete');

    let content = await readAssignmentContent(missionSlug, 'task-b');
    expect(content).toContain('status: completed');

    // Now task-a's dependency is met; assign and start
    await executeAssign(missionDir, 'task-a', 'claude-1');
    const startResult = await executeTransition(missionDir, 'task-a', 'start');
    expect(startResult.success).toBe(true);

    content = await readAssignmentContent(missionSlug, 'task-a');
    expect(content).toContain('status: in_progress');

    // Block task-a
    await executeTransition(missionDir, 'task-a', 'block', { reason: 'Waiting for API key' });
    content = await readAssignmentContent(missionSlug, 'task-a');
    expect(content).toContain('status: blocked');
    expect(content).toContain('blockedReason: Waiting for API key');

    // Unblock task-a
    await executeTransition(missionDir, 'task-a', 'unblock');
    content = await readAssignmentContent(missionSlug, 'task-a');
    expect(content).toContain('status: in_progress');
    expect(content).toContain('blockedReason: null');

    // Review task-a
    await executeTransition(missionDir, 'task-a', 'review');
    content = await readAssignmentContent(missionSlug, 'task-a');
    expect(content).toContain('status: review');

    // Complete task-a
    await executeTransition(missionDir, 'task-a', 'complete');
    content = await readAssignmentContent(missionSlug, 'task-a');
    expect(content).toContain('status: completed');
  });

  it('rejects invalid transitions', async () => {
    const missionDir = resolve(testDir, missionSlug);

    // Cannot complete a pending assignment
    const result1 = await executeTransition(missionDir, 'task-b', 'complete');
    expect(result1.success).toBe(false);
    expect(result1.message).toContain('not allowed');

    // Start and complete task-b, then try to start it again
    await executeTransition(missionDir, 'task-b', 'start', { agent: 'claude-2' });
    await executeTransition(missionDir, 'task-b', 'complete');
    const result2 = await executeTransition(missionDir, 'task-b', 'start');
    expect(result2.success).toBe(false);
    expect(result2.message).toContain('not allowed');
  });

  it('assign succeeds on terminal statuses', async () => {
    const missionDir = resolve(testDir, missionSlug);
    await executeTransition(missionDir, 'task-b', 'start', { agent: 'claude-2' });
    await executeTransition(missionDir, 'task-b', 'complete');

    const result = await executeAssign(missionDir, 'task-b', 'claude-3');
    expect(result.success).toBe(true);

    const content = await readAssignmentContent(missionSlug, 'task-b');
    expect(content).toContain('assignee: claude-3');
  });

  it('start succeeds without assignee', async () => {
    const missionDir = resolve(testDir, missionSlug);
    const result = await executeTransition(missionDir, 'task-b', 'start');
    expect(result.success).toBe(true);

    const content = await readAssignmentContent(missionSlug, 'task-b');
    expect(content).toContain('status: in_progress');
    expect(content).toContain('assignee: null');
  });

  it('reopen returns completed assignment to in_progress', async () => {
    const missionDir = resolve(testDir, missionSlug);
    await executeTransition(missionDir, 'task-b', 'start', { agent: 'claude-2' });
    await executeTransition(missionDir, 'task-b', 'complete');

    const result = await executeTransition(missionDir, 'task-b', 'reopen');
    expect(result.success).toBe(true);
    expect(result.toStatus).toBe('in_progress');

    const content = await readAssignmentContent(missionSlug, 'task-b');
    expect(content).toContain('status: in_progress');
  });

  it('reopen returns failed assignment to in_progress', async () => {
    const missionDir = resolve(testDir, missionSlug);
    await executeTransition(missionDir, 'task-b', 'start', { agent: 'claude-2' });
    await executeTransition(missionDir, 'task-b', 'fail');

    const result = await executeTransition(missionDir, 'task-b', 'reopen');
    expect(result.success).toBe(true);
    expect(result.toStatus).toBe('in_progress');
  });

  it('block succeeds without reason', async () => {
    const missionDir = resolve(testDir, missionSlug);
    await executeTransition(missionDir, 'task-b', 'start', { agent: 'claude-2' });

    const result = await executeTransition(missionDir, 'task-b', 'block');
    expect(result.success).toBe(true);

    const content = await readAssignmentContent(missionSlug, 'task-b');
    expect(content).toContain('status: blocked');
    expect(content).toContain('blockedReason: null');
  });

  it('preserves markdown body through multiple transitions', async () => {
    const missionDir = resolve(testDir, missionSlug);

    await executeTransition(missionDir, 'task-b', 'start', { agent: 'claude-2' });
    await executeTransition(missionDir, 'task-b', 'complete');

    const finalContent = await readAssignmentContent(missionSlug, 'task-b');
    expect(finalContent).toContain('## Objective');
    expect(finalContent).toContain('## Acceptance Criteria');
    expect(finalContent).toContain('## Sessions');
  });
});
