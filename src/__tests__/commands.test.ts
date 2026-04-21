import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createProjectCommand } from '../commands/create-project.js';
import { createAssignmentCommand } from '../commands/create-assignment.js';

let testDir: string;
let origSyntaurHome: string | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-test-'));
  origSyntaurHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = testDir;
});

afterEach(async () => {
  if (origSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origSyntaurHome;
  await rm(testDir, { recursive: true, force: true });
});

describe('createProjectCommand', () => {
  it('creates all expected project files', async () => {
    const slug = await createProjectCommand('Test Project', {
      dir: testDir,
    });
    expect(slug).toBe('test-project');

    const projectDir = resolve(testDir, 'test-project');
    const files = await readdir(projectDir);

    expect(files).toContain('manifest.md');
    expect(files).toContain('project.md');
    expect(files).not.toContain('agent.md');
    expect(files).not.toContain('claude.md');
    expect(files).toContain('_index-assignments.md');
    expect(files).toContain('_index-plans.md');
    expect(files).toContain('_index-decisions.md');
    expect(files).toContain('_status.md');
    expect(files).toContain('assignments');
    expect(files).toContain('resources');
    expect(files).toContain('memories');
  });

  it('creates resource and memory index stubs', async () => {
    await createProjectCommand('Test', { dir: testDir });
    const projectDir = resolve(testDir, 'test');

    const resourceIndex = await readFile(
      resolve(projectDir, 'resources', '_index.md'),
      'utf-8',
    );
    expect(resourceIndex).toContain('project: test');
    expect(resourceIndex).toContain('total: 0');

    const memoryIndex = await readFile(
      resolve(projectDir, 'memories', '_index.md'),
      'utf-8',
    );
    expect(memoryIndex).toContain('project: test');
    expect(memoryIndex).toContain('total: 0');
  });

  it('slug in project.md matches folder name', async () => {
    await createProjectCommand('My Great Project', { dir: testDir });
    const content = await readFile(
      resolve(testDir, 'my-great-project', 'project.md'),
      'utf-8',
    );
    expect(content).toContain('slug: my-great-project');
  });

  it('uses custom slug when provided', async () => {
    const slug = await createProjectCommand('Test', {
      slug: 'custom-slug',
      dir: testDir,
    });
    expect(slug).toBe('custom-slug');
    const files = await readdir(resolve(testDir, 'custom-slug'));
    expect(files).toContain('project.md');
  });

  it('throws if project folder already exists', async () => {
    await createProjectCommand('Test', { dir: testDir });
    await expect(
      createProjectCommand('Test', { dir: testDir }),
    ).rejects.toThrow('already exists');
  });

  it('throws on empty title', async () => {
    await expect(
      createProjectCommand('', { dir: testDir }),
    ).rejects.toThrow('cannot be empty');
  });
});

describe('createAssignmentCommand', () => {
  it('creates a standalone assignment via --one-off at ~/.syntaur/assignments/<uuid>/', async () => {
    await createAssignmentCommand('Write Tests', {
      oneOff: true,
    });

    const standaloneRoot = resolve(testDir, 'assignments');
    const folders = await readdir(standaloneRoot);
    expect(folders.length).toBe(1);
    const uuid = folders[0];
    const assignmentDir = resolve(standaloneRoot, uuid);

    const files = await readdir(assignmentDir);
    expect(files).toContain('assignment.md');
    expect(files).not.toContain('plan.md');
    expect(files).toContain('scratchpad.md');
    expect(files).toContain('handoff.md');
    expect(files).toContain('decision-record.md');
    expect(files).toContain('progress.md');
    expect(files).toContain('comments.md');
    expect(files.length).toBe(6);

    const content = await readFile(
      resolve(assignmentDir, 'assignment.md'),
      'utf-8',
    );
    expect(content).toContain('slug: write-tests');
    expect(content).toContain(`id: ${uuid}`);
    expect(content).toContain('project: null');
    expect(content).toContain('status: pending');
    expect(content).toContain('priority: medium');
    expect(content).toContain('assignee: null');
  });

  it('rejects --one-off with --depends-on', async () => {
    await expect(
      createAssignmentCommand('Test', {
        oneOff: true,
        dependsOn: 'foo',
      }),
    ).rejects.toThrow('Standalone assignments cannot have dependencies');
  });

  it('creates assignment with --project in specified dir', async () => {
    await createProjectCommand('Test Project', { dir: testDir });

    await createAssignmentCommand('My Task', {
      project: 'test-project',
      dir: testDir,
      priority: 'high',
      dependsOn: 'dep-one,dep-two',
    });

    const assignmentDir = resolve(
      testDir,
      'test-project',
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

  it('throws without --project or --one-off', async () => {
    await expect(
      createAssignmentCommand('Test', {}),
    ).rejects.toThrow('Either --project');
  });

  it('throws with both --project and --one-off', async () => {
    await expect(
      createAssignmentCommand('Test', {
        project: 'some-project',
        oneOff: true,
      }),
    ).rejects.toThrow('Cannot use both');
  });

  it('throws on empty title', async () => {
    await expect(
      createAssignmentCommand('', { project: 'test' }),
    ).rejects.toThrow('cannot be empty');
  });

  it('throws on invalid project slug', async () => {
    await expect(
      createAssignmentCommand('Test', {
        project: 'INVALID SLUG!',
        dir: testDir,
      }),
    ).rejects.toThrow('Invalid project slug');
  });

  it('throws on invalid dependency slug', async () => {
    await createProjectCommand('Test', { dir: testDir });
    await expect(
      createAssignmentCommand('Task', {
        project: 'test',
        dir: testDir,
        dependsOn: 'valid-dep,INVALID!',
      }),
    ).rejects.toThrow('Invalid dependency slug');
  });
});
