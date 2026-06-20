import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  resolveLaunchPrompt,
  effectiveLaunchTemplate,
  type LaunchPlan,
} from '../launch/index.js';
import {
  BUILTIN_AGENTS,
  type AgentConfig,
  type SyntaurConfig,
} from '../utils/config.js';

// Pin resolveCmuxCli so buildTerminalInvocation's cmux case is deterministic
// regardless of whether the host has cmux installed (otherwise the resolved CLI
// path embedded in the invocation would differ by host). probeTerminalInstalled
// and the rest of terminal-probe stay real via importOriginal.
const CMUX_CLI = '/Applications/cmux.app/Contents/Resources/bin/cmux';
vi.mock('../utils/terminal-probe.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/terminal-probe.js')>();
  return { ...actual, resolveCmuxCli: () => CMUX_CLI };
});

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
    // Project-nested assignments use `/grab-assignment <project> <slug>`.
    expect(plan.argv.args[0]).toBe('/grab-assignment demo-project demo-asg');
    expect(plan.terminal).toBe('ghostty');
  });

  it('routes agent.launchPrompt through the resolver and threads promptWarnings', async () => {
    const worktree = resolve(testDir, 'wt-lp');
    await mkdir(worktree, { recursive: true });
    await scaffoldAssignment(projectsDir, 'demo-project', 'demo-asg', ASSIGNMENT_ID, {
      worktreePath: worktree,
      branch: 'feat/x',
    });
    const agents: AgentConfig[] = [
      {
        id: 'claude',
        label: 'Claude',
        command: 'claude',
        default: true,
        launchPrompt: '@assignment Then @FOO please.',
      },
    ];

    const plan = await resolveLaunchPlan({
      kind: 'assignment',
      id: ASSIGNMENT_ID,
      config: makeConfig({ agents }),
      projectsDir,
      assignmentsDir,
    });

    // @assignment expanded to the records pointer (id + grab/read instructions).
    expect(plan.argv.args[0]).toContain(ASSIGNMENT_ID);
    expect(plan.argv.args[0]).toContain('/grab-assignment skill if available');
    // Malformed @FOO left literal and threaded as exactly one prompt warning.
    expect(plan.argv.args[0]).toContain('@FOO');
    expect(plan.promptWarnings).toHaveLength(1);
    expect(plan.promptWarnings?.[0]).toContain('@FOO');
  });

  it('honors a promptOverride — re-resolves it as the template (presence-based)', async () => {
    const worktree = resolve(testDir, 'wt-override');
    await mkdir(worktree, { recursive: true });
    await scaffoldAssignment(projectsDir, 'demo-project', 'demo-asg', ASSIGNMENT_ID, {
      worktreePath: worktree,
      branch: 'feat/x',
    });
    const agents: AgentConfig[] = [
      { id: 'claude', label: 'Claude', command: 'claude', default: true, launchPrompt: '@assignment stored.' },
    ];
    const plan = await resolveLaunchPlan({
      kind: 'assignment',
      id: ASSIGNMENT_ID,
      config: makeConfig({ agents }),
      projectsDir,
      assignmentsDir,
      promptOverride: '@assignment Then @FOO go.',
    });
    expect(plan.argv.args[0]).toContain(ASSIGNMENT_ID); // @assignment in the override re-resolved
    expect(plan.argv.args[0]).toContain('@FOO'); // malformed token left literal
    expect(plan.argv.args[0]).not.toContain('stored.'); // override replaced the stored template
    expect(plan.promptWarnings).toHaveLength(1);
  });

  it('an empty promptOverride falls back to the seed (never reuses agent.launchPrompt)', async () => {
    const worktree = resolve(testDir, 'wt-empty');
    await mkdir(worktree, { recursive: true });
    await scaffoldAssignment(projectsDir, 'demo-project', 'demo-asg', ASSIGNMENT_ID, {
      worktreePath: worktree,
      branch: 'feat/x',
    });
    const agents: AgentConfig[] = [
      { id: 'claude', label: 'Claude', command: 'claude', default: true, launchPrompt: '@assignment stored.' },
    ];
    const plan = await resolveLaunchPlan({
      kind: 'assignment',
      id: ASSIGNMENT_ID,
      config: makeConfig({ agents }),
      projectsDir,
      assignmentsDir,
      promptOverride: '',
    });
    // Empty template → resolver fallback chain → bare grab seed (NOT 'stored.').
    expect(plan.argv.args[0]).toBe('/grab-assignment demo-project demo-asg');
  });

  it('uses the requested agentId instead of the default', async () => {
    const worktree = resolve(testDir, 'wt-agent');
    await mkdir(worktree, { recursive: true });
    await scaffoldAssignment(projectsDir, 'demo-project', 'demo-asg', ASSIGNMENT_ID, {
      worktreePath: worktree,
      branch: 'feat/x',
    });
    const agents: AgentConfig[] = [
      { id: 'codex', label: 'Codex', command: 'codex' },
      { id: 'claude', label: 'Claude', command: 'claude', default: true },
    ];

    const plan = await resolveLaunchPlan({
      kind: 'assignment',
      id: ASSIGNMENT_ID,
      config: makeConfig({ agents }),
      projectsDir,
      assignmentsDir,
      agentId: 'codex',
    });

    expect(plan.agentId).toBe('codex');
    expect(plan.argv.command).toBe('codex');
  });

  it('falls back to the default agent when agentId is omitted', async () => {
    const worktree = resolve(testDir, 'wt-default');
    await mkdir(worktree, { recursive: true });
    await scaffoldAssignment(projectsDir, 'demo-project', 'demo-asg', ASSIGNMENT_ID, {
      worktreePath: worktree,
      branch: 'feat/x',
    });
    const agents: AgentConfig[] = [
      { id: 'codex', label: 'Codex', command: 'codex' },
      { id: 'claude', label: 'Claude', command: 'claude', default: true },
    ];

    const plan = await resolveLaunchPlan({
      kind: 'assignment',
      id: ASSIGNMENT_ID,
      config: makeConfig({ agents }),
      projectsDir,
      assignmentsDir,
    });

    expect(plan.agentId).toBe('claude');
  });

  it('throws agent-not-configured for an unknown agentId', async () => {
    const worktree = resolve(testDir, 'wt-unknown');
    await mkdir(worktree, { recursive: true });
    await scaffoldAssignment(projectsDir, 'demo-project', 'demo-asg', ASSIGNMENT_ID, {
      worktreePath: worktree,
      branch: 'feat/x',
    });

    await expect(
      resolveLaunchPlan({
        kind: 'assignment',
        id: ASSIGNMENT_ID,
        config: makeConfig(),
        projectsDir,
        assignmentsDir,
        agentId: 'ghost',
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'agent-not-configured' }),
    );
  });

  it('threads the agent profile model + playbook into the launch', async () => {
    const worktree = resolve(testDir, 'wt-profile');
    await mkdir(worktree, { recursive: true });
    await scaffoldAssignment(projectsDir, 'demo-project', 'demo-asg', ASSIGNMENT_ID, {
      worktreePath: worktree,
      branch: 'feat/x',
    });
    const agents: AgentConfig[] = [
      {
        id: 'claude',
        label: 'Claude',
        command: 'claude',
        default: true,
        model: 'opus',
        playbook: 'e2e-dev-cycle',
      },
    ];

    const plan = await resolveLaunchPlan({
      kind: 'assignment',
      id: ASSIGNMENT_ID,
      config: makeConfig({ agents }),
      projectsDir,
      assignmentsDir,
    });

    // Playbook → instruction-style seed chaining grab + run-playbook.
    expect(plan.argv.args[0]).toContain('/grab-assignment');
    expect(plan.argv.args[0]).toContain('/run-playbook');
    expect(plan.argv.args[0]).toContain('e2e-dev-cycle');
    // Model → --model opus injected.
    expect(plan.argv.args).toContain('--model');
    expect(plan.argv.args).toContain('opus');
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

  it('falls back to repository when worktreePath is set but not an existing directory', async () => {
    const repo = resolve(testDir, 'repo-valid');
    await mkdir(repo, { recursive: true });
    await scaffoldAssignment(
      projectsDir,
      'demo-project',
      'demo-asg',
      ASSIGNMENT_ID,
      {
        worktreePath: resolve(testDir, 'missing-worktree'),
        repository: repo,
        branch: 'feat/x',
      },
    );

    const plan = await resolveLaunchPlan({
      kind: 'assignment',
      id: ASSIGNMENT_ID,
      config: makeConfig(),
      projectsDir,
      assignmentsDir,
    });

    expect(plan.cwd).toBe(repo);
    expect(plan.fallbackWarning).toContain('is not an existing directory');
  });

  it('throws workspace-path-invalid when neither worktreePath nor repository is a real directory', async () => {
    await scaffoldAssignment(
      projectsDir,
      'demo-project',
      'demo-asg',
      ASSIGNMENT_ID,
      {
        worktreePath: resolve(testDir, 'no-worktree'),
        repository: resolve(testDir, 'no-repo'),
        branch: 'feat/x',
      },
    );

    await expect(
      resolveLaunchPlan({
        kind: 'assignment',
        id: ASSIGNMENT_ID,
        config: makeConfig(),
        projectsDir,
        assignmentsDir,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'workspace-path-invalid' }),
    );
  });

  it('honors terminalOverride over the configured terminal', async () => {
    const worktree = resolve(testDir, 'worktree-override');
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
      config: makeConfig({ terminal: 'ghostty' }),
      projectsDir,
      assignmentsDir,
      terminalOverride: 'iterm',
    });

    expect(plan.terminal).toBe('iterm');
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

  it('falls back to workspace.worktreePath when session.path no longer exists', async () => {
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
      // Intentionally a NON-existent dir: session.path is gone, so the launch
      // must fall back to the assignment's worktree. (When session.path exists,
      // it wins — see the split-cwd test below.)
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

  it('uses session.path (not the assignment worktree) when both exist and differ', async () => {
    // The regression case for the split-cwd bug: a session started in one cwd
    // (e.g. the repo root) while the assignment's CURRENT worktree is elsewhere.
    // The session's own cwd is where its transcript is indexed, so it must win —
    // otherwise both sessions on the assignment collapse onto one transcript.
    const worktree = resolve(testDir, 'assignment-worktree');
    const sessionCwd = resolve(testDir, 'session-own-cwd');
    await mkdir(worktree, { recursive: true });
    await mkdir(sessionCwd, { recursive: true });
    await scaffoldAssignment(
      projectsDir,
      'demo-project',
      'demo-asg',
      ASSIGNMENT_ID,
      { worktreePath: worktree, branch: 'feat/y' },
    );

    await appendSession('', {
      sessionId: 'sess-split-cwd',
      projectSlug: 'demo-project',
      assignmentSlug: 'demo-asg',
      agent: 'claude',
      started: '2026-05-17T00:00:00Z',
      status: 'active',
      path: sessionCwd,
    });

    const plan = await resolveLaunchPlan({
      kind: 'session',
      id: 'sess-split-cwd',
      config: makeConfig(),
      projectsDir,
      assignmentsDir,
    });

    expect(plan.cwd).toBe(sessionCwd);
    expect(plan.cwd).not.toBe(worktree);
    expect(plan.argv.args).toEqual(['--resume', 'sess-split-cwd']);
  });

  it('fork from a split-cwd session also launches from session.path', async () => {
    const worktree = resolve(testDir, 'assignment-worktree-fork');
    const sessionCwd = resolve(testDir, 'session-own-cwd-fork');
    await mkdir(worktree, { recursive: true });
    await mkdir(sessionCwd, { recursive: true });
    await scaffoldAssignment(
      projectsDir,
      'demo-project',
      'demo-asg',
      ASSIGNMENT_ID,
      { worktreePath: worktree, branch: 'feat/y' },
    );

    await appendSession('', {
      sessionId: 'sess-split-fork',
      projectSlug: 'demo-project',
      assignmentSlug: 'demo-asg',
      agent: 'claude',
      started: '2026-05-17T00:00:00Z',
      status: 'active',
      path: sessionCwd,
    });

    const plan = await resolveLaunchPlan({
      kind: 'session',
      id: 'sess-split-fork',
      mode: 'fork',
      config: makeConfig(),
      projectsDir,
      assignmentsDir,
    });

    expect(plan.cwd).toBe(sessionCwd);
    expect(plan.argv.args).toEqual(['--resume', 'sess-split-fork', '--fork-session']);
  });

  it('standalone session with invalid session.path falls back to the standalone assignment worktree', async () => {
    // Standalone parity: project_slug IS NULL and assignment_slug holds the
    // assignment UUID, resolved via getAssignmentDetailById. When session.path
    // is gone, the launch must still recover the assignment's worktree cwd —
    // matching resolveRecreateTarget's standalone handling.
    const id = 'bbbb2222-cccc-3333-dddd-444455556666';
    const worktree = resolve(testDir, 'standalone-wt');
    await mkdir(worktree, { recursive: true });
    await scaffoldStandaloneAssignment(assignmentsDir, id, {
      worktreePath: worktree,
      branch: 'feat/solo',
    });

    await appendSession('', {
      sessionId: 'sess-standalone-fallback',
      projectSlug: null,
      assignmentSlug: id, // standalone: assignment_slug holds the UUID
      agent: 'claude',
      started: '2026-06-01T00:00:00Z',
      status: 'active',
      path: resolve(testDir, 'gone-standalone-cwd'), // non-existent
    });

    const plan = await resolveLaunchPlan({
      kind: 'session',
      id: 'sess-standalone-fallback',
      config: makeConfig(),
      projectsDir,
      assignmentsDir,
    });

    expect(plan.cwd).toBe(worktree);
    expect(plan.argv.args).toEqual(['--resume', 'sess-standalone-fallback']);
  });

  it('empty session.path falls back to the assignment worktree', async () => {
    // A session row with path '' (never recorded a cwd). isExistingDir('') is
    // false, so it must take the fallback rather than launching in cwd ''.
    const worktree = resolve(testDir, 'empty-path-wt');
    await mkdir(worktree, { recursive: true });
    await scaffoldAssignment(
      projectsDir,
      'demo-project',
      'demo-asg',
      ASSIGNMENT_ID,
      { worktreePath: worktree, branch: 'feat/y' },
    );

    await appendSession('', {
      sessionId: 'sess-empty-path',
      projectSlug: 'demo-project',
      assignmentSlug: 'demo-asg',
      agent: 'claude',
      started: '2026-05-17T00:00:00Z',
      status: 'active',
      path: '',
    });

    const plan = await resolveLaunchPlan({
      kind: 'session',
      id: 'sess-empty-path',
      config: makeConfig(),
      projectsDir,
      assignmentsDir,
    });

    expect(plan.cwd).toBe(worktree);
    expect(plan.argv.args).toEqual(['--resume', 'sess-empty-path']);
  });

  it('keeps the (invalid) session.path when there is no linked assignment', async () => {
    // No project/assignment link and a non-existent path → no fallback source
    // exists, so the launch must NOT throw; it keeps the recorded session.path.
    const gonePath = resolve(testDir, 'gone-unlinked');
    await appendSession('', {
      sessionId: 'sess-unlinked-invalid',
      projectSlug: null,
      assignmentSlug: null,
      agent: 'claude',
      started: '2026-05-17T00:00:00Z',
      status: 'active',
      path: gonePath,
    });

    const plan = await resolveLaunchPlan({
      kind: 'session',
      id: 'sess-unlinked-invalid',
      config: makeConfig(),
      projectsDir,
      assignmentsDir,
    });

    expect(plan.cwd).toBe(gonePath);
    expect(plan.argv.args).toEqual(['--resume', 'sess-unlinked-invalid']);
  });

  it('falls back to session.path (no throw) when the assignment workspace is invalid', async () => {
    // Assignment exists but its workspace points at non-existent paths.
    await scaffoldAssignment(
      projectsDir,
      'demo-project',
      'demo-asg',
      ASSIGNMENT_ID,
      {
        worktreePath: resolve(testDir, 'gone-worktree'),
        repository: resolve(testDir, 'gone-repo'),
        branch: 'feat/z',
      },
    );

    await appendSession('', {
      sessionId: 'sess-invalid-ws',
      projectSlug: 'demo-project',
      assignmentSlug: 'demo-asg',
      agent: 'claude',
      started: '2026-05-17T00:00:00Z',
      status: 'active',
      path: testDir, // a real directory
    });

    // Unlike assignment launches, session launches must NOT throw — they keep
    // the recorded session.path rather than failing.
    const plan = await resolveLaunchPlan({
      kind: 'session',
      id: 'sess-invalid-ws',
      config: makeConfig(),
      projectsDir,
      assignmentsDir,
    });

    expect(plan.cwd).toBe(testDir);
    expect(plan.argv.args).toEqual(['--resume', 'sess-invalid-ws']);
  });

  it('threads mode=fork through to argv', async () => {
    await appendSession('', {
      sessionId: 'sess-fork',
      projectSlug: null,
      assignmentSlug: null,
      agent: 'claude',
      started: '2026-05-19T00:00:00Z',
      status: 'active',
      path: testDir,
    });

    const plan = await resolveLaunchPlan({
      kind: 'session',
      id: 'sess-fork',
      mode: 'fork',
      config: makeConfig(),
      projectsDir,
      assignmentsDir,
    });

    expect(plan.argv.args).toEqual(['--resume', 'sess-fork', '--fork-session']);
  });

  it('inherits builtin resume for a claude agent overridden without resume/fork', async () => {
    await appendSession('', {
      sessionId: 'sess-override',
      projectSlug: null,
      assignmentSlug: null,
      agent: 'claude',
      started: '2026-05-19T00:00:00Z',
      status: 'active',
      path: testDir,
    });

    // User config overrides `claude` but omits resume/fork (e.g. saved via the
    // dashboard agent editor, which drops those fields). getAgents must inherit
    // the builtin resume so the deep-link launch resolves instead of throwing
    // mode-not-supported.
    const plan = await resolveLaunchPlan({
      kind: 'session',
      id: 'sess-override',
      mode: 'resume',
      config: makeConfig({
        agents: [{ id: 'claude', label: 'My Claude', command: 'claude', default: true }],
      }),
      projectsDir,
      assignmentsDir,
    });

    expect(plan.argv.command).toBe('claude');
    expect(plan.argv.args).toEqual(['--resume', 'sess-override']);
    expect(plan.agentId).toBe('claude');
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

  it('terminal-app avoids the cold-start blank window (reuses launch window when not running)', () => {
    const inv = buildTerminalInvocation(makePlan({ terminal: 'terminal-app' }));
    const script = inv.args.join('\n');
    // Running state captured BEFORE the tell block so checking it does not
    // launch Terminal.
    expect(script).toContain('set wasRunning to application "Terminal" is running');
    expect(script.indexOf('set wasRunning')).toBeLessThan(
      script.indexOf('tell application "Terminal"'),
    );
    // Cold start reuses the blank launch window instead of opening a second.
    expect(script).toContain('if wasRunning then');
    expect(script).toContain('in window 1');
  });

  it('iterm builds an osascript create-window call', () => {
    const inv = buildTerminalInvocation(makePlan({ terminal: 'iterm' }));
    expect(inv.command).toBe('osascript');
    expect(inv.args.join(' ')).toContain('tell application "iTerm"');
    expect(inv.args.join(' ')).toContain('create window with default profile');
    expect(inv.args.join(' ')).toContain('write text');
  });

  it('ghostty activates + drives via System Events keystrokes (cmd-n, type, return)', () => {
    // Ghostty's AppleScript dictionary doesn't actually expose
    // `new window` / `terminal` / `input text` as usable verbs — calls
    // fail at runtime. We drive the app via synthesized key events
    // through System Events instead.
    const inv = buildTerminalInvocation(makePlan({ terminal: 'ghostty' }));
    expect(inv.command).toBe('osascript');
    const script = inv.args.join(' ');
    expect(script).toContain('tell application "Ghostty" to activate');
    expect(script).toContain('tell application "System Events"');
    expect(script).toContain('keystroke "n" using command down');
    // The command itself is typed via keystroke (not `input text`).
    expect(script).toContain('keystroke');
    // Return key — key code 36 is more layout-agnostic than `keystroke return`.
    expect(script).toContain('key code 36');
    expect(script).not.toContain('input text');
    expect(script).not.toContain('terminal 1 of selected tab');
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

  it('cmux launches via a /bin/sh cold-start wrapper around `workspace create`', () => {
    const inv = buildTerminalInvocation(makePlan({ terminal: 'cmux' }));
    // Single monitored spawn: /bin/sh -c <script> <$0> <cli> <cwd> <command>.
    expect(inv.command).toBe('/bin/sh');
    expect(inv.args[0]).toBe('-c');
    const script = inv.args[1];
    // The script launches cmux if needed, awaits socket readiness, then creates
    // the workspace and sends the agent command to it.
    expect(script).toContain('open -b com.cmuxterm.app');
    expect(script).toContain('"$1" ping');
    expect(script).toContain(
      'workspace create --cwd "$2" --command "$3" --focus true',
    );
    // Positional args ($1=cli, $2=cwd, $3=command) — no second shell-quoting.
    expect(inv.args[3]).toBe(CMUX_CLI);
    expect(inv.args[4]).toBe('/Users/dev/work');
    expect(inv.args[5]).toBe("'claude' '--resume' 'sess-1'");
  });

  it('cmux shell-quotes the command arg (spaces and apostrophes)', () => {
    const inv = buildTerminalInvocation(
      makePlan({
        terminal: 'cmux',
        argv: { command: 'claude', args: ["it's", 'a b'] },
      }),
    );
    // $3 is the command text cmux types into the new workspace's shell.
    expect(inv.args[5]).toBe("'claude' 'it'\\''s' 'a b'");
  });
});

describe('effectiveLaunchTemplate (prefill template form)', () => {
  const base = { projectSlug: 'proj' as string | null, assignmentSlug: 'asg', id: 'idX' };
  const resolveCtx = { ...base, assignmentDir: '/recs' };

  it('returns launchPrompt verbatim (untrimmed) when set', () => {
    expect(
      effectiveLaunchTemplate({ launchPrompt: '  @assignment hi  ', playbook: 'e2e-dev-cycle', ...base }),
    ).toBe('  @assignment hi  ');
  });

  it('returns the bare grab seed when neither launchPrompt nor playbook is set', () => {
    expect(effectiveLaunchTemplate({ ...base })).toBe('/grab-assignment proj asg');
  });

  // The synth template's playbook clause is LITERAL (only @assignment is a token),
  // so re-resolving it reproduces Phase A's synth byte-for-byte regardless of
  // whether the slug is installed — for any playbook, including the reserved name.
  it.each(['e2e-dev-cycle', 'not-installed', 'assignment'])(
    'synth template for playbook=%s re-resolves to Phase A synth (installed OR not)',
    (pb) => {
      const template = effectiveLaunchTemplate({ playbook: pb, ...base });
      const phaseASynth = resolveLaunchPrompt({ playbook: pb, ...resolveCtx }).prompt;
      const reInstalled = resolveLaunchPrompt({ template, knownPlaybookSlugs: new Set([pb]), ...resolveCtx }).prompt;
      const reUninstalled = resolveLaunchPrompt({ template, knownPlaybookSlugs: new Set(), ...resolveCtx }).prompt;
      expect(reInstalled).toBe(phaseASynth);
      expect(reUninstalled).toBe(phaseASynth);
    },
  );
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

/**
 * Scaffold a STANDALONE assignment under `assignmentsDir/<uuid>/assignment.md`
 * (`project: null`), resolvable by id via `getAssignmentDetailById` — the shape
 * a standalone session links to (its `assignment_slug` holds this UUID). Mirrors
 * the fixture used by `dashboard-api-session-recreate.test.ts`.
 */
async function scaffoldStandaloneAssignment(
  assignmentsDir: string,
  id: string,
  workspace: {
    repository?: string | null;
    worktreePath?: string | null;
    branch?: string | null;
    parentBranch?: string | null;
  } = {},
): Promise<void> {
  const soloDir = resolve(assignmentsDir, id);
  await mkdir(soloDir, { recursive: true });
  await writeFile(
    resolve(soloDir, 'assignment.md'),
    [
      '---',
      `id: ${id}`,
      'slug: solo-task',
      'title: "Solo Task"',
      'project: null',
      'type: feature',
      'status: in_progress',
      'priority: medium',
      'created: "2026-06-01T00:00:00Z"',
      'updated: "2026-06-01T00:00:00Z"',
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
      '# Solo Task',
      '',
    ].join('\n'),
  );
}
