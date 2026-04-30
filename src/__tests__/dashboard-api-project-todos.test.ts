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
  app.use('/api/todos', createTodosRouter(workspaceTodosDir, broadcast, projectsDir));
  app.use('/api/projects/:projectId/todos', createProjectTodosRouter(projectsDir, broadcast, workspaceTodosDir));

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

describe('cross-scope move endpoints', () => {
  async function setupBoth(): Promise<{ projectsDir: string; workspaceTodosDir: string }> {
    const projectsDir = resolve(testDir, 'projects');
    const workspaceTodosDir = resolve(testDir, 'todos');
    await mkdir(projectsDir, { recursive: true });
    await mkdir(workspaceTodosDir, { recursive: true });
    return { projectsDir, workspaceTodosDir };
  }

  async function getTodoId(url: string): Promise<string> {
    const r = await fetch(url);
    const data = (await r.json()) as { items: { id: string }[] };
    return data.items[0].id;
  }

  it('workspace → project: moves item, fires two broadcasts (workspace + project)', async () => {
    const { projectsDir, workspaceTodosDir } = await setupBoth();
    await seedProject(projectsDir, 'alpha');
    await startServer(projectsDir, workspaceTodosDir);

    await fetch(`${baseUrl}/api/todos/src`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'movable' }),
    });
    const id = await getTodoId(`${baseUrl}/api/todos/src`);
    broadcastLog.length = 0;

    const res = await fetch(`${baseUrl}/api/todos/src/${id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: { project: 'alpha' } }),
    });
    expect(res.status).toBe(200);

    const srcAfter = await (await fetch(`${baseUrl}/api/todos/src`)).json() as { items: unknown[] };
    expect(srcAfter.items).toHaveLength(0);
    const tgtAfter = await (await fetch(`${baseUrl}/api/projects/alpha/todos`)).json() as { items: { id: string }[] };
    expect(tgtAfter.items.map((i) => i.id)).toContain(id);

    expect(broadcastLog.length).toBe(2);
    const wsMsg = broadcastLog.find((m) => !m.projectSlug);
    const projMsg = broadcastLog.find((m) => m.projectSlug === 'alpha');
    expect(wsMsg).toBeDefined();
    expect(projMsg).toBeDefined();
  });

  it('rejects same-scope move with 400', async () => {
    const { projectsDir, workspaceTodosDir } = await setupBoth();
    await startServer(projectsDir, workspaceTodosDir);

    await fetch(`${baseUrl}/api/todos/src`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'x' }),
    });
    const id = await getTodoId(`${baseUrl}/api/todos/src`);

    const res = await fetch(`${baseUrl}/api/todos/src/${id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: { workspace: 'src' } }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when target project does not exist', async () => {
    const { projectsDir, workspaceTodosDir } = await setupBoth();
    await startServer(projectsDir, workspaceTodosDir);

    await fetch(`${baseUrl}/api/todos/src`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'x' }),
    });
    const id = await getTodoId(`${baseUrl}/api/todos/src`);

    const res = await fetch(`${baseUrl}/api/todos/src/${id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: { project: 'doesnotexist' } }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when source todo id is missing', async () => {
    const { projectsDir, workspaceTodosDir } = await setupBoth();
    await seedProject(projectsDir, 'alpha');
    await startServer(projectsDir, workspaceTodosDir);

    const res = await fetch(`${baseUrl}/api/todos/src/dead/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: { project: 'alpha' } }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 on id collision in target', async () => {
    const { projectsDir, workspaceTodosDir } = await setupBoth();
    await seedProject(projectsDir, 'alpha');
    await startServer(projectsDir, workspaceTodosDir);

    await fetch(`${baseUrl}/api/todos/src`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'src' }),
    });
    const id = await getTodoId(`${baseUrl}/api/todos/src`);

    // Manually craft a colliding entry on the target
    await mkdir(resolve(projectsDir, 'alpha', 'todos'), { recursive: true });
    await writeFile(
      resolve(projectsDir, 'alpha', 'todos', 'alpha.md'),
      `---\nworkspace: alpha\narchiveInterval: weekly\n---\n\n# Quick Todos\n\n- [ ] colliding [t:${id}]\n`,
      'utf-8',
    );

    const res = await fetch(`${baseUrl}/api/todos/src/${id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: { project: 'alpha' } }),
    });
    expect(res.status).toBe(409);
  });

  it('project → workspace: moves and fires two broadcasts', async () => {
    const { projectsDir, workspaceTodosDir } = await setupBoth();
    await seedProject(projectsDir, 'alpha');
    await startServer(projectsDir, workspaceTodosDir);

    await fetch(`${baseUrl}/api/projects/alpha/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'p2w' }),
    });
    const id = await getTodoId(`${baseUrl}/api/projects/alpha/todos`);
    broadcastLog.length = 0;

    const res = await fetch(`${baseUrl}/api/projects/alpha/todos/${id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: { workspace: 'src' } }),
    });
    expect(res.status).toBe(200);

    expect(broadcastLog.length).toBe(2);
    expect(broadcastLog.some((m) => m.projectSlug === 'alpha')).toBe(true);
    expect(broadcastLog.some((m) => !m.projectSlug)).toBe(true);
  });

  it('project A → project B: two project broadcasts', async () => {
    const { projectsDir, workspaceTodosDir } = await setupBoth();
    await seedProject(projectsDir, 'alpha');
    await seedProject(projectsDir, 'beta');
    await startServer(projectsDir, workspaceTodosDir);

    await fetch(`${baseUrl}/api/projects/alpha/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'crossp' }),
    });
    const id = await getTodoId(`${baseUrl}/api/projects/alpha/todos`);
    broadcastLog.length = 0;

    const res = await fetch(`${baseUrl}/api/projects/alpha/todos/${id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: { project: 'beta' } }),
    });
    expect(res.status).toBe(200);
    expect(broadcastLog.length).toBe(2);
    expect(broadcastLog.some((m) => m.projectSlug === 'alpha')).toBe(true);
    expect(broadcastLog.some((m) => m.projectSlug === 'beta')).toBe(true);
  });

  it('project → global: fires project + workspace broadcasts', async () => {
    const { projectsDir, workspaceTodosDir } = await setupBoth();
    await seedProject(projectsDir, 'alpha');
    await startServer(projectsDir, workspaceTodosDir);

    await fetch(`${baseUrl}/api/projects/alpha/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'p2g' }),
    });
    const id = await getTodoId(`${baseUrl}/api/projects/alpha/todos`);
    broadcastLog.length = 0;

    const res = await fetch(`${baseUrl}/api/projects/alpha/todos/${id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: { global: true } }),
    });
    expect(res.status).toBe(200);
    expect(broadcastLog.length).toBe(2);
  });

  it('preserves item timestamps verbatim across move', async () => {
    const { projectsDir, workspaceTodosDir } = await setupBoth();
    await seedProject(projectsDir, 'alpha');
    await startServer(projectsDir, workspaceTodosDir);

    await fetch(`${baseUrl}/api/todos/src`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'preserve-me' }),
    });
    const beforeData = await (await fetch(`${baseUrl}/api/todos/src`)).json() as {
      items: { id: string; createdAt: string | null; updatedAt: string | null }[];
    };
    const beforeItem = beforeData.items[0];

    const res = await fetch(`${baseUrl}/api/todos/src/${beforeItem.id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: { project: 'alpha' } }),
    });
    expect(res.status).toBe(200);

    const afterData = await (await fetch(`${baseUrl}/api/projects/alpha/todos`)).json() as {
      items: { id: string; createdAt: string | null; updatedAt: string | null }[];
    };
    const afterItem = afterData.items.find((i) => i.id === beforeItem.id)!;
    expect(afterItem.createdAt).toBe(beforeItem.createdAt);
    expect(afterItem.updatedAt).toBe(beforeItem.updatedAt);
  });

  it('project /promote: validates body shape (400 on missing mode)', async () => {
    const { projectsDir, workspaceTodosDir } = await setupBoth();
    await seedProject(projectsDir, 'alpha');
    await startServer(projectsDir, workspaceTodosDir);

    const res = await fetch(`${baseUrl}/api/projects/alpha/todos/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ todoIds: ['x'] }),
    });
    expect(res.status).toBe(400);
  });

  it('project /promote: 404 when project does not exist', async () => {
    const { projectsDir, workspaceTodosDir } = await setupBoth();
    await startServer(projectsDir, workspaceTodosDir);

    const res = await fetch(`${baseUrl}/api/projects/ghost/todos/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        todoIds: ['x'],
        mode: 'new-assignment',
        target: { project: 'ghost' },
      }),
    });
    expect(res.status).toBe(404);
  });
});
