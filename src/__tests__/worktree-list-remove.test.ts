import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileExists } from '../utils/fs.js';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult { code: number; stdout: string; stderr: string }

async function runCli(args: string[], home: string): Promise<RunResult> {
  return new Promise((res) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, SYNTAUR_HOME: home },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => res({ code: code ?? -1, stdout, stderr }));
  });
}

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

const ASSIGNMENT = `---
id: aaaa
slug: a
title: "A"
project: p
status: in_progress
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
---
# A
`;

describe('syntaur worktree list/remove', () => {
  let home: string;
  let repo: string;
  let assignmentPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-wt-'));
    repo = resolve(home, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    await writeFile(resolve(repo, 'README.md'), '# r\n', 'utf-8');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);

    await writeFile(resolve(home, 'config.md'), `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`, 'utf-8');
    const dir = resolve(home, 'projects', 'p', 'assignments', 'a');
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(home, 'projects', 'p', 'project.md'), '---\nslug: p\ntitle: "P"\n---\n# P\n', 'utf-8');
    assignmentPath = resolve(dir, 'assignment.md');
    await writeFile(assignmentPath, ASSIGNMENT, 'utf-8');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('create → list shows the worktree → remove deletes it and clears workspace.*', async () => {
    const create = await runCli(
      ['worktree', 'create', '--branch', 'feat-x', '--repository', repo, '--assignment', 'a', '--project', 'p'],
      home,
    );
    expect(create.code, create.stderr).toBe(0);
    expect(await fileExists(resolve(repo, '.worktrees', 'feat-x'))).toBe(true);
    // workspace.* recorded.
    expect(await readFile(assignmentPath, 'utf-8')).toContain('branch: feat-x');

    const list = await runCli(['worktree', 'list', '--repository', repo, '--json'], home);
    expect(list.code, list.stderr).toBe(0);
    const entries = JSON.parse(list.stdout);
    expect(entries.some((e: { branch: string | null }) => e.branch === 'feat-x')).toBe(true);

    const remove = await runCli(['worktree', 'remove', '--assignment', 'a', '--project', 'p', '--delete-branch'], home);
    expect(remove.code, remove.stderr).toBe(0);
    expect(await fileExists(resolve(repo, '.worktrees', 'feat-x'))).toBe(false);

    // workspace.* cleared back to null.
    const content = await readFile(assignmentPath, 'utf-8');
    expect(content).toContain('branch: null');
    expect(content).toContain('worktreePath: null');
  });

  it('prints the branch SHA recovery hint before deleting the branch (U1)', async () => {
    const create = await runCli(
      ['worktree', 'create', '--branch', 'feat-y', '--repository', repo, '--assignment', 'a', '--project', 'p'],
      home,
    );
    expect(create.code, create.stderr).toBe(0);
    const sha = (() => {
      const r = spawnSync('git', ['-C', repo, 'rev-parse', '--short', 'feat-y'], { encoding: 'utf-8' });
      return r.stdout.trim();
    })();

    const remove = await runCli(['worktree', 'remove', '--assignment', 'a', '--project', 'p', '--delete-branch'], home);
    expect(remove.code, remove.stderr).toBe(0);
    // Recovery hint names the branch + its SHA so the user can re-create it.
    expect(remove.stdout).toContain(`Branch "feat-y" was at ${sha}`);
    expect(remove.stdout).toContain(`branch feat-y ${sha}`);
  });

  it('blocks --force without --yes off a TTY and leaves the worktree intact (U1)', async () => {
    const create = await runCli(
      ['worktree', 'create', '--branch', 'feat-z', '--repository', repo, '--assignment', 'a', '--project', 'p'],
      home,
    );
    expect(create.code, create.stderr).toBe(0);
    // Make the worktree dirty (uncommitted work that --force would discard).
    await writeFile(resolve(repo, '.worktrees', 'feat-z', 'scratch.txt'), 'dirty\n', 'utf-8');

    // Spawned with no TTY: --force without --yes must refuse and explain.
    const remove = await runCli(['worktree', 'remove', '--assignment', 'a', '--project', 'p', '--force'], home);
    expect(remove.code).toBe(1);
    expect(remove.stderr).toContain('--yes');
    // The destructive removal did not happen.
    expect(await fileExists(resolve(repo, '.worktrees', 'feat-z'))).toBe(true);
  });
});
