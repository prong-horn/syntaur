import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isExistingDir, resolveLaunchCwd, resolveWorkspaceCwd } from '../launch/cwd.js';
import type { AgentConfig } from '../utils/config.js';

describe('isExistingDir', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-cwd-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('true for an existing absolute directory', () => {
    expect(isExistingDir(dir)).toBe(true);
  });

  it('false for a non-existent path', () => {
    expect(isExistingDir(join(dir, 'nope'))).toBe(false);
  });

  it('false for a relative path', () => {
    expect(isExistingDir('relative/path')).toBe(false);
  });

  it('false for null and empty string', () => {
    expect(isExistingDir(null)).toBe(false);
    expect(isExistingDir('')).toBe(false);
  });

  it('false for a file (not a directory)', async () => {
    const file = join(dir, 'file.txt');
    await writeFile(file, 'x');
    expect(isExistingDir(file)).toBe(false);
  });
});

describe('resolveWorkspaceCwd', () => {
  let base: string;
  let worktree: string;
  let repo: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'syntaur-ws-'));
    worktree = resolve(base, 'wt');
    repo = resolve(base, 'repo');
    await mkdir(worktree, { recursive: true });
    await mkdir(repo, { recursive: true });
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('prefers an existing worktreePath with no warning', () => {
    expect(
      resolveWorkspaceCwd({
        worktreePath: worktree,
        repository: repo,
        branch: 'main',
        assignmentSlug: 'a',
      }),
    ).toEqual({ cwd: worktree, fallbackWarning: null, invalidReason: null });
  });

  it('falls back to repository with a missing-field warning when worktreePath is null', () => {
    const r = resolveWorkspaceCwd({
      worktreePath: null,
      repository: repo,
      branch: 'main',
      assignmentSlug: 'a',
    });
    expect(r.cwd).toBe(repo);
    expect(r.fallbackWarning).toMatch(/worktreePath/);
    expect(r.invalidReason).toBeNull();
  });

  it('falls back to repository with a distinct warning when worktreePath is present but not a real dir', () => {
    const bogus = resolve(base, 'gone');
    const r = resolveWorkspaceCwd({
      worktreePath: bogus,
      repository: repo,
      branch: 'main',
      assignmentSlug: 'a',
    });
    expect(r.cwd).toBe(repo);
    expect(r.fallbackWarning).toContain('is not an existing directory');
    expect(r.fallbackWarning).toContain(bogus);
    expect(r.invalidReason).toBeNull();
  });

  it('returns cwd null + invalidReason when neither worktree nor repo is a real dir', () => {
    const r = resolveWorkspaceCwd({
      worktreePath: resolve(base, 'x'),
      repository: resolve(base, 'y'),
      branch: null,
      assignmentSlug: 'demo',
    });
    expect(r.cwd).toBeNull();
    expect(r.fallbackWarning).toBeNull();
    expect(r.invalidReason).toContain('demo');
    expect(r.invalidReason).toContain('neither is an existing directory');
  });
});

describe('resolveLaunchCwd', () => {
  let base: string;
  let worktree: string;
  let agentDir: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'syntaur-lcwd-'));
    worktree = resolve(base, 'wt');
    agentDir = resolve(base, 'agent');
    await mkdir(worktree, { recursive: true });
    await mkdir(agentDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const agent = (workdir?: string): AgentConfig => ({
    id: 'a',
    label: 'A',
    command: 'pi',
    ...(workdir ? { workdir } : {}),
  });

  it('keeps the worktree as spawnCwd when no workdir is set', () => {
    expect(resolveLaunchCwd(agent(), worktree)).toEqual({
      spawnCwd: worktree,
      worktreePath: worktree,
      invalidReason: null,
    });
  });

  it('overrides spawnCwd with an existing workdir, preserving the worktree path', () => {
    expect(resolveLaunchCwd(agent(agentDir), worktree)).toEqual({
      spawnCwd: agentDir,
      worktreePath: worktree,
      invalidReason: null,
    });
  });

  it('expands a leading ~ in workdir', () => {
    const originalHome = process.env.HOME;
    process.env.HOME = base;
    try {
      // base/agent exists; '~/agent' should expand to it.
      const r = resolveLaunchCwd(agent('~/agent'), worktree);
      expect(r.spawnCwd).toBe(agentDir);
      expect(r.invalidReason).toBeNull();
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('reports invalidReason for a non-existent workdir (no throw)', () => {
    const r = resolveLaunchCwd(agent(resolve(base, 'gone')), worktree);
    expect(r.invalidReason).toContain('is not an existing directory');
    expect(r.spawnCwd).toBe(worktree);
  });
});
