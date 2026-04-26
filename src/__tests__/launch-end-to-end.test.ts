import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readConfig, getAgents } from '../utils/config.js';
import { launchAgent } from '../tui/launch.js';

/**
 * End-to-end smoke for the launcher path:
 * - reads config (agents block in sandbox HOME)
 * - resolves agent
 * - writes .syntaur/context.json into the workspace
 * - emits fallback warning when workspace.branch is null
 * - spawns the configured command and exits with its code
 *
 * Uses /bin/echo as the agent so the child exits cleanly (code 0).
 * Mocks process.exit to capture the exit code without killing vitest.
 */
describe('launchAgent end-to-end (sandbox HOME, /bin/echo as agent)', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;
  let projectsDir: string;
  let assignmentDir: string;
  let workspaceDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-e2e-'));
    process.env.HOME = homeDir;
    projectsDir = resolve(homeDir, '.syntaur', 'projects');
    workspaceDir = resolve(homeDir, 'wt');
    const projectDir = resolve(projectsDir, 'demo');
    assignmentDir = resolve(projectDir, 'assignments', 'demo-task');
    await mkdir(assignmentDir, { recursive: true });
    await mkdir(resolve(projectDir, 'resources'), { recursive: true });
    await mkdir(resolve(projectDir, 'memories'), { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });

    await writeFile(
      resolve(homeDir, '.syntaur', 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\nagents:\n  - id: echoer\n    label: Echo\n    command: /bin/echo\n---\n`,
    );
    await writeFile(
      resolve(projectDir, 'manifest.md'),
      `---\nslug: demo\ntitle: Demo\ncreated: "2026-04-25T00:00:00Z"\n---\n`,
    );
    await writeFile(
      resolve(projectDir, 'project.md'),
      `---\nslug: demo\ntitle: Demo\nstatus: active\ncreated: "2026-04-25T00:00:00Z"\nupdated: "2026-04-25T00:00:00Z"\n---\n`,
    );

    exitSpy = vi.spyOn(process, 'exit'); // unused — production launchAgent calls process.exit only when onExit is not passed
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    exitSpy.mockRestore();
    warnSpy.mockRestore();
    await rm(homeDir, { recursive: true, force: true });
  });

  async function writeAssignment(branchValue: 'null' | string): Promise<void> {
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      `---\nid: 11111111-1111-1111-1111-111111111111\nslug: demo-task\ntitle: "Demo task"\nproject: demo\ntype: feature\nstatus: in_progress\npriority: medium\ncreated: "2026-04-25T00:00:00Z"\nupdated: "2026-04-25T00:00:00Z"\nassignee: claude\nexternalIds: []\ndependsOn: []\nlinks: []\nblockedReason: null\nworkspace:\n  repository: ${workspaceDir}\n  worktreePath: ${workspaceDir}\n  branch: ${branchValue}\n  parentBranch: main\ntags: []\n---\n# Demo task\n`,
    );
  }

  it('reads config, resolves echoer agent, writes context.json, spawns /bin/echo, exits 0', async () => {
    await writeAssignment('demo-branch');

    const config = await readConfig();
    expect(config.agents).not.toBeNull();
    const agents = getAgents(config);
    expect(agents.map((a) => a.id)).toEqual(['echoer']);
    const echoer = agents.find((a) => a.id === 'echoer')!;
    expect(echoer.command).toBe('/bin/echo');

    let capturedCode: number | null = null;
    await launchAgent({
      projectsDir: config.defaultProjectDir,
      projectSlug: 'demo',
      assignmentSlug: 'demo-task',
      agent: echoer,
      onExit: (code) => {
        capturedCode = code;
      },
    });
    expect(capturedCode).toBe(0);

    const ctx = JSON.parse(
      await readFile(resolve(workspaceDir, '.syntaur', 'context.json'), 'utf-8'),
    );
    expect(ctx).toMatchObject({
      projectSlug: 'demo',
      assignmentSlug: 'demo-task',
      workspaceRoot: workspaceDir,
      branch: 'demo-branch',
      title: 'Demo task',
    });
    // No fallback warning when both worktreePath and branch are set
    const warningCalls = warnSpy.mock.calls
      .map((c) => String(c[0] ?? ''))
      .filter((m) => m.startsWith('syntaur:'));
    expect(warningCalls).toEqual([]);
  });

  it('emits fallback warning when workspace.branch is null but worktreePath is set', async () => {
    await writeAssignment('null');

    const config = await readConfig();
    const echoer = getAgents(config).find((a) => a.id === 'echoer')!;

    let capturedCode: number | null = null;
    await launchAgent({
      projectsDir: config.defaultProjectDir,
      projectSlug: 'demo',
      assignmentSlug: 'demo-task',
      agent: echoer,
      onExit: (code) => {
        capturedCode = code;
      },
    });
    expect(capturedCode).toBe(0);

    const warningCalls = warnSpy.mock.calls
      .map((c) => String(c[0] ?? ''))
      .filter((m) => m.startsWith('syntaur:'));
    expect(warningCalls.length).toBeGreaterThan(0);
    expect(warningCalls[0]).toMatch(/workspace\.branch not set for demo-task/);
    expect(warningCalls[0]).toContain(workspaceDir);
  });
});
