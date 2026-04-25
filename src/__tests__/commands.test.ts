import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createProjectCommand } from '../commands/create-project.js';
import { createAssignmentCommand } from '../commands/create-assignment.js';
import { trackSessionCommand } from '../commands/track-session.js';

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

  it('writes workspaceGroup line when --one-off --workspace is used', async () => {
    await createAssignmentCommand('Workspace Task', {
      oneOff: true,
      workspace: 'syntaur',
    });

    const standaloneRoot = resolve(testDir, 'assignments');
    const folders = await readdir(standaloneRoot);
    const assignmentDir = resolve(standaloneRoot, folders[0]);
    const content = await readFile(
      resolve(assignmentDir, 'assignment.md'),
      'utf-8',
    );
    expect(content).toContain('workspaceGroup: syntaur');
    expect(content).toContain('project: null');
  });

  it('omits workspaceGroup line when --one-off has no --workspace', async () => {
    await createAssignmentCommand('Plain One-off', { oneOff: true });

    const standaloneRoot = resolve(testDir, 'assignments');
    const folders = await readdir(standaloneRoot);
    const assignmentDir = resolve(standaloneRoot, folders[0]);
    const content = await readFile(
      resolve(assignmentDir, 'assignment.md'),
      'utf-8',
    );
    expect(content).not.toContain('workspaceGroup:');
  });

  it('rejects --workspace without --one-off', async () => {
    await expect(
      createAssignmentCommand('Test', { workspace: 'syntaur' }),
    ).rejects.toThrow('--workspace requires --one-off');
  });

  it('rejects --workspace with --project', async () => {
    await expect(
      createAssignmentCommand('Test', {
        project: 'some-project',
        workspace: 'syntaur',
      }),
    ).rejects.toThrow('Cannot use --workspace with --project');
  });

  it('rejects invalid workspace slug', async () => {
    await expect(
      createAssignmentCommand('Test', {
        oneOff: true,
        workspace: 'INVALID!',
      }),
    ).rejects.toThrow('Invalid workspace slug');
  });
});

describe('trackSessionCommand required flags', () => {
  it('rejects when sessionId is missing', async () => {
    // Without --session-id the in-function guard must fire before any DB touch.
    await expect(
      trackSessionCommand({ agent: 'claude' } as any),
    ).rejects.toThrow(/session-id/);
  });

  it('rejects when agent is missing', async () => {
    await expect(
      trackSessionCommand({ sessionId: 'real-id' } as any),
    ).rejects.toThrow(/--agent/);
  });
});

describe('track-session CLI: Commander required-option enforcement', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = resolve(here, '../../dist/index.js');

  it('exits non-zero with a session-id error when --session-id omitted', () => {
    if (!existsSync(cliPath)) {
      // Verification plan requires a prior `npm run build`. Fail loudly rather
      // than silently passing so the dev notices.
      throw new Error(
        `dist CLI not found at ${cliPath}. Run \`npm run build\` before the test suite.`,
      );
    }

    const res = spawnSync(
      'node',
      [cliPath, 'track-session', '--agent', 'claude'],
      { encoding: 'utf-8' },
    );
    expect(res.status).not.toBe(0);
    // Commander emits "required option '--session-id <id>'" on stderr.
    expect(res.stderr).toMatch(/session-id/);
  });
});
