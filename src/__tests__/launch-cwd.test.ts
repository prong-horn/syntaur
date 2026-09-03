import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveLaunchCwd } from '../launch/cwd.js';
import type { AgentConfig } from '../utils/config.js';

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
