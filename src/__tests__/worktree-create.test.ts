import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cwd: string, syntaurHome: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      env: { ...process.env, SYNTAUR_HOME: syntaurHome },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

const ASSIGNMENT_MD = `---
id: abc
slug: demo
title: "Demo"
project: p
status: in_progress
priority: medium
created: "2026-04-23T12:00:00Z"
updated: "2026-04-23T12:00:00Z"
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

Body.
`;

describe('syntaur worktree create', () => {
  let syntaurHome: string;
  let scratch: string;
  let repo: string;
  let assignmentDir: string;

  beforeEach(async () => {
    syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-wtc-home-'));
    await writeFile(
      resolve(syntaurHome, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(syntaurHome, 'projects')}\nonboarding:\n  completed: true\n---\n`,
    );
    assignmentDir = resolve(syntaurHome, 'projects', 'p', 'assignments', 'demo');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(resolve(assignmentDir, 'assignment.md'), ASSIGNMENT_MD);

    scratch = await mkdtemp(join(tmpdir(), 'syntaur-wtc-repo-'));
    repo = resolve(scratch, 'repo');
    await mkdir(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    // CI runners have no global git identity — configure locally so the
    // initial commit doesn't bail with "Author identity unknown".
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['commit', '--allow-empty', '-m', 'init', '--quiet']);
  });

  afterEach(async () => {
    await rm(syntaurHome, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  it('creates a worktree at <repo>/.worktrees/<branch> and updates assignment workspace', async () => {
    const result = await runCli(
      [
        'worktree',
        'create',
        '--repository',
        repo,
        '--branch',
        'feat/x',
        '--parent-branch',
        'main',
        '--assignment',
        'demo',
        '--project',
        'p',
      ],
      repo,
      syntaurHome,
    );
    expect(result.code, result.stderr).toBe(0);
    const expectedPath = resolve(repo, '.worktrees', 'feat/x');
    const st = await stat(expectedPath);
    expect(st.isDirectory()).toBe(true);
    const updated = await readFile(resolve(assignmentDir, 'assignment.md'), 'utf-8');
    expect(updated).toContain('repository: ');
    expect(updated).toContain(`worktreePath: ${expectedPath}`);
    expect(updated).toContain('branch: feat/x');
    expect(updated).toContain('parentBranch: main');
  });

  it('fails cleanly when the branch already exists', async () => {
    git(repo, ['branch', 'feat/already-here']);
    const result = await runCli(
      [
        'worktree',
        'create',
        '--repository',
        repo,
        '--branch',
        'feat/already-here',
        '--parent-branch',
        'main',
        '--assignment',
        'demo',
        '--project',
        'p',
      ],
      repo,
      syntaurHome,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Error|worktree add failed/);
  });
});
