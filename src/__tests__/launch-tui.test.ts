import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { launchAgent, INITIAL_PROMPT } from '../tui/launch.js';
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

describe('INITIAL_PROMPT', () => {
  describe('without a playbook (unchanged behavior)', () => {
    it('project-nested → /grab-assignment <proj> <asg>', () => {
      expect(INITIAL_PROMPT({ projectSlug: 'proj', assignmentSlug: 'asg' })).toBe(
        '/grab-assignment proj asg',
      );
    });

    it('standalone with id → /grab-assignment --id <uuid>', () => {
      expect(
        INITIAL_PROMPT({ projectSlug: null, assignmentSlug: 'asg', id: 'uuid-1' }),
      ).toBe('/grab-assignment --id uuid-1');
    });

    it('slug fallback (no project, no id) → /grab-assignment <slug>', () => {
      expect(INITIAL_PROMPT({ projectSlug: null, assignmentSlug: 'asg' })).toBe(
        '/grab-assignment asg',
      );
    });

    it('treats a blank playbook as no playbook', () => {
      expect(
        INITIAL_PROMPT({ projectSlug: 'proj', assignmentSlug: 'asg', playbook: '   ' }),
      ).toBe('/grab-assignment proj asg');
    });
  });

  describe('with a playbook (chains grab + run-playbook)', () => {
    it('project-nested references proj/asg, /grab-assignment, /run-playbook and the slug', () => {
      const out = INITIAL_PROMPT({
        projectSlug: 'proj',
        assignmentSlug: 'asg',
        playbook: 'e2e-dev-cycle',
      });
      expect(out).toContain('proj/asg');
      expect(out).toContain('/grab-assignment');
      expect(out).toContain('/run-playbook');
      expect(out).toContain('e2e-dev-cycle');
      expect(out).toContain('end-to-end');
    });

    it('byte-locks the legacy playbook sentence (guards the bareGrabSeed extraction)', () => {
      // The playbook branch keeps its legacy "using the /run-playbook skill"
      // wording verbatim — the resolver's new "via" phrasing must NOT leak here.
      expect(
        INITIAL_PROMPT({ projectSlug: 'proj', assignmentSlug: 'asg', playbook: 'e2e-dev-cycle' }),
      ).toBe(
        'Grab the assignment `proj/asg` using the /grab-assignment skill, then load and run ' +
          'the `e2e-dev-cycle` playbook using the /run-playbook skill and carry it out end-to-end.',
      );
    });

    it('standalone references the uuid via --id', () => {
      const out = INITIAL_PROMPT({
        projectSlug: null,
        assignmentSlug: 'asg',
        id: 'uuid-9',
        playbook: 'create-and-plan-assignment',
      });
      expect(out).toContain('/grab-assignment --id uuid-9');
      expect(out).toContain('create-and-plan-assignment');
    });

    it('slug fallback references the assignment slug', () => {
      const out = INITIAL_PROMPT({
        projectSlug: null,
        assignmentSlug: 'asg',
        playbook: 'keep-records-updated',
      });
      expect(out).toContain('`asg`');
      expect(out).toContain('/grab-assignment');
      expect(out).toContain('keep-records-updated');
    });
  });
});
