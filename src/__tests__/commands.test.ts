import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createMissionCommand } from '../commands/create-mission.js';
import { createAssignmentCommand } from '../commands/create-assignment.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('createMissionCommand', () => {
  it('creates all expected mission files', async () => {
    const slug = await createMissionCommand('Test Mission', {
      dir: testDir,
    });
    expect(slug).toBe('test-mission');

    const missionDir = resolve(testDir, 'test-mission');
    const files = await readdir(missionDir);

    expect(files).toContain('manifest.md');
    expect(files).toContain('mission.md');
    expect(files).toContain('agent.md');
    expect(files).toContain('claude.md');
    expect(files).toContain('_index-assignments.md');
    expect(files).toContain('_index-plans.md');
    expect(files).toContain('_index-decisions.md');
    expect(files).toContain('_status.md');
    expect(files).toContain('assignments');
    expect(files).toContain('resources');
    expect(files).toContain('memories');
  });

  it('creates resource and memory index stubs', async () => {
    await createMissionCommand('Test', { dir: testDir });
    const missionDir = resolve(testDir, 'test');

    const resourceIndex = await readFile(
      resolve(missionDir, 'resources', '_index.md'),
      'utf-8',
    );
    expect(resourceIndex).toContain('mission: test');
    expect(resourceIndex).toContain('total: 0');

    const memoryIndex = await readFile(
      resolve(missionDir, 'memories', '_index.md'),
      'utf-8',
    );
    expect(memoryIndex).toContain('mission: test');
    expect(memoryIndex).toContain('total: 0');
  });

  it('slug in mission.md matches folder name', async () => {
    await createMissionCommand('My Great Mission', { dir: testDir });
    const content = await readFile(
      resolve(testDir, 'my-great-mission', 'mission.md'),
      'utf-8',
    );
    expect(content).toContain('slug: my-great-mission');
  });

  it('uses custom slug when provided', async () => {
    const slug = await createMissionCommand('Test', {
      slug: 'custom-slug',
      dir: testDir,
    });
    expect(slug).toBe('custom-slug');
    const files = await readdir(resolve(testDir, 'custom-slug'));
    expect(files).toContain('mission.md');
  });

  it('throws if mission folder already exists', async () => {
    await createMissionCommand('Test', { dir: testDir });
    await expect(
      createMissionCommand('Test', { dir: testDir }),
    ).rejects.toThrow('already exists');
  });

  it('throws on empty title', async () => {
    await expect(
      createMissionCommand('', { dir: testDir }),
    ).rejects.toThrow('cannot be empty');
  });
});

describe('createAssignmentCommand', () => {
  it('creates all expected assignment files via --one-off', async () => {
    await createAssignmentCommand('Write Tests', {
      oneOff: true,
      dir: testDir,
    });

    const assignmentDir = resolve(
      testDir,
      'write-tests',
      'assignments',
      'write-tests',
    );
    const files = await readdir(assignmentDir);
    expect(files).toContain('assignment.md');
    expect(files).not.toContain('plan.md');
    expect(files).toContain('scratchpad.md');
    expect(files).toContain('handoff.md');
    expect(files).toContain('decision-record.md');
    expect(files.length).toBe(4);

    const content = await readFile(
      resolve(assignmentDir, 'assignment.md'),
      'utf-8',
    );
    expect(content).toContain('slug: write-tests');
    expect(content).toContain('status: pending');
    expect(content).toContain('priority: medium');
    expect(content).toContain('assignee: null');
  });

  it('creates assignment with --mission in specified dir', async () => {
    await createMissionCommand('Test Mission', { dir: testDir });

    await createAssignmentCommand('My Task', {
      mission: 'test-mission',
      dir: testDir,
      priority: 'high',
      dependsOn: 'dep-one,dep-two',
    });

    const assignmentDir = resolve(
      testDir,
      'test-mission',
      'assignments',
      'my-task',
    );
    const content = await readFile(
      resolve(assignmentDir, 'assignment.md'),
      'utf-8',
    );
    expect(content).toContain('status: pending');
    expect(content).toContain('priority: high');
    expect(content).toContain('dependsOn:');
    expect(content).toContain('  - dep-one');
    expect(content).toContain('  - dep-two');
  });

  it('throws without --mission or --one-off', async () => {
    await expect(
      createAssignmentCommand('Test', {}),
    ).rejects.toThrow('Either --mission');
  });

  it('throws with both --mission and --one-off', async () => {
    await expect(
      createAssignmentCommand('Test', {
        mission: 'some-mission',
        oneOff: true,
      }),
    ).rejects.toThrow('Cannot use both');
  });

  it('throws on empty title', async () => {
    await expect(
      createAssignmentCommand('', { mission: 'test' }),
    ).rejects.toThrow('cannot be empty');
  });

  it('throws on invalid mission slug', async () => {
    await expect(
      createAssignmentCommand('Test', {
        mission: 'INVALID SLUG!',
        dir: testDir,
      }),
    ).rejects.toThrow('Invalid mission slug');
  });

  it('throws on invalid dependency slug', async () => {
    await createMissionCommand('Test', { dir: testDir });
    await expect(
      createAssignmentCommand('Task', {
        mission: 'test',
        dir: testDir,
        dependsOn: 'valid-dep,INVALID!',
      }),
    ).rejects.toThrow('Invalid dependency slug');
  });
});
