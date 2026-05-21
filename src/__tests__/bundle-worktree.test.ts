import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult { code: number; stdout: string; stderr: string }

async function runCli(args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => { resolvePromise({ code: code ?? -1, stdout, stderr }); });
  });
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

let scratch: string;
let syntaurHome: string;
let projectsDir: string;
let repo: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'syntaur-bundle-wt-'));
  syntaurHome = resolve(scratch, '.syntaur');
  projectsDir = resolve(syntaurHome, 'projects');
  repo = resolve(scratch, 'repo');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(repo);
  await writeFile(
    resolve(syntaurHome, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\nonboarding:\n  completed: true\n---\n`,
  );
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  await writeFile(resolve(repo, 'README.md'), '# test\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function newBundleWithTwoTodos(env: Record<string, string>): Promise<string> {
  const a = await runCli(['todo', 'add', 'first'], env);
  expect(a.code).toBe(0);
  const b = await runCli(['todo', 'add', 'second'], env);
  expect(b.code).toBe(0);
  const list = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
  const ids = [...list.matchAll(/\[t:([a-f0-9]{4})\]/g)].map((m) => m[1]);
  expect(ids).toHaveLength(2);
  const create = await runCli(['todo', 'bundle', 'new', ids[0], ids[1]], env);
  expect(create.code).toBe(0);
  return create.stdout.match(/b:([a-f0-9]{4})/)![1];
}

describe('syntaur todo bundle worktree', () => {
  it('happy path: creates worktree, writes bundle-shaped context.json, persists repository on the bundle', async () => {
    const env = { SYNTAUR_HOME: syntaurHome };
    const bid = await newBundleWithTwoTodos(env);

    const res = await runCli(
      ['todo', 'bundle', 'worktree', bid, '--branch', 'feat/x', '--repository', repo],
      env,
    );
    expect(res.code).toBe(0);
    const wtPath = resolve(repo, '.worktrees', 'feat/x');
    expect((await stat(wtPath)).isDirectory()).toBe(true);
    expect(res.stdout).toContain(wtPath);
    expect(res.stdout).toMatch(/Bound bundle b:[a-f0-9]{4} with 2 member todos/);

    // context.json has bundle fields, NO assignment fields
    const ctx = JSON.parse(await readFile(resolve(wtPath, '.syntaur', 'context.json'), 'utf-8'));
    expect(ctx.bundleId).toBe(bid);
    expect(ctx.bundleScope).toBe('global');
    expect(ctx.bundleScopeId).toBe('_global');
    expect(ctx.todoIds).toHaveLength(2);
    expect(ctx.branch).toBe('feat/x');
    expect(ctx.worktreePath).toBe(wtPath);
    expect(ctx.repository).toBe(repo);
    expect(ctx.boundAt).toBeTruthy();
    expect(ctx.assignmentDir).toBeUndefined();
    expect(ctx.assignmentSlug).toBeUndefined();
    expect(ctx.projectSlug).toBeUndefined();

    // bundle persisted: repository + branch + worktreePath captured
    const bundlesFile = await readFile(resolve(syntaurHome, 'todos', 'bundles', 'index.md'), 'utf-8');
    expect(bundlesFile).toMatch(new RegExp(`b:${bid} `));
    expect(bundlesFile).toContain('branch=feat/x');
    expect(bundlesFile).toContain(`worktree=${wtPath}`);
    expect(bundlesFile).toContain(`repository=${repo}`);

    // each member checklist row has the same branch/worktree
    const checklist = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    const memberLines = checklist.split('\n').filter((l) => l.startsWith('- '));
    expect(memberLines).toHaveLength(2);
    for (const line of memberLines) {
      expect(line).toContain('b=feat/x');
      expect(line).toContain(`w=${wtPath}`);
    }
  });

  it('rollback when record() write fails: worktree + branch are gone, error tagged "bundle storage"', async () => {
    const env = { SYNTAUR_HOME: syntaurHome };
    const bid = await newBundleWithTwoTodos(env);

    // Make the bundles/ subdirectory non-writable AFTER the bundle exists so:
    //   1. readBundles still succeeds (reads index.md, which is readable).
    //   2. createWorktree succeeds.
    //   3. writeBundles inside record() fails (cannot rewrite index.md).
    //   4. Rollback removes worktree + branch.
    const { chmod } = await import('node:fs/promises');
    const bundlesSubdir = resolve(syntaurHome, 'todos', 'bundles');
    await chmod(bundlesSubdir, 0o555);

    const res = await runCli(
      ['todo', 'bundle', 'worktree', bid, '--branch', 'feat/blocked', '--repository', repo],
      env,
    );
    // Restore perms so afterEach cleanup can run.
    await chmod(bundlesSubdir, 0o755);
    expect(res.code).not.toBe(0);
    const wtRollbackPath = resolve(repo, '.worktrees', 'feat/blocked');
    expect(await stat(wtRollbackPath).then(() => true, () => false)).toBe(false);
    const branches = git(repo, ['branch', '--list']);
    expect(branches).not.toContain('feat/blocked');
    expect(res.stderr).toMatch(/bundle storage/i);
    expect(res.stderr).not.toMatch(/assignment frontmatter/i);
  });

  it('rejects if bundle already has a worktreePath', async () => {
    const env = { SYNTAUR_HOME: syntaurHome };
    const bid = await newBundleWithTwoTodos(env);

    const first = await runCli(
      ['todo', 'bundle', 'worktree', bid, '--branch', 'feat/a', '--repository', repo],
      env,
    );
    expect(first.code).toBe(0);
    const second = await runCli(
      ['todo', 'bundle', 'worktree', bid, '--branch', 'feat/b', '--repository', repo],
      env,
    );
    expect(second.code).not.toBe(0);
    expect(second.stderr).toMatch(/already has a worktree/i);
    // Second branch was NOT created.
    const branches = git(repo, ['branch', '--list']);
    expect(branches).not.toContain('feat/b');
  });

  it('surfaces git error when branch already exists in the repo', async () => {
    const env = { SYNTAUR_HOME: syntaurHome };
    const bid = await newBundleWithTwoTodos(env);
    // Create the branch ahead of time.
    git(repo, ['branch', 'feat/dupe', 'main']);
    const res = await runCli(
      ['todo', 'bundle', 'worktree', bid, '--branch', 'feat/dupe', '--repository', repo],
      env,
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/(git worktree add failed|already exists)/i);
  });
});
