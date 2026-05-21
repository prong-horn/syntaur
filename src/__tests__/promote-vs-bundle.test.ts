import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  promoteTodosToNewAssignment,
  BundlePromoteError,
} from '../utils/promote-todos.js';
import type { TodoItem } from '../todos/types.js';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], syntaurHome: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, SYNTAUR_HOME: syntaurHome },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => { resolvePromise({ code: code ?? -1, stdout, stderr }); });
  });
}

function makeBundledTodo(id: string, description: string, bundleId: string): TodoItem {
  return {
    id,
    description,
    status: 'open',
    tags: [],
    session: null,
    branch: null,
    worktreePath: null,
    createdAt: '2026-05-21T13:00:00Z',
    updatedAt: '2026-05-21T13:00:00Z',
    planDir: null,
    linkedAssignmentId: null,
    linkedAssignmentRef: null,
    bundleId,
  };
}

describe('promoteTodosToNewAssignment refuses bundled todos (helper layer)', () => {
  let syntaurHome: string;
  let projectsDir: string;
  let todosDir: string;

  beforeEach(async () => {
    syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-promote-vs-bundle-'));
    projectsDir = resolve(syntaurHome, 'projects');
    todosDir = resolve(syntaurHome, 'todos');
    await mkdir(projectsDir, { recursive: true });
    await mkdir(todosDir, { recursive: true });
    await writeFile(
      resolve(syntaurHome, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\nonboarding:\n  completed: true\n---\n`,
    );
    await mkdir(resolve(projectsDir, 'alpha'), { recursive: true });
    await writeFile(
      resolve(projectsDir, 'alpha', 'project.md'),
      `---\nid: alpha-id\nslug: alpha\ntitle: Alpha\n---\n# Alpha\n`,
    );
    process.env.SYNTAUR_HOME = syntaurHome;
  });

  afterEach(async () => {
    delete process.env.SYNTAUR_HOME;
    await rm(syntaurHome, { recursive: true, force: true });
  });

  it('throws BundlePromoteError when any source item has a bundleId', async () => {
    const bundled = makeBundledTodo('aaaa', 'work item', 'bbbb');
    await expect(
      promoteTodosToNewAssignment(
        [{ todosDir, workspace: '_global', items: [bundled], scopeLabel: '_global' }],
        { title: 'New Assignment', target: { project: 'alpha' } },
      ),
    ).rejects.toBeInstanceOf(BundlePromoteError);
  });

  it('error message names the bundle id and the bundle remove verb', async () => {
    const bundled = makeBundledTodo('aaaa', 'work item', 'bbbb');
    try {
      await promoteTodosToNewAssignment(
        [{ todosDir, workspace: '_global', items: [bundled], scopeLabel: '_global' }],
        { title: 'New Assignment', target: { project: 'alpha' } },
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BundlePromoteError);
      const msg = (err as Error).message;
      expect(msg).toContain('b:bbbb');
      expect(msg).toContain('syntaur todo bundle remove');
    }
  });
});

describe('syntaur todo promote CLI refuses bundled todos', () => {
  let syntaurHome: string;
  let projectsDir: string;

  beforeEach(async () => {
    syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-promote-cli-'));
    projectsDir = resolve(syntaurHome, 'projects');
    await mkdir(projectsDir, { recursive: true });
    await writeFile(
      resolve(syntaurHome, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\nonboarding:\n  completed: true\n---\n`,
    );
    await mkdir(resolve(projectsDir, 'alpha'), { recursive: true });
    await writeFile(
      resolve(projectsDir, 'alpha', 'project.md'),
      `---\nid: alpha-id\nslug: alpha\ntitle: Alpha\n---\n# Alpha\n`,
    );
  });

  afterEach(async () => {
    await rm(syntaurHome, { recursive: true, force: true });
  });

  it('exits non-zero with bundle-membership error', async () => {
    // Seed a workspace todo and manually inject a bundleId in the meta token.
    await mkdir(resolve(syntaurHome, 'todos'), { recursive: true });
    await writeFile(
      resolve(syntaurHome, 'todos', '_global.md'),
      `---\nworkspace: _global\narchiveInterval: weekly\n---\n\n# Quick Todos\n\n- [ ] work item [t:aaaa] <c=2026-05-21T13:00:00Z;u=2026-05-21T13:00:00Z;bn=bbbb>\n`,
    );

    const res = await runCli(
      ['todo', 'promote', 'aaaa', '--new-assignment', '--to-project', 'alpha', '--title', 'foo'],
      syntaurHome,
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/part of bundle/i);
    expect(res.stderr + res.stdout).toMatch(/b:bbbb/);
    expect(res.stderr + res.stdout).toMatch(/syntaur todo bundle remove/);
  });
});
