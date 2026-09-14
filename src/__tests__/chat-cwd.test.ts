import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveChatCwd } from '../chat/chat-cwd.js';
import { profileForTier, resolveSessionProfile } from '../chat/profile.js';
import { HARNESSES } from '../chat/harnesses.js';
import type { AgentDefinition } from '../chat/types.js';

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

  it('prefers worktree → tier worktree', () => {
    const r = resolveChatCwd({
      worktree: worktree,
      repository: repo,
      branch: 'main',
      ticketSlug: 'a',
      projectRepositories: [projectRepo],
    });
    expect(r.cwd).toBe(worktree);
    expect(r.tier).toBe('worktree');
    expect(r.fallbackWarning).toBeNull();
  });

  it('falls back to repository → tier repository', () => {
    const r = resolveChatCwd({
      worktree: null,
      repository: repo,
      branch: 'main',
      ticketSlug: 'a',
      projectRepositories: [projectRepo],
    });
    expect(r.cwd).toBe(repo);
    expect(r.tier).toBe('repository');
  });

  it('falls back to project repository → tier project', () => {
    const r = resolveChatCwd({
      worktree: null,
      repository: null,
      branch: null,
      ticketSlug: 'a',
      projectRepositories: [projectRepo],
    });
    expect(r.cwd).toBe(projectRepo);
    expect(r.tier).toBe('project');
    expect(r.fallbackWarning).toMatch(/project repository/);
  });

  it('falls back to homedir → tier home', () => {
    const r = resolveChatCwd({
      worktree: null,
      repository: null,
      branch: null,
      ticketSlug: 'a',
      projectRepositories: [],
    });
    expect(r.cwd).toBe(homedir());
    expect(r.tier).toBe('home');
    expect(r.fallbackWarning).toMatch(/home directory/);
  });

  it('skips non-existent project repositories', () => {
    const r = resolveChatCwd({
      worktree: null,
      repository: null,
      branch: null,
      ticketSlug: 'a',
      projectRepositories: [resolve(base, 'gone'), resolve(base, 'also-gone')],
    });
    expect(r.cwd).toBe(homedir());
    expect(r.tier).toBe('home');
  });

  it('uses first existing project repository when multiple are given', () => {
    const r = resolveChatCwd({
      worktree: null,
      repository: null,
      branch: null,
      ticketSlug: 'a',
      projectRepositories: [resolve(base, 'gone'), projectRepo],
    });
    expect(r.cwd).toBe(projectRepo);
    expect(r.tier).toBe('project');
  });

  it('worktree beats repository beats project beats home', () => {
    // All four exist, worktree wins
    const r = resolveChatCwd({
      worktree: worktree,
      repository: repo,
      branch: 'main',
      ticketSlug: 'a',
      projectRepositories: [projectRepo],
    });
    expect(r.tier).toBe('worktree');
  });
});

describe('profileForTier', () => {
  const definition = (mode?: string): AgentDefinition => ({
    id: 'claude',
    name: 'Claude',
    color: 'violet',
    harness: 'claude',
    ...(mode ? { mode } : {}),
    respondsTo: 'mentions',
    default: true,
    systemPrompt: '',
    source: null,
  });

  it('pins `ask` at the home tier when the definition leaves mode unset', () => {
    const profile = resolveSessionProfile(definition(), HARNESSES.claude);
    expect(profile.mode.kind).toBe('inherit');
    const effective = profileForTier(profile, 'home');
    expect(effective.mode).toEqual({ kind: 'pinned', value: 'ask' });
    // Pure: the session's own profile is untouched, so a later worktree tier
    // gets the definition's mode back.
    expect(profile.mode.kind).toBe('inherit');
  });

  it('keeps a pinned mode at the home tier and leaves other tiers alone', () => {
    const pinned = resolveSessionProfile(definition('edits'), HARNESSES.claude);
    expect(profileForTier(pinned, 'home')).toBe(pinned);
    const inherit = resolveSessionProfile(definition(), HARNESSES.claude);
    for (const tier of ['worktree', 'repository', 'project', null] as const) {
      expect(profileForTier(inherit, tier)).toBe(inherit);
    }
  });
});
