import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createBundlesRouter } from '../dashboard/api-bundles.js';
import { createProjectBundlesRouter } from '../dashboard/api-project-bundles.js';
import { writeBundles } from '../todos/bundle-parser.js';
import { writeChecklist } from '../todos/parser.js';
import type { TodoBundle, TodoItem, WsMessage } from '../todos/types.js';

let testDir: string;
let server: Server;
let baseUrl: string;
let workspaceTodosDir: string;
let projectsDir: string;

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());
  const broadcast = (_msg: WsMessage): void => {};
  app.use('/api/bundles', createBundlesRouter(workspaceTodosDir, broadcast));
  app.use('/api/projects/:projectId/bundles', createProjectBundlesRouter(projectsDir, broadcast));
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

function todo(id: string, description: string, overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id,
    description,
    status: 'open',
    tags: [],
    session: null,
    branch: null,
    worktreePath: null,
    createdAt: '2026-05-21T13:00:00Z',
    updatedAt: '2026-05-21T13:00:00Z',
    planDir: null,
    linkedAssignmentId: null,
    linkedAssignmentRef: null,
    bundleId: null,
    ...overrides,
  };
}

function bundle(id: string, scope: TodoBundle['scope'], scopeId: string, todoIds: string[], overrides: Partial<TodoBundle> = {}): TodoBundle {
  return {
    id,
    slug: null,
    scope,
    scopeId,
    todoIds,
    planDir: null,
    branch: null,
    worktreePath: null,
    repository: null,
    createdAt: '2026-05-21T13:00:00Z',
    updatedAt: '2026-05-21T13:00:00Z',
    ...overrides,
  };
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-bundle-api-'));
  workspaceTodosDir = resolve(testDir, 'todos');
  projectsDir = resolve(testDir, 'projects');
  await mkdir(workspaceTodosDir, { recursive: true });
  await mkdir(projectsDir, { recursive: true });
});

afterEach(async () => {
  await stopServer();
  await rm(testDir, { recursive: true, force: true });
});

describe('GET /api/bundles', () => {
  it('returns scopes with derivedStatus + resolved members', async () => {
    await writeChecklist(workspaceTodosDir, {
      workspace: '_global',
      archiveInterval: 'weekly',
      items: [
        todo('aaaa', 'one', { bundleId: 'bbbb' }),
        todo('cccc', 'two', { bundleId: 'bbbb', status: 'completed' }),
      ],
    });
    await writeBundles(workspaceTodosDir, [
      bundle('bbbb', 'global', '_global', ['aaaa', 'cccc']),
    ]);
    await startServer();

    const res = await fetch(`${baseUrl}/api/bundles`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scopes).toBeInstanceOf(Array);
    const globalScope = body.scopes.find((s: { scope: string }) => s.scope === 'global');
    expect(globalScope.bundles).toHaveLength(1);
    expect(globalScope.bundles[0].id).toBe('bbbb');
    expect(globalScope.bundles[0].members).toHaveLength(2);
    expect(globalScope.bundles[0].derivedStatus.status).toBe('mixed');
    expect(globalScope.bundles[0].derivedStatus.counts).toEqual({
      open: 1,
      in_progress: 0,
      blocked: 0,
      completed: 1,
      total: 2,
    });
  });

  it('returns empty scopes list when no bundles exist', async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/bundles`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scopes).toBeInstanceOf(Array);
    const globalScope = body.scopes.find((s: { scope: string }) => s.scope === 'global');
    expect(globalScope.bundles).toEqual([]);
  });
});

describe('GET /api/bundles/:workspace', () => {
  it('returns bundles for a single workspace', async () => {
    await writeChecklist(workspaceTodosDir, {
      workspace: 'alpha',
      archiveInterval: 'weekly',
      items: [todo('aaaa', 'one', { bundleId: 'bbbb' }), todo('cccc', 'two', { bundleId: 'bbbb' })],
    });
    await writeBundles(workspaceTodosDir, [bundle('bbbb', 'workspace', 'alpha', ['aaaa', 'cccc'])]);
    await startServer();
    const res = await fetch(`${baseUrl}/api/bundles/alpha`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe('workspace');
    expect(body.scopeId).toBe('alpha');
    expect(body.bundles).toHaveLength(1);
  });

  it('rejects invalid workspace name with 400', async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/bundles/Bad%20Name`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/projects/:projectId/bundles', () => {
  it('returns project bundles', async () => {
    await mkdir(resolve(projectsDir, 'gamma'), { recursive: true });
    await writeFile(
      resolve(projectsDir, 'gamma', 'project.md'),
      `---\nid: gamma-id\nslug: gamma\ntitle: gamma\n---\n# gamma\n`,
    );
    const projectTodos = resolve(projectsDir, 'gamma', 'todos');
    await mkdir(projectTodos, { recursive: true });
    await writeChecklist(projectTodos, {
      workspace: 'gamma',
      archiveInterval: 'weekly',
      items: [todo('aaaa', 'one', { bundleId: 'bbbb' }), todo('cccc', 'two', { bundleId: 'bbbb' })],
    });
    await writeBundles(projectTodos, [bundle('bbbb', 'project', 'gamma', ['aaaa', 'cccc'])]);
    await startServer();

    const res = await fetch(`${baseUrl}/api/projects/gamma/bundles`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe('project');
    expect(body.scopeId).toBe('gamma');
    expect(body.bundles).toHaveLength(1);
    expect(body.bundles[0].id).toBe('bbbb');
  });

  it('returns 404 for unknown project', async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/projects/ghost/bundles`);
    expect(res.status).toBe(404);
  });

  it('rejects invalid project slug with 400', async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/projects/Bad%20Slug/bundles`);
    expect(res.status).toBe(400);
  });
});
