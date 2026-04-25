import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createProjectTodosRouter } from '../dashboard/api-project-todos.js';
import { createTodosRouter } from '../dashboard/api-todos.js';
import type { WsMessage } from '../dashboard/types.js';

let testDir: string;
let server: Server;
let baseUrl: string;
const broadcastLog: WsMessage[] = [];

async function seedProject(projectsDir: string, slug: string): Promise<void> {
  await mkdir(resolve(projectsDir, slug), { recursive: true });
  await writeFile(
    resolve(projectsDir, slug, 'project.md'),
    `---\nid: ${slug}-id\nslug: ${slug}\ntitle: ${slug}\n---\n# ${slug}\n`,
    'utf-8',
  );
}

async function seedEmptyDir(projectsDir: string, slug: string): Promise<void> {
  await mkdir(resolve(projectsDir, slug), { recursive: true });
  // intentionally no project.md
}

async function startServer(projectsDir: string, workspaceTodosDir: string): Promise<void> {
  const app = express();
  app.use(express.json());
  const broadcast = (msg: WsMessage): void => {
    broadcastLog.push(msg);
  };
  app.use('/api/todos', createTodosRouter(workspaceTodosDir, broadcast));
  app.use('/api/projects/:projectId/todos', createProjectTodosRouter(projectsDir, broadcast));

  await new Promise<void>((resolvePromise) => {
    const listening = app.listen(0, () => {
      const port = (listening.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolvePromise();
    });
    server = listening;
  });
}

async function stopServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((err) => (err ? reject(err) : resolvePromise()));
  });
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-project-todos-test-'));
  broadcastLog.length = 0;
});

afterEach(async () => {
  await stopServer();
  await rm(testDir, { recursive: true, force: true });
});

