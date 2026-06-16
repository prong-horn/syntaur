import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { fileExists } from '../utils/fs.js';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult { code: number; stdout: string; stderr: string }

function runCli(args: string[], home: string): Promise<RunResult> {
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

function assignmentMd(opts: {
  slug: string;
  status: string;
  repo: string;
  worktreePath: string;
  branch: string;
  archived?: boolean;
}): string {
  return `---
id: id-${opts.slug}
slug: ${opts.slug}
title: "${opts.slug}"
project: p
status: ${opts.status}
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
archived: ${opts.archived ? 'true' : 'false'}
workspace:
  repository: ${opts.repo}
  worktreePath: ${opts.worktreePath}
  branch: ${opts.branch}
  parentBranch: main
---
# ${opts.slug}
`;
}

describe('syntaur worktree gc', () => {
  let home: string;
  let repo: string;

  async function writeAssignment(opts: { slug: string; status: string; worktreePath: string; branch: string; archived?: boolean }): Promise<void> {
    const dir = resolve(home, 'projects', 'p', 'assignments', opts.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'assignment.md'), assignmentMd({ ...opts, repo }), 'utf-8');
  }

  function addWorktree(branch: string, extraCommit: boolean): string {
    const wtPath = resolve(repo, '.worktrees', branch);
    git(repo, ['worktree', 'add', '-b', branch, wtPath, 'main']);
    if (extraCommit) {
      // A commit only on the feature branch makes it NOT merged into main.
      const f = resolve(wtPath, `${branch}.txt`);
      spawnSync('bash', ['-c', `echo x > ${f}`]);
      git(wtPath, ['add', '.']);
      git(wtPath, ['commit', '-q', '-m', `work on ${branch}`]);
    }
    return wtPath;
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-gc-'));
    repo = resolve(home, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    await writeFile(resolve(repo, 'README.md'), '# r\n', 'utf-8');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
    await writeFile(
      resolve(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
      'utf-8',
    );
    await mkdir(resolve(home, 'projects', 'p', 'assignments'), { recursive: true });
    await writeFile(resolve(home, 'projects', 'p', 'project.md'), '---\nslug: p\ntitle: "P"\n---\n# P\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('dry-run (default) classifies a merged+completed worktree as removable and removes nothing', async () => {
    const wt = addWorktree('feat-done', false);
    await writeAssignment({ slug: 'a', status: 'completed', worktreePath: wt, branch: 'feat-done' });

    const r = await runCli(['worktree', 'gc', '--repository', repo, '--json'], home);
    expect(r.code, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout);
    const cand = report.candidates.find((c: { worktreePath: string }) => c.worktreePath.endsWith('feat-done'));
    expect(cand.reason).toBe('removable');
    expect(report.applied).toBe(false);
    expect(await fileExists(wt)).toBe(true); // dry-run removed nothing
  });

  it('--apply removes a removable worktree but PRESERVES workspace.* (recoverable)', async () => {
    const wt = addWorktree('feat-done', false);
    const slugDir = resolve(home, 'projects', 'p', 'assignments', 'a');
    await writeAssignment({ slug: 'a', status: 'completed', worktreePath: wt, branch: 'feat-done' });

    const r = await runCli(['worktree', 'gc', '--repository', repo, '--apply'], home);
    expect(r.code, r.stderr).toBe(0);
    expect(await fileExists(wt)).toBe(false); // worktree dir removed

    // The assignment's workspace.* fields must survive so `open --recreate` works.
    const fm = await readFile(resolve(slugDir, 'assignment.md'), 'utf-8');
    expect(fm).toContain(`worktreePath: ${wt}`);
    expect(fm).toContain('branch: feat-done');

    // Roundtrip: open --recreate rebuilds it at the exact path.
    const open = await runCli(['open', 'a', '--project', 'p', '--recreate'], home);
    expect(open.code, open.stderr).toBe(0);
    expect(await fileExists(wt)).toBe(true);
  });

  it('classifies unmerged / non-terminal / orphan and never removes them', async () => {
    const merged = addWorktree('feat-done', false);
    const unmerged = addWorktree('feat-wip', true);
    const inprog = addWorktree('feat-active', false);
    const orphan = addWorktree('feat-orphan', false);
    await writeAssignment({ slug: 'a', status: 'completed', worktreePath: merged, branch: 'feat-done' });
    await writeAssignment({ slug: 'b', status: 'completed', worktreePath: unmerged, branch: 'feat-wip' });
    await writeAssignment({ slug: 'c', status: 'in_progress', worktreePath: inprog, branch: 'feat-active' });
    // no assignment for feat-orphan

    const r = await runCli(['worktree', 'gc', '--repository', repo, '--apply', '--json'], home);
    expect(r.code, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout);
    const byPath = (suffix: string) => report.candidates.find((c: { worktreePath: string }) => c.worktreePath.endsWith(suffix));
    expect(byPath('feat-done').reason).toBe('removable');
    expect(byPath('feat-wip').reason).toBe('unmerged');
    expect(byPath('feat-active').reason).toBe('non-terminal');
    expect(byPath('feat-orphan').reason).toBe('orphan');
    // Only the removable one is gone.
    expect(await fileExists(merged)).toBe(false);
    expect(await fileExists(unmerged)).toBe(true);
    expect(await fileExists(inprog)).toBe(true);
    expect(await fileExists(orphan)).toBe(true);
  });

  it('protects a worktree claimed by BOTH a completed and an active assignment', async () => {
    const wt = addWorktree('feat-shared', false);
    // Two records point at the same worktree: one completed, one active. The
    // active one must protect it — never removable.
    await writeAssignment({ slug: 'a', status: 'completed', worktreePath: wt, branch: 'feat-shared' });
    await writeAssignment({ slug: 'b', status: 'in_progress', worktreePath: wt, branch: 'feat-shared' });

    const r = await runCli(['worktree', 'gc', '--repository', repo, '--apply', '--json'], home);
    expect(r.code, r.stderr).toBe(0);
    const cand = JSON.parse(r.stdout).candidates.find((c: { worktreePath: string }) => c.worktreePath.endsWith('feat-shared'));
    expect(cand.reason).toBe('non-terminal');
    expect(cand.willRemove).toBe(false);
    expect(await fileExists(wt)).toBe(true);
  });

  it('never classifies the main worktree as removable', async () => {
    const r = await runCli(['worktree', 'gc', '--repository', repo, '--json'], home);
    expect(r.code, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout);
    // Only the main worktree exists here. git may report it as a realpath
    // (/private/var vs /var), so assert on classification rather than the raw path.
    expect(report.candidates).toHaveLength(1);
    const main = report.candidates[0];
    expect(main.reason).toBe('current');
    expect(main.willRemove).toBe(false);
  });

  it('counts recorded agent sessions per worktree (read-only) without creating the DB if absent', async () => {
    const wt = addWorktree('feat-done', false);
    await writeAssignment({ slug: 'a', status: 'completed', worktreePath: wt, branch: 'feat-done' });

    // No DB yet -> count 0, and gc must NOT create syntaur.db.
    const dbPath = resolve(home, 'syntaur.db');
    const r0 = await runCli(['worktree', 'gc', '--repository', repo, '--json'], home);
    const c0 = JSON.parse(r0.stdout).candidates.find((c: { worktreePath: string }) => c.worktreePath.endsWith('feat-done'));
    expect(c0.sessions).toBe(0);
    expect(await fileExists(dbPath)).toBe(false);

    // Seed a minimal sessions table with a row at this worktree path.
    const db = new Database(dbPath);
    db.exec('CREATE TABLE sessions (session_id TEXT, path TEXT)');
    db.prepare('INSERT INTO sessions (session_id, path) VALUES (?, ?)').run('s1', wt);
    db.close();

    const r1 = await runCli(['worktree', 'gc', '--repository', repo, '--json'], home);
    const c1 = JSON.parse(r1.stdout).candidates.find((c: { worktreePath: string }) => c.worktreePath.endsWith('feat-done'));
    expect(c1.sessions).toBe(1);
  });

  it('--apply --force off a TTY requires --yes', async () => {
    const wt = addWorktree('feat-wip', true);
    await writeAssignment({ slug: 'a', status: 'completed', worktreePath: wt, branch: 'feat-wip' });
    const r = await runCli(['worktree', 'gc', '--repository', repo, '--apply', '--force'], home);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('--yes');
    expect(await fileExists(wt)).toBe(true); // nothing removed
  });

  it('--apply --force --yes removes an unmerged linked+terminal worktree', async () => {
    const wt = addWorktree('feat-wip', true);
    await writeAssignment({ slug: 'a', status: 'completed', worktreePath: wt, branch: 'feat-wip' });
    const r = await runCli(['worktree', 'gc', '--repository', repo, '--apply', '--force', '--yes'], home);
    expect(r.code, r.stderr).toBe(0);
    expect(await fileExists(wt)).toBe(false);
  });
});
