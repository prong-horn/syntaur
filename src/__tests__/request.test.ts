import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createProjectCommand } from '../commands/create-project.js';
import { createAssignmentCommand } from '../commands/create-assignment.js';
import { requestCommand } from '../commands/request.js';

let testDir: string;
let origSyntaurHome: string | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-request-test-'));
  origSyntaurHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = testDir;
});

afterEach(async () => {
  if (origSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origSyntaurHome;
  await rm(testDir, { recursive: true, force: true });
});

describe('requestCommand', () => {
  it('appends a todo to the target with "(from: <source>)" annotation', async () => {
    await createProjectCommand('P', { dir: testDir });
    await createAssignmentCommand('Target', { project: 'p', dir: testDir });

    await requestCommand('target', 'verify the rate-limit config', {
      project: 'p',
      from: 'write-auth-tests',
      dir: testDir,
    });

    const targetMd = await readFile(
      resolve(testDir, 'p', 'assignments', 'target', 'assignment.md'),
      'utf-8',
    );
    expect(targetMd).toContain(
      '- [ ] verify the rate-limit config (from: write-auth-tests)',
    );
  });

  it('creates a ## Todos section when the target does not already have one', async () => {
    await createProjectCommand('P', { dir: testDir });
    await createAssignmentCommand('Target', { project: 'p', dir: testDir });

    const targetMdPath = resolve(
      testDir,
      'p',
      'assignments',
      'target',
      'assignment.md',
    );
    const original = await readFile(targetMdPath, 'utf-8');
    // Strip the Todos section the template scaffolds in, to simulate a target
    // without one — requestCommand should create it.
    const stripped = original.replace(
      /## Todos[\s\S]*?(?=\n## )/,
      '',
    );
    await writeFile(targetMdPath, stripped);
    expect(await readFile(targetMdPath, 'utf-8')).not.toContain('## Todos');

    await requestCommand('target', 'new todo', {
      project: 'p',
      from: 'src',
      dir: testDir,
    });

    const after = await readFile(targetMdPath, 'utf-8');
    expect(after).toContain('## Todos');
    expect(after).toContain('- [ ] new todo (from: src)');
  });

  it('bumps the target\'s "updated" timestamp', async () => {
    await createProjectCommand('P', { dir: testDir });
    await createAssignmentCommand('Target', { project: 'p', dir: testDir });

    const targetMdPath = resolve(
      testDir,
      'p',
      'assignments',
      'target',
      'assignment.md',
    );
    const before = await readFile(targetMdPath, 'utf-8');
    const beforeUpdated = before.match(/^updated:\s*"(.+)"/m)?.[1];
    expect(beforeUpdated).toBeTruthy();

    // Sleep a second so the timestamp changes
    await new Promise((r) => setTimeout(r, 1100));

    await requestCommand('target', 'x', {
      project: 'p',
      from: 'src',
      dir: testDir,
    });

    const after = await readFile(targetMdPath, 'utf-8');
    const afterUpdated = after.match(/^updated:\s*"(.+)"/m)?.[1];
    expect(afterUpdated).toBeTruthy();
    expect(afterUpdated).not.toBe(beforeUpdated);
  });

  it('rejects empty request text', async () => {
    await createProjectCommand('P', { dir: testDir });
    await createAssignmentCommand('Target', { project: 'p', dir: testDir });

    await expect(
      requestCommand('target', '   ', {
        project: 'p',
        from: 'src',
        dir: testDir,
      }),
    ).rejects.toThrow('empty');
  });
});
