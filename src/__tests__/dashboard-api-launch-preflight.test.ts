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