async function postTodo(projectId: string, description: string): Promise<Response> {
  return fetch(`${baseUrl}/api/projects/${projectId}/todos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
}

describe('project todos router', () => {
  it('(a) concurrent writes to alpha and beta do not collide and both persist', async () => {
    const projectsDir = resolve(testDir, 'projects');
    const workspaceTodosDir = resolve(testDir, 'todos');
    await mkdir(projectsDir, { recursive: true });
    await mkdir(workspaceTodosDir, { recursive: true });
    await seedProject(projectsDir, 'alpha');
    await seedProject(projectsDir, 'beta');
    await startServer(projectsDir, workspaceTodosDir);

    const [alphaRes, betaRes] = await Promise.all([
      postTodo('alpha', 'alpha-task'),
      postTodo('beta', 'beta-task'),
    ]);
    expect(alphaRes.status).toBe(201);
    expect(betaRes.status).toBe(201);

    const [alphaGet, betaGet] = await Promise.all([
      fetch(`${baseUrl}/api/projects/alpha/todos`).then((r) => r.json()),
      fetch(`${baseUrl}/api/projects/beta/todos`).then((r) => r.json()),
    ]);
    expect(alphaGet.items).toHaveLength(1);
    expect(alphaGet.items[0].description).toBe('alpha-task');
    expect(betaGet.items).toHaveLength(1);
    expect(betaGet.items[0].description).toBe('beta-task');
  });

  it('(b) GET /api/todos aggregate does not include project todos', async () => {
    const projectsDir = resolve(testDir, 'projects');
    const workspaceTodosDir = resolve(testDir, 'todos');
    await mkdir(projectsDir, { recursive: true });
    await mkdir(workspaceTodosDir, { recursive: true });
    await seedProject(projectsDir, 'alpha');
    await startServer(projectsDir, workspaceTodosDir);

    await postTodo('alpha', 'project-only');

    const aggRes = await fetch(`${baseUrl}/api/todos`);
    const agg = await aggRes.json();
    expect(Array.isArray(agg.workspaces)).toBe(true);
    for (const ws of agg.workspaces) {
      for (const item of ws.items) {
        expect(item.description).not.toBe('project-only');
      }
    }
  });

  it('(c) GET /api/projects/alpha/todos does not include workspace or sibling-project todos', async () => {
    const projectsDir = resolve(testDir, 'projects');
    const workspaceTodosDir = resolve(testDir, 'todos');
    await mkdir(projectsDir, { recursive: true });
    await mkdir(workspaceTodosDir, { recursive: true });
    await seedProject(projectsDir, 'alpha');
    await seedProject(projectsDir, 'beta');
    await startServer(projectsDir, workspaceTodosDir);

    await fetch(`${baseUrl}/api/todos/_global`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'workspace-task' }),
    });
    await postTodo('alpha', 'alpha-only');
    await postTodo('beta', 'beta-only');

    const alpha = await fetch(`${baseUrl}/api/projects/alpha/todos`).then((r) => r.json());
    const descriptions = alpha.items.map((i: { description: string }) => i.description);
    expect(descriptions).toContain('alpha-only');
    expect(descriptions).not.toContain('workspace-task');
    expect(descriptions).not.toContain('beta-only');
  });

  it('(d) GET /api/projects/ghost/todos returns 404', async () => {
    const projectsDir = resolve(testDir, 'projects');
    const workspaceTodosDir = resolve(testDir, 'todos');
    await mkdir(projectsDir, { recursive: true });
    await mkdir(workspaceTodosDir, { recursive: true });
    await startServer(projectsDir, workspaceTodosDir);

    const res = await fetch(`${baseUrl}/api/projects/ghost/todos`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('ghost');
  });

  it('(e) GET /api/projects/<INVALID>/todos returns 400', async () => {
    const projectsDir = resolve(testDir, 'projects');
    const workspaceTodosDir = resolve(testDir, 'todos');
    await mkdir(projectsDir, { recursive: true });
    await mkdir(workspaceTodosDir, { recursive: true });
    await startServer(projectsDir, workspaceTodosDir);

    const res = await fetch(`${baseUrl}/api/projects/INVALID_SLUG/todos`);
    expect(res.status).toBe(400);
  });

  it('(f) concurrent writes to the SAME project preserve both items via the lock', async () => {
    const projectsDir = resolve(testDir, 'projects');
    const workspaceTodosDir = resolve(testDir, 'todos');
    await mkdir(projectsDir, { recursive: true });
    await mkdir(workspaceTodosDir, { recursive: true });
    await seedProject(projectsDir, 'alpha');
    await startServer(projectsDir, workspaceTodosDir);

    const [r1, r2] = await Promise.all([postTodo('alpha', 'one'), postTodo('alpha', 'two')]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    const got = await fetch(`${baseUrl}/api/projects/alpha/todos`).then((r) => r.json());
    const descriptions = got.items.map((i: { description: string }) => i.description).sort();
    expect(descriptions).toEqual(['one', 'two']);
  });

  it('rejects an empty project directory with no project.md as 404', async () => {
    const projectsDir = resolve(testDir, 'projects');
    const workspaceTodosDir = resolve(testDir, 'todos');
    await mkdir(projectsDir, { recursive: true });
    await mkdir(workspaceTodosDir, { recursive: true });
    await seedEmptyDir(projectsDir, 'ghost');
    await startServer(projectsDir, workspaceTodosDir);

    const res = await fetch(`${baseUrl}/api/projects/ghost/todos`);
    expect(res.status).toBe(404);
  });

  it('broadcasts todos-updated with projectSlug populated', async () => {
    const projectsDir = resolve(testDir, 'projects');
    const workspaceTodosDir = resolve(testDir, 'todos');
    await mkdir(projectsDir, { recursive: true });
    await mkdir(workspaceTodosDir, { recursive: true });
    await seedProject(projectsDir, 'alpha');
    await startServer(projectsDir, workspaceTodosDir);

    await postTodo('alpha', 'broadcast-me');

    const msg = broadcastLog.find((m) => m.type === 'todos-updated' && m.projectSlug === 'alpha');
    expect(msg).toBeDefined();
    expect(msg?.projectSlug).toBe('alpha');
  });
});
