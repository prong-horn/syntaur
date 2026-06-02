import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createAgentSessionsRouter } from '../dashboard/api-agent-sessions.js';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { appendSession } from '../dashboard/agent-sessions.js';

const originalHome = process.env.HOME;
const originalSyntaurHome = process.env.SYNTAUR_HOME;

let tmpHome: string;
let projectsDir: string;
let assignmentsDir: string;
let server: Server;
let baseUrl: string;

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function writeProjectAssignment(opts: {
  projectSlug: string;
  assignmentSlug: string;
  id: string;
  repository: string;
  worktreePath: string;
  branch: string;
}): Promise<void> {
  const projectDir = resolve(projectsDir, opts.projectSlug);
  const assignmentDir = resolve(projectDir, 'assignments', opts.assignmentSlug);
  await mkdir(assignmentDir, { recursive: true });
  await writeFile(
    resolve(projectDir, 'project.md'),
    `---\nslug: ${opts.projectSlug}\ntitle: ${opts.projectSlug}\nstatus: in_progress\ncreated: "2026-01-01T00:00:00Z"\nupdated: "2026-01-01T00:00:00Z"\n---\n# ${opts.projectSlug}\n`,
  );
  await writeFile(
    resolve(assignmentDir, 'assignment.md'),
    [
      '---',
      `id: ${opts.id}`,
      `slug: ${opts.assignmentSlug}`,
      `title: "${opts.assignmentSlug}"`,
      `project: ${opts.projectSlug}`,
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
      `  repository: ${opts.repository}`,
      `  worktreePath: ${opts.worktreePath}`,
      `  branch: ${opts.branch}`,
      '  parentBranch: main',
      'tags: []',
      '---',
      '',
      `# ${opts.assignmentSlug}`,
    ].join('\n'),
  );
}

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'syntaur-session-recreate-'));
  await mkdir(join(tmpHome, '.syntaur'), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.SYNTAUR_HOME = join(tmpHome, '.syntaur');
  projectsDir = resolve(tmpHome, 'projects');
  assignmentsDir = resolve(tmpHome, 'assignments');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(assignmentsDir, { recursive: true });

  resetSessionDb();
  initSessionDb(resolve(tmpHome, '.syntaur', 'sessions.db'));

  const app = express();
  app.use(express.json());
  app.use(
    '/api/agent-sessions',
    createAgentSessionsRouter(projectsDir, undefined, assignmentsDir),
  );
  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent-sessions`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  closeSessionDb();
  resetSessionDb();
  process.env.HOME = originalHome;
  if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalSyntaurHome;
  await rm(tmpHome, { recursive: true, force: true });
});

describe('POST /api/agent-sessions/:sessionId/worktree/recreate', () => {
  it('rebuilds the session worktree at its exact recorded path so resume can find it', async () => {
    // A repo with a worktree on the session's branch.
    const repo = resolve(tmpHome, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@e.com']);
    git(repo, ['config', 'user.name', 'T']);
    await writeFile(resolve(repo, 'README.md'), '# t\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
    const wtPath = resolve(tmpHome, 'session-wt');
    git(repo, ['worktree', 'add', '-b', 'feat/sess', wtPath, 'main']);

    await writeProjectAssignment({
      projectSlug: 'demo',
      assignmentSlug: 'task-recreate',
      id: 'aaaa1111-bbbb-2222-cccc-333344445555',
      repository: repo,
      worktreePath: wtPath,
      branch: 'feat/sess',
    });
    await appendSession('', {
      projectSlug: 'demo',
      assignmentSlug: 'task-recreate',
      agent: 'claude',
      sessionId: 'sess-recreate-1',
      started: '2026-06-01T00:00:00Z',
      status: 'active',
      path: wtPath,
    });

    // Simulate the worktree being deleted.
    await rm(wtPath, { recursive: true, force: true });
    await expect(stat(wtPath)).rejects.toBeTruthy();

    const res = await fetch(`${baseUrl}/sess-recreate-1/worktree/recreate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.branch).toBe('feat/sess');
    expect(body.exact).toBe(true);
    // The directory is back at the EXACT recorded path `claude --resume` needs.
    await expect(stat(wtPath)).resolves.toBeTruthy();
  });

  it('rebuilds for a standalone-linked session (project_slug NULL, assignment_slug = UUID)', async () => {
    const repo = resolve(tmpHome, 'repo-standalone');
    await mkdir(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@e.com']);
    git(repo, ['config', 'user.name', 'T']);
    await writeFile(resolve(repo, 'README.md'), '# t\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
    const wtPath = resolve(tmpHome, 'standalone-session-wt');
    git(repo, ['worktree', 'add', '-b', 'feat/solo', wtPath, 'main']);

    // Standalone assignment lives under assignmentsDir/<uuid>/assignment.md and
    // is resolved by id (the session's assignment_slug holds that UUID).
    const id = 'bbbb2222-cccc-3333-dddd-444455556666';
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
        `  repository: ${repo}`,
        `  worktreePath: ${wtPath}`,
        '  branch: feat/solo',
        '  parentBranch: main',
        'tags: []',
        '---',
        '',
        '# Solo Task',
      ].join('\n'),
    );

    await appendSession('', {
      projectSlug: null,
      assignmentSlug: id, // standalone: assignment_slug holds the UUID
      agent: 'claude',
      sessionId: 'sess-standalone-1',
      started: '2026-06-01T00:00:00Z',
      status: 'active',
      path: wtPath,
    });

    await rm(wtPath, { recursive: true, force: true });

    const res = await fetch(`${baseUrl}/sess-standalone-1/worktree/recreate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.branch).toBe('feat/solo');
    await expect(stat(wtPath)).resolves.toBeTruthy();
  });

  it('404s for an unknown session', async () => {
    const res = await fetch(`${baseUrl}/no-such-session/worktree/recreate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
