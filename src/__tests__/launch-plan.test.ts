import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { appendSession } from '../dashboard/agent-sessions.js';
import {
  resolveLaunchPlan,
  pickAgent,
  LaunchError,
  buildTerminalInvocation,
  type LaunchPlan,
} from '../launch/index.js';
import {
  BUILTIN_AGENTS,
  type AgentConfig,
  type SyntaurConfig,
} from '../utils/config.js';

const ASSIGNMENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeConfig(overrides: Partial<SyntaurConfig> = {}): SyntaurConfig {
  return {
    version: '1.0',
    defaultProjectDir: '/tmp',
    onboarding: { completed: false },
    agentDefaults: {
      trustLevel: 'medium',
      autoApprove: false,
      autoCreateWorktree: 'ask',
    },
    integrations: {
      claudePluginDir: null,
      codexPluginDir: null,
      codexMarketplacePath: null,
    },
    backup: null,
    statuses: null,
    types: null,
    agents: null,
    playbooks: { disabled: [] },
    theme: null,
    hotkeys: null,
    terminal: 'ghostty',
    ...overrides,
  };
}

describe('pickAgent', () => {
  it('returns the BUILTIN_AGENTS default when agents block is absent', () => {
    const config = makeConfig({ agents: null });
    expect(pickAgent(config).id).toBe('claude');
  });

  it('returns the agent with default: true', () => {
    const agents: AgentConfig[] = [
      { id: 'codex', label: 'Codex', command: 'codex' },
      { id: 'claude', label: 'Claude', command: 'claude', default: true },
    ];
    expect(pickAgent(makeConfig({ agents })).id).toBe('claude');
  });

  it('falls back to the first entry when no default is set', () => {
    const agents: AgentConfig[] = [
      { id: 'codex', label: 'Codex', command: 'codex' },
      { id: 'claude', label: 'Claude', command: 'claude' },
    ];
    expect(pickAgent(makeConfig({ agents })).id).toBe('codex');
  });

  it('throws no-agents-configured for explicitly empty agents: []', () => {
    expect(() => pickAgent(makeConfig({ agents: [] }))).toThrowError(
      expect.objectContaining({ code: 'no-agents-configured' }),
    );
  });
});

describe('resolveLaunchPlan — assignment mode', () => {
  let testDir: string;
  let projectsDir: string;
  let assignmentsDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'syntaur-launch-plan-'));
    projectsDir = resolve(testDir, 'projects');
    assignmentsDir = resolve(testDir, 'assignments');
    await mkdir(projectsDir, { recursive: true });
    await mkdir(assignmentsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('throws assignment-not-found when the id does not resolve', async () => {
    await expect(
      resolveLaunchPlan({
        kind: 'assignment',
        id: 'nonexistent',
        config: makeConfig(),
        projectsDir,
        assignmentsDir,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'assignment-not-found' }),
    );
  });

  it('returns plan with worktreePath as cwd when set', async () => {
    const worktree = resolve(testDir, 'wt');
    await mkdir(worktree, { recursive: true });
    await scaffoldAssignment(
      projectsDir,
      'demo-project',
      'demo-asg',
      ASSIGNMENT_ID,
      { worktreePath: worktree, branch: 'feat/x' },
    );

    const plan = await resolveLaunchPlan({
      kind: 'assignment',
      id: ASSIGNMENT_ID,
      config: makeConfig(),
      projectsDir,
      assignmentsDir,
    });

    expect(plan.cwd).toBe(worktree);
    expect(plan.fallbackWarning).toBeNull();
    expect(plan.agentId).toBe('claude');
    expect(plan.argv.command).toBe('claude');
    expect(plan.argv.args[0]).toContain('Read the current Syntaur assignment');
    expect(plan.terminal).toBe('ghostty');
  });

  it('falls back to repository and emits a warning when worktreePath is missing', async () => {
    const repo = resolve(testDir, 'repo');
    await mkdir(repo, { recursive: true });
    await scaffoldAssignment(
      projectsDir,
      'demo-project',
      'demo-asg',
      ASSIGNMENT_ID,
      { repository: repo },
    );

    const plan = await resolveLaunchPlan({
      kind: 'assignment',
      id: ASSIGNMENT_ID,
      config: makeConfig(),
      projectsDir,
      assignmentsDir,
    });

    expect(plan.cwd).toBe(repo);
    expect(plan.fallbackWarning).toMatch(/worktreePath/);
  });
});

