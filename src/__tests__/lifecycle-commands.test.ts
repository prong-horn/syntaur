import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createProjectCommand } from '../commands/create-project.js';
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
  projectSlug: string,
  assignmentSlug: string,
): Promise<string> {
  return readFile(
    resolve(testDir, projectSlug, 'assignments', assignmentSlug, 'assignment.md'),
    'utf-8',
  );
}

describe('lifecycle integration', () => {
  const projectSlug = 'test-project';

  beforeEach(async () => {
    await createProjectCommand('Test Project', { dir: testDir });
    await createAssignmentCommand('Task B', {
      project: projectSlug,
      dir: testDir,
    });
    await createAssignmentCommand('Task A', {
      project: projectSlug,
      dir: testDir,
      dependsOn: 'task-b',
    });
  });

  it('assign sets assignee without changing status', async () => {
    const projectDir = resolve(testDir, projectSlug);
    const result = await executeAssign(projectDir, 'task-a', 'claude-1');
    expect(result.success).toBe(true);

    const content = await readAssignmentContent(projectSlug, 'task-a');
    expect(content).toContain('assignee: claude-1');
    expect(content).toContain('status: pending');
  });

  it('start succeeds with unmet dependencies but includes warning', async () => {
    const projectDir = resolve(testDir, projectSlug);
    await executeAssign(projectDir, 'task-a', 'claude-1');

    const result = await executeTransition(projectDir, 'task-a', 'start');
    expect(result.success).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain('unmet dependencies');

    const content = await readAssignmentContent(projectSlug, 'task-a');
    expect(content).toContain('status: in_progress');
  });

  it('start succeeds on assignment with no dependencies', async () => {
    const projectDir = resolve(testDir, projectSlug);
    const result = await executeTransition(projectDir, 'task-b', 'start', {
      agent: 'claude-2',
    });
    expect(result.success).toBe(true);

    const content = await readAssignmentContent(projectSlug, 'task-b');
    expect(content).toContain('status: in_progress');
    expect(content).toContain('assignee: claude-2');
  });

  it('full lifecycle: start -> complete dependency, then start -> block -> unblock -> review -> complete dependent', async () => {
    const projectDir = resolve(testDir, projectSlug);

    // Start and complete task-b (no deps)
    await executeTransition(projectDir, 'task-b', 'start', { agent: 'claude-2' });
    await executeTransition(projectDir, 'task-b', 'complete');

    let content = await readAssignmentContent(projectSlug, 'task-b');
    expect(content).toContain('status: completed');

    // Now task-a's dependency is met; assign and start
    await executeAssign(projectDir, 'task-a', 'claude-1');
    const startResult = await executeTransition(projectDir, 'task-a', 'start');
    expect(startResult.success).toBe(true);

    content = await readAssignmentContent(projectSlug, 'task-a');
    expect(content).toContain('status: in_progress');

    // Block task-a
    await executeTransition(projectDir, 'task-a', 'block', { reason: 'Waiting for API key' });
    content = await readAssignmentContent(projectSlug, 'task-a');
    expect(content).toContain('status: blocked');
    expect(content).toContain('blockedReason: Waiting for API key');

    // Unblock task-a
    await executeTransition(projectDir, 'task-a', 'unblock');
    content = await readAssignmentContent(projectSlug, 'task-a');
    expect(content).toContain('status: in_progress');
    expect(content).toContain('blockedReason: null');

    // Review task-a
    await executeTransition(projectDir, 'task-a', 'review');
    content = await readAssignmentContent(projectSlug, 'task-a');
    expect(content).toContain('status: review');

    // Complete task-a
    await executeTransition(projectDir, 'task-a', 'complete');
    content = await readAssignmentContent(projectSlug, 'task-a');
    expect(content).toContain('status: completed');
  });

  it('allows any known command regardless of current status (guards removed)', async () => {
    const projectDir = resolve(testDir, projectSlug);

    // Complete a pending assignment directly — no guard
    const result1 = await executeTransition(projectDir, 'task-b', 'complete');
    expect(result1.success).toBe(true);
    expect(result1.toStatus).toBe('completed');

    // Start a completed assignment — no guard
    const result2 = await executeTransition(projectDir, 'task-b', 'start');
    expect(result2.success).toBe(true);
    expect(result2.toStatus).toBe('in_progress');
  });

  it('rejects unknown commands', async () => {
    const projectDir = resolve(testDir, projectSlug);
    const result = await executeTransition(projectDir, 'task-b', 'nonexistent' as any);
    expect(result.success).toBe(false);
    expect(result.message).toContain('Unknown command');
  });

  it('assign succeeds on terminal statuses', async () => {
    const projectDir = resolve(testDir, projectSlug);
    await executeTransition(projectDir, 'task-b', 'start', { agent: 'claude-2' });
    await executeTransition(projectDir, 'task-b', 'complete');

    const result = await executeAssign(projectDir, 'task-b', 'claude-3');
    expect(result.success).toBe(true);

    const content = await readAssignmentContent(projectSlug, 'task-b');
    expect(content).toContain('assignee: claude-3');
  });

  it('start succeeds without assignee', async () => {
    const projectDir = resolve(testDir, projectSlug);
    const result = await executeTransition(projectDir, 'task-b', 'start');
    expect(result.success).toBe(true);

    const content = await readAssignmentContent(projectSlug, 'task-b');
    expect(content).toContain('status: in_progress');
    expect(content).toContain('assignee: null');
  });

  it('reopen returns completed assignment to in_progress', async () => {
    const projectDir = resolve(testDir, projectSlug);
    await executeTransition(projectDir, 'task-b', 'start', { agent: 'claude-2' });
    await executeTransition(projectDir, 'task-b', 'complete');

    const result = await executeTransition(projectDir, 'task-b', 'reopen');
    expect(result.success).toBe(true);
    expect(result.toStatus).toBe('in_progress');

    const content = await readAssignmentContent(projectSlug, 'task-b');
    expect(content).toContain('status: in_progress');
  });

  it('reopen returns failed assignment to in_progress', async () => {
    const projectDir = resolve(testDir, projectSlug);
    await executeTransition(projectDir, 'task-b', 'start', { agent: 'claude-2' });
    await executeTransition(projectDir, 'task-b', 'fail');

    const result = await executeTransition(projectDir, 'task-b', 'reopen');
    expect(result.success).toBe(true);
    expect(result.toStatus).toBe('in_progress');
  });

  it('block succeeds without reason', async () => {
    const projectDir = resolve(testDir, projectSlug);
    await executeTransition(projectDir, 'task-b', 'start', { agent: 'claude-2' });

    const result = await executeTransition(projectDir, 'task-b', 'block');
    expect(result.success).toBe(true);

    const content = await readAssignmentContent(projectSlug, 'task-b');
    expect(content).toContain('status: blocked');
    expect(content).toContain('blockedReason: null');
  });

  it('preserves markdown body through multiple transitions', async () => {
    const projectDir = resolve(testDir, projectSlug);

    await executeTransition(projectDir, 'task-b', 'start', { agent: 'claude-2' });
    await executeTransition(projectDir, 'task-b', 'complete');

    const finalContent = await readAssignmentContent(projectSlug, 'task-b');
    expect(finalContent).toContain('## Objective');
    expect(finalContent).toContain('## Acceptance Criteria');
  });
});

