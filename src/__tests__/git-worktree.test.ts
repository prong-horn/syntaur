import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  createWorktree,
  createWorktreeAndRecord,
  recreateWorktree,
  captureHeadSha,
  removeWorktree,
  formatRollbackError,
  GitWorktreeError,
  listBranches,
  detectDefaultBranch,
} from '../utils/git-worktree.js';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

const ASSIGNMENT_TEMPLATE = `---
id: abc
slug: demo
title: "Demo"
project: p
status: pending
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

describe('git-worktree helpers', () => {
  let scratch: string;
  let repo: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'syntaur-git-'));
    repo = resolve(scratch, 'repo');
    await mkdir(repo);
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

  it('createWorktree creates a branch + worktree', async () => {
    const wtPath = resolve(scratch, 'wt1');
    await createWorktree({
      repository: repo,
      branch: 'feature/one',
      worktreePath: wtPath,
      parentBranch: 'main',
    });
    const st = await stat(wtPath);
    expect(st.isDirectory()).toBe(true);
    const branches = git(repo, ['branch', '--list']);
    expect(branches).toContain('feature/one');
  });

  it('createWorktree throws GitWorktreeError on failure', async () => {
    const wtPath = resolve(scratch, 'wt2');
    await createWorktree({
      repository: repo,
      branch: 'feature/two',
      worktreePath: wtPath,
      parentBranch: 'main',
    });
    await expect(
      createWorktree({
        repository: repo,
        branch: 'feature/two', // already exists
        worktreePath: resolve(scratch, 'wt2-dup'),
        parentBranch: 'main',
      }),
    ).rejects.toBeInstanceOf(GitWorktreeError);
  });

  it('createWorktreeAndRecord updates assignment frontmatter', async () => {
    const assignmentPath = resolve(scratch, 'assignment.md');
    await writeFile(assignmentPath, ASSIGNMENT_TEMPLATE);
    const wtPath = resolve(scratch, 'wt3');

    await createWorktreeAndRecord({
      assignmentPath,
      repository: repo,
      branch: 'feature/three',
      worktreePath: wtPath,
      parentBranch: 'main',
    });

    const content = await readFile(assignmentPath, 'utf-8');
    expect(content).toContain(`repository: ${repo}`);
    expect(content).toContain(`worktreePath: ${wtPath}`);
    expect(content).toContain('branch: feature/three');
    expect(content).toContain('parentBranch: main');
  });

  it('createWorktreeAndRecord rolls back worktree if frontmatter write fails', async () => {
    // Point at a path inside a read-only directory so writeFile throws.
    const readonlyDir = resolve(scratch, 'readonly');
    await mkdir(readonlyDir);
    // Remove write perms on the dir
    await import('node:fs/promises').then((fs) => fs.chmod(readonlyDir, 0o555));
    const assignmentPath = resolve(readonlyDir, 'assignment.md');
    // Write a stub so readFile succeeds but writeFile fails
    await import('node:fs/promises').then((fs) => fs.chmod(readonlyDir, 0o755));
    await writeFile(assignmentPath, ASSIGNMENT_TEMPLATE);
    await import('node:fs/promises').then((fs) => fs.chmod(readonlyDir, 0o555));

    const wtPath = resolve(scratch, 'wt4');
    await expect(
      createWorktreeAndRecord({
        assignmentPath,
        repository: repo,
        branch: 'feature/four',
        worktreePath: wtPath,
        parentBranch: 'main',
      }),
    ).rejects.toThrow(/Rolled back|frontmatter/);

    // Restore perms so cleanup works
    await import('node:fs/promises').then((fs) => fs.chmod(readonlyDir, 0o755));

    // Branch should NOT exist after rollback
    const branches = git(repo, ['branch', '--list']);
    expect(branches).not.toContain('feature/four');
  });

  it('formatRollbackError surfaces both stderr messages when both cleanups fail', () => {
    const msg = formatRollbackError({
      writeMsg: 'EROFS',
      worktreePath: '/x/wt',
      branch: 'feature/x',
      worktreeCleanup: { ok: false, stderr: 'wt remove failed' },
      branchCleanup: { ok: false, stderr: 'branch delete failed' },
    });
    expect(msg).toMatch(/wt remove failed/);
    expect(msg).toMatch(/branch delete failed/);
    expect(msg).toMatch(/Orphan worktree at \/x\/wt/);
    expect(msg).toMatch(/orphan branch "feature\/x"/);
  });

  it('formatRollbackError reports branch-only failure when worktree removal succeeded', () => {
    const msg = formatRollbackError({
      writeMsg: 'EROFS',
      worktreePath: '/x/wt',
      branch: 'feature/x',
      worktreeCleanup: { ok: true, stderr: '' },
      branchCleanup: { ok: false, stderr: 'branch is checked out somewhere' },
    });
    expect(msg).toMatch(/Rolled back git worktree at \/x\/wt/);
    expect(msg).toMatch(/could not delete branch "feature\/x"/);
    expect(msg).toMatch(/branch is checked out somewhere/);
  });

  it('listBranches returns local branches', async () => {
    git(repo, ['branch', 'develop']);
    git(repo, ['branch', 'feature/x']);
    const branches = await listBranches(repo);
    expect(branches).toEqual(expect.arrayContaining(['main', 'develop', 'feature/x']));
    expect(branches).toHaveLength(3);
  });

  it('detectDefaultBranch returns main when present', async () => {
    git(repo, ['branch', 'develop']);
    expect(await detectDefaultBranch(repo)).toBe('main');
  });

  it('detectDefaultBranch falls back to a real local branch when main is absent', async () => {
    git(repo, ['branch', '-m', 'main', 'trunk']);
    const result = await detectDefaultBranch(repo);
    expect(result).toBe('trunk');
    // Whatever it returns must be an actual local branch.
    expect(await listBranches(repo)).toContain(result);
  });

  it('removeWorktree cleans up', async () => {
    const wtPath = resolve(scratch, 'wt5');
    await createWorktree({
      repository: repo,
      branch: 'feature/five',
      worktreePath: wtPath,
      parentBranch: 'main',
    });
    const result = await removeWorktree(repo, wtPath);
    expect(result.ok).toBe(true);
  });

  it('captureHeadSha returns the HEAD sha, null for a non-git dir', async () => {
    const sha = await captureHeadSha(repo);
    expect(sha).toBe(git(repo, ['rev-parse', 'HEAD']));
    expect(await captureHeadSha(resolve(scratch, 'not-a-repo'))).toBeNull();
  });

  it('recreateWorktree reuses an existing branch after the dir was rm -rf\'d (stale metadata)', async () => {
    const wtPath = resolve(scratch, 'wt-reuse');
    await createWorktree({
      repository: repo,
      branch: 'feat/reuse',
      worktreePath: wtPath,
      parentBranch: 'main',
    });
    // Simulate a manual delete: remove the dir WITHOUT `git worktree remove`,
    // leaving stale `.git/worktrees/*` metadata + the branch marked checked-out.
    await rm(wtPath, { recursive: true, force: true });
    expect(git(repo, ['branch', '--list'])).toContain('feat/reuse');

    const result = await recreateWorktree({
      repository: repo,
      worktreePath: wtPath,
      branch: 'feat/reuse',
    });

    expect((await stat(wtPath)).isDirectory()).toBe(true);
    expect(result.branch).toBe('feat/reuse');
    expect(result.baseUsed).toBe('feat/reuse');
    expect(result.exact).toBe(true);
    expect(git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/reuse');
  });

  it('recreateWorktree recreates a deleted branch from the original sha (exact)', async () => {
    const wtPath = resolve(scratch, 'wt-sha');
    const originalHeadSha = git(repo, ['rev-parse', 'HEAD']);
    await createWorktree({
      repository: repo,
      branch: 'feat/gone-sha',
      worktreePath: wtPath,
      parentBranch: 'main',
    });
    // Delete the dir AND the branch (prune frees the branch from the worktree).
    await rm(wtPath, { recursive: true, force: true });
    git(repo, ['worktree', 'prune']);
    git(repo, ['branch', '-D', 'feat/gone-sha']);
    expect(git(repo, ['branch', '--list'])).not.toContain('feat/gone-sha');

    const result = await recreateWorktree({
      repository: repo,
      worktreePath: wtPath,
      branch: 'feat/gone-sha',
      originalHeadSha,
    });

    expect((await stat(wtPath)).isDirectory()).toBe(true);
    expect(result.branch).toBe('feat/gone-sha');
    expect(result.baseUsed).toBe(originalHeadSha);
    expect(result.exact).toBe(true);
    expect(git(repo, ['branch', '--list'])).toContain('feat/gone-sha');
  });

  it('recreateWorktree recreates a deleted branch from a default base when no sha (not exact)', async () => {
    const wtPath = resolve(scratch, 'wt-base');
    await createWorktree({
      repository: repo,
      branch: 'feat/gone-base',
      worktreePath: wtPath,
      parentBranch: 'main',
    });
    await rm(wtPath, { recursive: true, force: true });
    git(repo, ['worktree', 'prune']);
    git(repo, ['branch', '-D', 'feat/gone-base']);

    const result = await recreateWorktree({
      repository: repo,
      worktreePath: wtPath,
      branch: 'feat/gone-base',
    });

    expect((await stat(wtPath)).isDirectory()).toBe(true);
    expect(result.branch).toBe('feat/gone-base');
    expect(result.baseUsed).toBe('main'); // detectDefaultBranch (local)
    expect(result.exact).toBe(false);
  });

  it('recreateWorktree falls back to a detached worktree when the branch is checked out elsewhere', async () => {
    const originalHeadSha = git(repo, ['rev-parse', 'HEAD']);
    // A LIVE worktree already holds feat/shared, so it cannot be re-attached.
    const livePath = resolve(scratch, 'wt-live');
    await createWorktree({
      repository: repo,
      branch: 'feat/shared',
      worktreePath: livePath,
      parentBranch: 'main',
    });

    const wtPath = resolve(scratch, 'wt-elsewhere');
    const result = await recreateWorktree({
      repository: repo,
      worktreePath: wtPath,
      branch: 'feat/shared',
      originalHeadSha,
    });

    expect((await stat(wtPath)).isDirectory()).toBe(true);
    expect(result.branch).toBeNull(); // detached, not on the branch
    expect(result.baseUsed).toBe(originalHeadSha);
    expect(result.exact).toBe(true);
    // The live worktree still owns the branch.
    expect(git(livePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/shared');
  });

  it('recreateWorktree creates a detached worktree when no branch is on record', async () => {
    const wtPath = resolve(scratch, 'wt-detached');
    const originalHeadSha = git(repo, ['rev-parse', 'HEAD']);

    const result = await recreateWorktree({
      repository: repo,
      worktreePath: wtPath,
      branch: null,
      originalHeadSha,
    });

    expect((await stat(wtPath)).isDirectory()).toBe(true);
    expect(result.branch).toBeNull();
    expect(result.baseUsed).toBe(originalHeadSha);
    expect(result.exact).toBe(true);
    // Detached HEAD reports the symbolic ref as HEAD.
    expect(git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(git(wtPath, ['rev-parse', 'HEAD'])).toBe(originalHeadSha);
  });
});