describe('resolveLaunchPlan — session mode', () => {
  let testDir: string;
  let projectsDir: string;
  let assignmentsDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'syntaur-launch-plan-sess-'));
    projectsDir = resolve(testDir, 'projects');
    assignmentsDir = resolve(testDir, 'assignments');
    dbPath = resolve(testDir, 'sessions.db');
    await mkdir(projectsDir, { recursive: true });
    await mkdir(assignmentsDir, { recursive: true });
    resetSessionDb();
    initSessionDb(dbPath);
  });

  afterEach(async () => {
    closeSessionDb();
    await rm(testDir, { recursive: true, force: true });
  });

  it('throws session-not-found for unknown session ids', async () => {
    await expect(
      resolveLaunchPlan({
        kind: 'session',
        id: 'nope',
        config: makeConfig(),
        projectsDir,
        assignmentsDir,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'session-not-found' }),
    );
  });

  it('throws agent-not-configured when session agent is not in the list', async () => {
    await appendSession('', {
      sessionId: 'sess-bogus',
      projectSlug: null,
      assignmentSlug: null,
      agent: 'aider',
      started: '2026-05-17T00:00:00Z',
      status: 'active',
      path: testDir,
    });

    await expect(
      resolveLaunchPlan({
        kind: 'session',
        id: 'sess-bogus',
        config: makeConfig({ agents: [...BUILTIN_AGENTS] }),
        projectsDir,
        assignmentsDir,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'agent-not-configured' }),
    );
  });

  it('uses session.path as cwd for standalone sessions and builds resume argv', async () => {
    await appendSession('', {
      sessionId: 'sess-standalone',
      projectSlug: null,
      assignmentSlug: null,
      agent: 'claude',
      started: '2026-05-17T00:00:00Z',
      status: 'active',
      path: testDir,
    });

    const plan = await resolveLaunchPlan({
      kind: 'session',
      id: 'sess-standalone',
      config: makeConfig(),
      projectsDir,
      assignmentsDir,
    });

    expect(plan.cwd).toBe(testDir);
    expect(plan.argv.command).toBe('claude');
    expect(plan.argv.args).toEqual(['--resume', 'sess-standalone']);
    expect(plan.agentId).toBe('claude');
  });

  it('uses workspace.worktreePath for project sessions via slug lookup', async () => {
    const worktree = resolve(testDir, 'wt2');
    await mkdir(worktree, { recursive: true });
    await scaffoldAssignment(
      projectsDir,
      'demo-project',
      'demo-asg',
      ASSIGNMENT_ID,
      { worktreePath: worktree, branch: 'feat/y' },
    );

    await appendSession('', {
      sessionId: 'sess-proj',
      projectSlug: 'demo-project',
      assignmentSlug: 'demo-asg',
      agent: 'claude',
      started: '2026-05-17T00:00:00Z',
      status: 'active',
      path: '/tmp/somewhere-else',
    });

    const plan = await resolveLaunchPlan({
      kind: 'session',
      id: 'sess-proj',
      config: makeConfig(),
      projectsDir,
      assignmentsDir,
    });

    expect(plan.cwd).toBe(worktree);
    expect(plan.argv.args).toEqual(['--resume', 'sess-proj']);
  });
});

