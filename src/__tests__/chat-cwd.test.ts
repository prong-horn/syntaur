import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveChatCwd } from '../chat/chat-cwd.js';

describe('resolveChatCwd', () => {
  let base: string;
  let worktree: string;
  let repo: string;
  let projectRepo: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'syntaur-chat-cwd-'));
    worktree = resolve(base, 'wt');
    repo = resolve(base, 'repo');
    projectRepo = resolve(base, 'proj-repo');
    await mkdir(worktree, { recursive: true });
    await mkdir(repo, { recursive: true });
    await mkdir(projectRepo, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('prefers worktreePath → tier worktree', () => {
    const r = resolveChatCwd({
      worktreePath: worktree,
      repository: repo,
      branch: 'main',
      assignmentSlug: 'a',
      projectRepositories: [projectRepo],
    });
    expect(r.cwd).toBe(worktree);
    expect(r.tier).toBe('worktree');
    expect(r.fallbackWarning).toBeNull();
  });

  it('falls back to repository → tier repository', () => {
    const r = resolveChatCwd({
      worktreePath: null,
      repository: repo,
      branch: 'main',
      assignmentSlug: 'a',
      projectRepositories: [projectRepo],
    });
    expect(r.cwd).toBe(repo);
    expect(r.tier).toBe('repository');
  });

  it('falls back to project repository → tier project', () => {
    const r = resolveChatCwd({
      worktreePath: null,
      repository: null,
      branch: null,
      assignmentSlug: 'a',
      projectRepositories: [projectRepo],
    });
    expect(r.cwd).toBe(projectRepo);
    expect(r.tier).toBe('project');
    expect(r.fallbackWarning).toMatch(/project repository/);
  });

  it('falls back to homedir → tier home', () => {
    const r = resolveChatCwd({
      worktreePath: null,
      repository: null,
      branch: null,
      assignmentSlug: 'a',
      projectRepositories: [],
    });
    expect(r.cwd).toBe(homedir());
    expect(r.tier).toBe('home');
    expect(r.fallbackWarning).toMatch(/home directory/);
  });

  it('skips non-existent project repositories', () => {
    const r = resolveChatCwd({
      worktreePath: null,
      repository: null,
      branch: null,
      assignmentSlug: 'a',
      projectRepositories: [resolve(base, 'gone'), resolve(base, 'also-gone')],
    });
    expect(r.cwd).toBe(homedir());
    expect(r.tier).toBe('home');
  });

  it('uses first existing project repository when multiple are given', () => {
    const r = resolveChatCwd({
      worktreePath: null,
      repository: null,
      branch: null,
      assignmentSlug: 'a',
      projectRepositories: [resolve(base, 'gone'), projectRepo],
    });
    expect(r.cwd).toBe(projectRepo);
    expect(r.tier).toBe('project');
  });

  it('worktree beats repository beats project beats home', () => {
    // All four exist, worktree wins
    const r = resolveChatCwd({
      worktreePath: worktree,
      repository: repo,
      branch: 'main',
      assignmentSlug: 'a',
      projectRepositories: [projectRepo],
    });
    expect(r.tier).toBe('worktree');
  });
});
