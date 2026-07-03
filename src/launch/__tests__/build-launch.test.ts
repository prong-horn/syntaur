import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildLaunchPlan } from '../build-launch.js';
import type { AgentConfig } from '../../utils/config.js';

const AGENT: AgentConfig = {
  id: 'echoer',
  label: 'Echo',
  command: '/bin/echo',
  default: true,
};

async function writeAssignment(
  projectsDir: string,
  projectSlug: string,
  assignmentSlug: string,
  ws: { repository?: string | null; worktreePath?: string | null; branch?: string | null },
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
      'id: 22222222-2222-2222-2222-222222222222',
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

describe('buildLaunchPlan', () => {
  let testDir: string;
  let projectsDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'syntaur-build-launch-'));
    projectsDir = resolve(testDir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await rm(testDir, { recursive: true, force: true });
  });

  it('writes context.json to the worktree and returns the resolved argv/cwd', async () => {
    const worktree = resolve(testDir, 'wt');
    await mkdir(worktree, { recursive: true });
    await writeAssignment(projectsDir, 'demo', 'task', {
      worktreePath: worktree,
      branch: 'feat/x',
    });

    const plan = await buildLaunchPlan({
      projectsDir,
      projectSlug: 'demo',
      assignmentSlug: 'task',
      agent: AGENT,
    });

    expect(plan.cwd).toBe(worktree);
    expect(plan.command).toBe('/bin/echo');
    expect(plan.args.join(' ')).toContain('/grab-assignment demo task');

    const contextPath = resolve(worktree, '.syntaur', 'context.json');
    expect(existsSync(contextPath)).toBe(true);
    const context = JSON.parse(await readFile(contextPath, 'utf8'));
    expect(context.branch).toBe('feat/x');
    expect(context.workspaceRoot).toBe(worktree);
  });

  it('honors an explicit cwdOverride without touching workspace fields', async () => {
    const worktree = resolve(testDir, 'wt-unused');
    const override = resolve(testDir, 'override');
    await mkdir(worktree, { recursive: true });
    await mkdir(override, { recursive: true });
    await writeAssignment(projectsDir, 'demo', 'task', {
      worktreePath: worktree,
      branch: 'feat/x',
    });

    const plan = await buildLaunchPlan({
      projectsDir,
      projectSlug: 'demo',
      assignmentSlug: 'task',
      agent: AGENT,
      cwdOverride: override,
    });

    expect(plan.cwd).toBe(override);
    expect(existsSync(resolve(override, '.syntaur', 'context.json'))).toBe(true);
    expect(existsSync(resolve(worktree, '.syntaur', 'context.json'))).toBe(false);
  });

  it('throws (never calls process.exit) when the assignment is not found', async () => {
    await expect(
      buildLaunchPlan({
        projectsDir,
        projectSlug: 'demo',
        assignmentSlug: 'missing',
        agent: AGENT,
      }),
    ).rejects.toThrow(/Assignment not found/);
  });

  it('throws when cwdOverride is not an existing directory', async () => {
    const worktree = resolve(testDir, 'wt2');
    await mkdir(worktree, { recursive: true });
    await writeAssignment(projectsDir, 'demo', 'task', {
      worktreePath: worktree,
      branch: 'feat/x',
    });

    await expect(
      buildLaunchPlan({
        projectsDir,
        projectSlug: 'demo',
        assignmentSlug: 'task',
        agent: AGENT,
        cwdOverride: resolve(testDir, 'gone'),
      }),
    ).rejects.toThrow(/is not an existing directory/);
  });
});
