import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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

let syntaurHome: string;
let projectsDir: string;

beforeEach(async () => {
  syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-doctor-bundles-'));
  projectsDir = resolve(syntaurHome, 'projects');
  await mkdir(projectsDir, { recursive: true });
  await writeFile(
    resolve(syntaurHome, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\nonboarding:\n  completed: true\n---\n`,
  );
});

afterEach(async () => {
  await rm(syntaurHome, { recursive: true, force: true });
});

async function bundleTwoTodos(env: Record<string, string>): Promise<{ bid: string; ids: [string, string] }> {
  expect((await runCli(['todo', 'add', 'one'], env)).code).toBe(0);
  expect((await runCli(['todo', 'add', 'two'], env)).code).toBe(0);
  const list = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
  const ids = [...list.matchAll(/\[t:([a-f0-9]{4})\]/g)].map((m) => m[1]) as [string, string];
  const create = await runCli(['todo', 'bundle', 'new', ids[0], ids[1]], env);
  expect(create.code).toBe(0);
  return { bid: create.stdout.match(/b:([a-f0-9]{4})/)![1], ids };
}

describe('doctor bundle checks', () => {
  it('clean repo passes every bundle check', async () => {
    const env = { SYNTAUR_HOME: syntaurHome };
    await bundleTwoTodos(env);
    // doctor may exit non-zero because of unrelated checks failing on a
    // bare-temp syntaurHome (no skills/, no agents/, etc.). Only assert bundles.
    const res = await runCli(['doctor', '--json'], env);
    const report = JSON.parse(res.stdout);
    const bundleChecks = report.checks.filter((c: any) => c.category === 'bundles');
    expect(bundleChecks).toHaveLength(6);
    for (const c of bundleChecks) {
      expect(c.status).toBe('pass');
    }
  });

  it('flags an orphan bundleId on a todo whose referenced bundle no longer exists', async () => {
    const env = { SYNTAUR_HOME: syntaurHome };
    const { ids } = await bundleTwoTodos(env);
    // Hand-edit bundles/index.md to remove the bundle.
    await writeFile(resolve(syntaurHome, 'todos', 'bundles', 'index.md'), '---\nversion: "1"\n---\n\n# Todo Bundles\n\n');
    const res = await runCli(['doctor', '--json'], env);
    expect(res.code).not.toBe(0); // doctor exits non-zero on errors
    const report = JSON.parse(res.stdout);
    const orphan = report.checks.find((c: any) => c.id === 'bundles.orphan-bundleid');
    expect(orphan.status).toBe('error');
    expect(orphan.detail).toMatch(new RegExp(`t:${ids[0]}`));
  });

  it('flags a missing member when a member todo was deleted', async () => {
    const env = { SYNTAUR_HOME: syntaurHome };
    const { bid, ids } = await bundleTwoTodos(env);
    void bid;
    // Delete one member from the checklist by hand-editing the markdown.
    const listPath = resolve(syntaurHome, 'todos', '_global.md');
    const content = await readFile(listPath, 'utf-8');
    const trimmed = content.split('\n').filter((l) => !l.includes(`[t:${ids[1]}]`)).join('\n');
    await writeFile(listPath, trimmed);
    const res = await runCli(['doctor', '--json'], env);
    const report = JSON.parse(res.stdout);
    const missing = report.checks.find((c: any) => c.id === 'bundles.missing-members');
    expect(missing.status).toBe('error');
  });

  it('flags min-members violation when a bundle has only 1 todoId on disk', async () => {
    const env = { SYNTAUR_HOME: syntaurHome };
    const { bid } = await bundleTwoTodos(env);
    // Hand-edit bundles/index.md to truncate the todos list to 1 member.
    const bpath = resolve(syntaurHome, 'todos', 'bundles', 'index.md');
    const before = await readFile(bpath, 'utf-8');
    const after = before.replace(/todos=([a-f0-9]{4}),[a-f0-9]{4}/, 'todos=$1');
    expect(after).not.toBe(before);
    await writeFile(bpath, after);
    const res = await runCli(['doctor', '--json'], env);
    const report = JSON.parse(res.stdout);
    const minMembers = report.checks.find((c: any) => c.id === 'bundles.min-members');
    expect(minMembers.status).toBe('error');
    expect(minMembers.detail).toMatch(new RegExp(`b:${bid}`));
  });

  it('warns on stale-plan-dir when bundle.planDir was removed from disk', async () => {
    const env = { SYNTAUR_HOME: syntaurHome };
    const { bid } = await bundleTwoTodos(env);
    expect((await runCli(['todo', 'bundle', 'plan', bid], env)).code).toBe(0);
    const planDir = resolve(syntaurHome, 'todos', 'plans', '_global', 'bundles', bid);
    await rm(planDir, { recursive: true, force: true });
    const res = await runCli(['doctor', '--json'], env);
    const report = JSON.parse(res.stdout);
    const stale = report.checks.find((c: any) => c.id === 'bundles.stale-plan-dir');
    expect(stale.status).toBe('warn');
  });

  it('warns on stale-worktree when the worktree dir was removed outside git', async () => {
    const env = { SYNTAUR_HOME: syntaurHome };
    const { bid } = await bundleTwoTodos(env);
    // Set up a real git repo + bundle worktree.
    const repo = resolve(syntaurHome, 'repo');
    await mkdir(repo);
    const g = (args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@t.com']);
    g(['config', 'user.name', 't']);
    await writeFile(resolve(repo, 'README.md'), '# t\n');
    g(['add', '.']); g(['commit', '-q', '-m', 'init']);
    expect((await runCli(['todo', 'bundle', 'worktree', bid, '--branch', 'feat/x', '--repository', repo], env)).code).toBe(0);
    const wtPath = resolve(repo, '.worktrees', 'feat/x');
    // Remove worktree dir by hand (NOT via git worktree remove) so git's
    // index of worktrees still references it but the directory is gone.
    await rm(wtPath, { recursive: true, force: true });
    const res = await runCli(['doctor', '--json'], env);
    const report = JSON.parse(res.stdout);
    const stale = report.checks.find((c: any) => c.id === 'bundles.stale-worktree');
    expect(stale.status).toBe('warn');
  });
});
