import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createLaunchPreflightRouter } from '../dashboard/api-launch-preflight.js';

const originalHome = process.env.HOME;
const originalSyntaurHome = process.env.SYNTAUR_HOME;
const originalPath = process.env.PATH;

let tmpHome: string;
let pathDir: string;
let projectsDir: string;
let assignmentsDir: string;
let server: Server;
let baseUrl: string;

async function writeAssignment(
  id: string,
  ws: { repository?: string | null; worktreePath?: string | null; branch?: string | null },
): Promise<void> {
  const projectSlug = 'demo';
  const assignmentSlug = `task-${id.slice(0, 8)}`;
  const projectDir = resolve(projectsDir, projectSlug);
  const assignmentDir = resolve(projectDir, 'assignments', assignmentSlug);
  await mkdir(assignmentDir, { recursive: true });
  await writeFile(
    resolve(projectDir, 'project.md'),
    `---\nslug: ${projectSlug}\ntitle: ${projectSlug}\nstatus: in_progress\ncreated: "2026-01-01T00:00:00Z"\nupdated: "2026-01-01T00:00:00Z"\n---\n# ${projectSlug}\n`,
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

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'syntaur-preflight-api-'));
  await mkdir(join(tmpHome, '.syntaur'), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.SYNTAUR_HOME = join(tmpHome, '.syntaur');
  pathDir = await mkdtemp(join(tmpdir(), 'syntaur-preflight-path-'));
  projectsDir = resolve(tmpHome, 'projects');
  assignmentsDir = resolve(tmpHome, 'assignments');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(assignmentsDir, { recursive: true });

  const app = express();
  app.use(express.json());
  app.use('/api/launch', createLaunchPreflightRouter(projectsDir, assignmentsDir));

  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/api/launch/preflight`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalSyntaurHome;
  await rm(tmpHome, { recursive: true, force: true });
  await rm(pathDir, { recursive: true, force: true });
});

describe('POST /api/launch/preflight', () => {
  it('returns ok:true when the requested CLI terminal is on PATH', async () => {
    // Stage a fake `kitty` so the `which` probe finds it.
    const kittyPath = join(pathDir, 'kitty');
    await writeFile(kittyPath, '#!/bin/sh\nexit 0\n');
    await chmod(kittyPath, 0o755);
    process.env.PATH = `${pathDir}:/usr/bin:/bin`;

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'kitty' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.terminal).toBe('kitty');
  });

  it('returns ok:false with suggestedFallback when the requested CLI terminal is missing', async () => {
    // PATH points at a non-existent dir so `which` itself fails to resolve.
    process.env.PATH = '/tmp/syntaur-preflight-no-such-dir';

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'alacritty' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.terminal).toBe('alacritty');
    expect(body.reason).toBe('not-installed');
    expect(typeof body.suggestedFallback).toBe('string');
  });

  it('rejects an invalid terminal value with 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'bogus' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/terminal must be one of/);
  });

  it('returns workspace-path-invalid when the assignment workspace dirs do not exist', async () => {
    // Terminal must be installed first so the workspace check runs.
    const kittyPath = join(pathDir, 'kitty');
    await writeFile(kittyPath, '#!/bin/sh\nexit 0\n');
    await chmod(kittyPath, 0o755);
    process.env.PATH = `${pathDir}:/usr/bin:/bin`;

    const id = '22222222-2222-2222-2222-222222222222';
    await writeAssignment(id, {
      worktreePath: join(tmpHome, 'gone-wt'),
      repository: join(tmpHome, 'gone-repo'),
      branch: 'feat/x',
    });

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'kitty', target: { kind: 'assignment', id } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('workspace-path-invalid');
    expect(typeof body.message).toBe('string');
  });

  it('offers recreate when an assignment worktree is gone but the repository remains (the core bug)', async () => {
    const kittyPath = join(pathDir, 'kitty');
    await writeFile(kittyPath, '#!/bin/sh\nexit 0\n');
    await chmod(kittyPath, 0o755);
    process.env.PATH = `${pathDir}:/usr/bin:/bin`;

    // Repository still exists; only the worktree dir was deleted. The legacy
    // `cwd === null` check would NOT fire here (it falls back to the repo).
    const repoDir = join(tmpHome, 'live-repo');
    await mkdir(repoDir, { recursive: true });
    const goneWt = join(tmpHome, 'gone-wt-recreatable');

    const id = '44444444-4444-4444-4444-444444444444';
    await writeAssignment(id, {
      worktreePath: goneWt,
      repository: repoDir,
      branch: 'feat/x',
    });

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'kitty', target: { kind: 'assignment', id } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('workspace-path-invalid');
    expect(body.recreate).toBeTruthy();
    expect(body.recreate.kind).toBe('assignment');
    expect(body.recreate.deletedPath).toBe(goneWt);
    expect(body.recreate.repository).toBe(repoDir);
    expect(body.recreate.branch).toBe('feat/x');
  });

  it('offers recreate for a session whose recorded worktree is gone (preflight parity)', async () => {
    const kittyPath = join(pathDir, 'kitty');
    await writeFile(kittyPath, '#!/bin/sh\nexit 0\n');
    await chmod(kittyPath, 0o755);
    process.env.PATH = `${pathDir}:/usr/bin:/bin`;

    const { resetSessionDb, initSessionDb, closeSessionDb } = await import(
      '../dashboard/session-db.js'
    );
    const { appendSession } = await import('../dashboard/agent-sessions.js');
    resetSessionDb();
    initSessionDb(resolve(tmpHome, '.syntaur', 'sessions.db'));
    try {
      const repoDir = join(tmpHome, 'live-repo-session');
      await mkdir(repoDir, { recursive: true });
      const goneWt = join(tmpHome, 'gone-session-wt');

      const id = '55555555-5555-5555-5555-555555555555';
      const assignmentSlug = `task-${id.slice(0, 8)}`;
      await writeAssignment(id, {
        worktreePath: goneWt,
        repository: repoDir,
        branch: 'feat/sess',
      });
      await appendSession('', {
        projectSlug: 'demo',
        assignmentSlug,
        agent: 'claude',
        sessionId: 'sess-abc',
        started: '2026-06-01T00:00:00Z',
        status: 'active',
        path: goneWt,
      });

      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terminal: 'kitty', target: { kind: 'session', id: 'sess-abc' } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reason).toBe('workspace-path-invalid');
      expect(body.recreate).toBeTruthy();
      expect(body.recreate.kind).toBe('session');
      expect(body.recreate.deletedPath).toBe(goneWt);
      expect(body.recreate.repository).toBe(repoDir);
    } finally {
      closeSessionDb();
      resetSessionDb();
    }
  });

  it('returns ok:true for an assignment whose worktree exists', async () => {
    const kittyPath = join(pathDir, 'kitty');
    await writeFile(kittyPath, '#!/bin/sh\nexit 0\n');
    await chmod(kittyPath, 0o755);
    process.env.PATH = `${pathDir}:/usr/bin:/bin`;

    const id = '33333333-3333-3333-3333-333333333333';
    const wt = join(tmpHome, 'real-wt');
    await mkdir(wt, { recursive: true });
    await writeAssignment(id, { worktreePath: wt, branch: 'feat/x' });

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'kitty', target: { kind: 'assignment', id } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.terminal).toBe('kitty');
  });

  it('uses the configured terminal when body has no terminal', async () => {
    // No saved terminal → getTerminal returns OS-aware default. The response
    // shape should still be valid (ok or not depending on host install state).
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.ok).toBe('boolean');
    expect(typeof body.terminal).toBe('string');
  });
});

describe('GET /api/launch/command', () => {
  const commandUrl = () => baseUrl.replace('/preflight', '/command');

  async function withSessionDb(
    fn: () => Promise<void>,
  ): Promise<void> {
    const { resetSessionDb, initSessionDb, closeSessionDb } = await import(
      '../dashboard/session-db.js'
    );
    resetSessionDb();
    initSessionDb(resolve(tmpHome, '.syntaur', 'sessions.db'));
    try {
      await fn();
    } finally {
      closeSessionDb();
      resetSessionDb();
    }
  }

  it('returns the exact resume command for a session (builtin claude, no linked assignment)', async () => {
    await withSessionDb(async () => {
      const { appendSession } = await import('../dashboard/agent-sessions.js');
      await appendSession('', {
        projectSlug: null,
        assignmentSlug: null,
        agent: 'claude',
        sessionId: 'sess-xyz',
        started: '2026-06-01T00:00:00Z',
        status: 'active',
        path: '/tmp/work',
      });

      const res = await fetch(`${commandUrl()}?session=sess-xyz&mode=resume`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.command).toBe("cd '/tmp/work' && 'claude' '--resume' 'sess-xyz'");
      expect(body.cwd).toBe('/tmp/work');
      expect(body.agentId).toBe('claude');
      expect(body.mode).toBe('resume');
      expect(body.fallbackWarning).toBeNull();
    });
  });

  it('defaults mode to resume when the mode param is omitted (route default)', async () => {
    await withSessionDb(async () => {
      const { appendSession } = await import('../dashboard/agent-sessions.js');
      await appendSession('', {
        projectSlug: null,
        assignmentSlug: null,
        agent: 'claude',
        sessionId: 'sess-xyz',
        started: '2026-06-01T00:00:00Z',
        status: 'active',
        path: '/tmp/work',
      });

      const res = await fetch(`${commandUrl()}?session=sess-xyz`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe('resume');
      expect(body.command).toBe("cd '/tmp/work' && 'claude' '--resume' 'sess-xyz'");
    });
  });

  it('returns a non-null fallbackWarning and the repository cwd when the worktree is gone', async () => {
    await withSessionDb(async () => {
      const { appendSession } = await import('../dashboard/agent-sessions.js');
      const repoDir = join(tmpHome, 'fb-repo');
      await mkdir(repoDir, { recursive: true });
      const goneWt = join(tmpHome, 'fb-gone-wt');

      const id = '66666666-6666-6666-6666-666666666666';
      const assignmentSlug = `task-${id.slice(0, 8)}`;
      await writeAssignment(id, {
        worktreePath: goneWt,
        repository: repoDir,
        branch: 'feat/fb',
      });
      await appendSession('', {
        projectSlug: 'demo',
        assignmentSlug,
        agent: 'claude',
        sessionId: 'sess-fb',
        started: '2026-06-01T00:00:00Z',
        status: 'active',
        path: goneWt,
      });

      const res = await fetch(`${commandUrl()}?session=sess-fb&mode=resume`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.fallbackWarning).toBe('string');
      expect(body.fallbackWarning.length).toBeGreaterThan(0);
      expect(body.cwd).toBe(repoDir);
    });
  });

  it('keeps session.path with a NULL warning when both worktree and repository are gone but fields are populated', async () => {
    await withSessionDb(async () => {
      const { appendSession } = await import('../dashboard/agent-sessions.js');
      const goneWt = join(tmpHome, 'stale-gone-wt');

      const id = '77777777-7777-7777-7777-777777777777';
      const assignmentSlug = `task-${id.slice(0, 8)}`;
      await writeAssignment(id, {
        worktreePath: goneWt,
        repository: join(tmpHome, 'stale-gone-repo'),
        branch: 'feat/none',
      });
      await appendSession('', {
        projectSlug: 'demo',
        assignmentSlug,
        agent: 'claude',
        sessionId: 'sess-stale',
        started: '2026-06-01T00:00:00Z',
        status: 'active',
        path: goneWt,
      });

      const res = await fetch(`${commandUrl()}?session=sess-stale&mode=resume`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.fallbackWarning).toBeNull();
      expect(body.cwd).toBe(goneWt);
      expect(body.command.startsWith(`cd '${goneWt}' &&`)).toBe(true);
    });
  });

  it('returns 404 when the session does not exist (DB initialized, empty)', async () => {
    await withSessionDb(async () => {
      const res = await fetch(`${commandUrl()}?session=does-not-exist`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(typeof body.error).toBe('string');
    });
  });

  it('returns 422 when the session was started with an unconfigured agent', async () => {
    await withSessionDb(async () => {
      const { appendSession } = await import('../dashboard/agent-sessions.js');
      await appendSession('', {
        projectSlug: null,
        assignmentSlug: null,
        agent: 'ghost-agent',
        sessionId: 'sess-ghost',
        started: '2026-06-01T00:00:00Z',
        status: 'active',
        path: '/tmp/work',
      });

      const res = await fetch(`${commandUrl()}?session=sess-ghost&mode=resume`);
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toContain('ghost-agent');
    });
  });

  it('returns 422 when the agent does not support the requested mode (fork)', async () => {
    const { writeAgentsConfig } = await import('../utils/config.js');
    await writeAgentsConfig([
      {
        id: 'noforkagent',
        label: 'No Fork Agent',
        command: 'noforkagent',
        default: true,
        resume: { args: ['--resume', '{id}'] },
      },
    ]);

    await withSessionDb(async () => {
      const { appendSession } = await import('../dashboard/agent-sessions.js');
      await appendSession('', {
        projectSlug: null,
        assignmentSlug: null,
        agent: 'noforkagent',
        sessionId: 'sess-nofork',
        started: '2026-06-01T00:00:00Z',
        status: 'active',
        path: '/tmp/work',
      });

      const res = await fetch(`${commandUrl()}?session=sess-nofork&mode=fork`);
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/fork/);
    });
  });

  it('returns 400 when the session param is missing', async () => {
    const res = await fetch(commandUrl());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/session/);
  });

  it('returns 400 for an invalid mode value', async () => {
    const res = await fetch(`${commandUrl()}?session=sess-xyz&mode=bogus`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/mode must be one of/);
  });

  it('returns 400 when session is a duplicated (array) query param', async () => {
    const res = await fetch(`${commandUrl()}?session=a&session=b`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/session/);
  });
});
