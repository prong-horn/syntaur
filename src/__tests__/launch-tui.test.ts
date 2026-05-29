import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { launchAgent } from '../tui/launch.js';
import type { AgentConfig } from '../utils/config.js';

const AGENT: AgentConfig = {
  id: 'echoer',
  label: 'Echo',
  command: '/bin/echo',
  default: true,
};

interface SpawnCall {
  command: string;
  args: string[];
  cwd: unknown;
}

/** Fake spawn that records the invocation and immediately "exits" with 0. */
function fakeSpawn(calls: SpawnCall[]) {
  return ((command: string, args: readonly string[], options: { cwd?: unknown }) => {
    calls.push({ command, args: [...args], cwd: options.cwd });
    const child = new EventEmitter() as unknown as ChildProcess;
    // Emit after the .on('exit') handler is attached (synchronously, in the
    // Promise executor) so launchAgent's promise resolves.
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
}

async function writeAssignment(
  projectsDir: string,
  projectSlug: string,
  assignmentSlug: string,
  ws: {
    repository?: string | null;
    worktreePath?: string | null;
    branch?: string | null;
  },
): Promise<void> {
  const projectDir = resolve(projectsDir, projectSlug);
  const assignmentDir = resolve(projectDir, 'assignments', assignmentSlug);
  await mkdir(assignmentDir, { recursive: true });
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
      'id: 11111111-1111-1111-1111-111111111111',
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
      `  repository: ${ws.repository ?? 'null'}`,
      `  worktreePath: ${ws.worktreePath ?? 'null'}`,
      `  branch: ${ws.branch ?? 'null'}`,
      '  parentBranch: null',
      'tags: []',
      '---',
      '',
      `# ${assignmentSlug}`,
      '',
      '## Objective',
      'test',
      '',
    ].join('\n'),
  );
}

describe('launchAgent — validated cwd resolution', () => {
  let testDir: string;
  let projectsDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'syntaur-launch-tui-'));
    projectsDir = resolve(testDir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    warnSpy.mockRestore();
    errSpy.mockRestore();
    await rm(testDir, { recursive: true, force: true });
  });

  it('spawns with the worktree as cwd when it exists', async () => {
    const worktree = resolve(testDir, 'wt');
    await mkdir(worktree, { recursive: true });
    await writeAssignment(projectsDir, 'demo', 'task', {
      worktreePath: worktree,
      branch: 'feat/x',
    });

    const calls: SpawnCall[] = [];
    let code = -1;
    await launchAgent({
      projectsDir,
      projectSlug: 'demo',
      assignmentSlug: 'task',
      agent: AGENT,
      spawnFn: fakeSpawn(calls),
      onExit: (c) => {
        code = c;
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(worktree);
    expect(code).toBe(0);
  });

  it('falls back to repository (with a warning) when the worktree path does not exist', async () => {
    const repo = resolve(testDir, 'repo');
    await mkdir(repo, { recursive: true });
    await writeAssignment(projectsDir, 'demo', 'task', {
      repository: repo,
      worktreePath: resolve(testDir, 'missing-wt'),
      branch: 'feat/x',
    });

    const calls: SpawnCall[] = [];
    await launchAgent({
      projectsDir,
      projectSlug: 'demo',
      assignmentSlug: 'task',
      agent: AGENT,
      spawnFn: fakeSpawn(calls),
      onExit: () => {},
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(repo);
    const warnings = warnSpy.mock.calls
      .map((c) => String(c[0] ?? ''))
      .filter((m) => m.includes('is not an existing directory'));
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('refuses to launch (exit 1, no spawn, no context.json) when no valid dir exists', async () => {
    const badWt = resolve(testDir, 'no-wt');
    await writeAssignment(projectsDir, 'demo', 'task', {
      repository: resolve(testDir, 'no-repo'),
      worktreePath: badWt,
      branch: 'feat/x',
    });

    const calls: SpawnCall[] = [];
    let code = 0;
    await launchAgent({
      projectsDir,
      projectSlug: 'demo',
      assignmentSlug: 'task',
      agent: AGENT,
      spawnFn: fakeSpawn(calls),
      onExit: (c) => {
        code = c;
      },
    });

    expect(calls).toHaveLength(0);
    expect(code).toBe(1);
    expect(existsSync(resolve(badWt, '.syntaur', 'context.json'))).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });

  it('refuses an explicit cwdOverride that is not an existing directory', async () => {
    const worktree = resolve(testDir, 'wt2');
    await mkdir(worktree, { recursive: true });
    await writeAssignment(projectsDir, 'demo', 'task', {
      worktreePath: worktree,
      branch: 'feat/x',
    });

    const calls: SpawnCall[] = [];
    let code = 0;
    await launchAgent({
      projectsDir,
      projectSlug: 'demo',
      assignmentSlug: 'task',
      agent: AGENT,
      cwdOverride: resolve(testDir, 'override-gone'),
      spawnFn: fakeSpawn(calls),
      onExit: (c) => {
        code = c;
      },
    });

    expect(calls).toHaveLength(0);
    expect(code).toBe(1);
  });
});