describe('buildTerminalInvocation', () => {
  function makePlan(overrides: Partial<LaunchPlan> = {}): LaunchPlan {
    return {
      terminal: 'terminal-app',
      cwd: '/Users/dev/work',
      argv: { command: 'claude', args: ['--resume', 'sess-1'] },
      env: {},
      agentId: 'claude',
      fallbackWarning: null,
      shellFallbackWarning: null,
      ...overrides,
    };
  }

  it('terminal-app builds an osascript do-script call', () => {
    const inv = buildTerminalInvocation(makePlan({ terminal: 'terminal-app' }));
    expect(inv.command).toBe('osascript');
    expect(inv.args.join(' ')).toContain('tell application "Terminal"');
    expect(inv.args.join(' ')).toContain('do script');
    expect(inv.args.join(' ')).toContain("cd '/Users/dev/work'");
    expect(inv.args.join(' ')).toContain("'--resume' 'sess-1'");
  });

  it('iterm builds an osascript create-window call', () => {
    const inv = buildTerminalInvocation(makePlan({ terminal: 'iterm' }));
    expect(inv.command).toBe('osascript');
    expect(inv.args.join(' ')).toContain('tell application "iTerm"');
    expect(inv.args.join(' ')).toContain('create window with default profile');
    expect(inv.args.join(' ')).toContain('write text');
  });

  it('ghostty builds an osascript new-window + input-text-to-terminal call', () => {
    const inv = buildTerminalInvocation(makePlan({ terminal: 'ghostty' }));
    expect(inv.command).toBe('osascript');
    const script = inv.args.join(' ');
    expect(script).toContain('tell application "Ghostty"');
    expect(script).toContain('new window');
    expect(script).toContain('terminal 1 of selected tab');
    // input text and send key MUST target a terminal, not application scope.
    expect(script).toContain('input text');
    expect(script).toContain('to t');
    expect(script).toContain('send key "enter" to t');
  });

  it('alacritty uses --working-directory + -e', () => {
    const inv = buildTerminalInvocation(makePlan({ terminal: 'alacritty' }));
    expect(inv.command).toBe('alacritty');
    expect(inv.args[0]).toBe('--working-directory');
    expect(inv.args[1]).toBe('/Users/dev/work');
    expect(inv.args[2]).toBe('-e');
    expect(inv.args[3]).toBe('claude');
    expect(inv.args.slice(4)).toEqual(['--resume', 'sess-1']);
  });

  it('warp uses the warp:// new_window URI without a command param', () => {
    const inv = buildTerminalInvocation(makePlan({ terminal: 'warp' }));
    expect(inv.command).toBe('open');
    expect(inv.args[0]).toMatch(/^warp:\/\/action\/new_window\?/);
    expect(inv.args[0]).toContain('path=');
    // Warp's URI scheme does not document a command= param, so we MUST NOT
    // emit one — Warp would either ignore it or error.
    expect(inv.args[0]).not.toContain('command=');
  });

  it('kitty uses --directory + -- separator', () => {
    const inv = buildTerminalInvocation(makePlan({ terminal: 'kitty' }));
    expect(inv.command).toBe('kitty');
    expect(inv.args[0]).toBe('--directory');
    expect(inv.args[1]).toBe('/Users/dev/work');
    expect(inv.args[2]).toBe('--');
    expect(inv.args[3]).toBe('claude');
    expect(inv.args.slice(4)).toEqual(['--resume', 'sess-1']);
  });
});

async function scaffoldAssignment(
  projectsDir: string,
  projectSlug: string,
  assignmentSlug: string,
  id: string,
  workspace: {
    repository?: string | null;
    worktreePath?: string | null;
    branch?: string | null;
    parentBranch?: string | null;
  } = {},
): Promise<void> {
  const projectDir = resolve(projectsDir, projectSlug);
  const assignmentDir = resolve(projectDir, 'assignments', assignmentSlug);
  await mkdir(assignmentDir, { recursive: true });

  // Minimal project.md so the assignment resolves under a known project.
  await writeFile(
    resolve(projectDir, 'project.md'),
    [
      '---',
      `slug: ${projectSlug}`,
      `title: ${projectSlug}`,
      'status: in_progress',
      'created: "2026-01-01T00:00:00Z"',
      'updated: "2026-01-01T00:00:00Z"',
      '---',
      '',
      `# ${projectSlug}`,
      '',
    ].join('\n'),
  );

  await writeFile(
    resolve(assignmentDir, 'assignment.md'),
    [
      '---',
      `id: ${id}`,
      `slug: ${assignmentSlug}`,
      `title: "${assignmentSlug}"`,
      `project: ${projectSlug}`,
      'type: feature',
      'status: in_progress',
      'priority: medium',
      'created: "2026-05-17T00:00:00Z"',
      'updated: "2026-05-17T00:00:00Z"',
      'assignee: null',
      'externalIds: []',
      'dependsOn: []',
      'links: []',
      'blockedReason: null',
      'workspace:',
      `  repository: ${workspace.repository ?? 'null'}`,
      `  worktreePath: ${workspace.worktreePath ?? 'null'}`,
      `  branch: ${workspace.branch ?? 'null'}`,
      `  parentBranch: ${workspace.parentBranch ?? 'null'}`,
      'tags: []',
      '---',
      '',
      `# ${assignmentSlug}`,
      '',
      '## Objective',
      'test',
      '',
      '## Acceptance Criteria',
      '- [ ] test',
      '',
    ].join('\n'),
  );
}