describe('assignment links', () => {
  const projectSlug = 'test-project';

  beforeEach(async () => {
    await createProjectCommand('Test Project', { dir: testDir });
  });

  it('creates assignment with links in projectSlug/assignmentSlug format', async () => {
    await createAssignmentCommand('Task With Links', {
      project: projectSlug,
      dir: testDir,
      links: 'other-project/task-one,another-project/task-two',
    });

    const content = await readAssignmentContent(projectSlug, 'task-with-links');
    expect(content).toContain('links:');
    expect(content).toContain('  - other-project/task-one');
    expect(content).toContain('  - another-project/task-two');
  });

  it('creates assignment with empty links', async () => {
    await createAssignmentCommand('Task No Links', {
      project: projectSlug,
      dir: testDir,
    });

    const content = await readAssignmentContent(projectSlug, 'task-no-links');
    expect(content).toContain('links: []');
  });

  it('rejects invalid link format (missing slash)', async () => {
    await expect(
      createAssignmentCommand('Bad Links', {
        project: projectSlug,
        dir: testDir,
        links: 'no-slash-here',
      }),
    ).rejects.toThrow('Invalid link');
  });

  it('rejects invalid link format (too many slashes)', async () => {
    await expect(
      createAssignmentCommand('Bad Links', {
        project: projectSlug,
        dir: testDir,
        links: 'too/many/slashes',
      }),
    ).rejects.toThrow('Invalid link');
  });
});
