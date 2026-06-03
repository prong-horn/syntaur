import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createProjectTodosRouter } from '../dashboard/api-project-todos.js';
import { createTodosRouter } from '../dashboard/api-todos.js';
import { attachmentDirFor } from '../todos/attachments.js';
import type { WsMessage } from '../dashboard/types.js';

let testDir: string;
let projectsDir: string;
let workspaceTodosDir: string;
let server: Server;
let baseUrl: string;

async function seedProject(slug: string): Promise<void> {
  await mkdir(resolve(projectsDir, slug), { recursive: true });
  await writeFile(
    resolve(projectsDir, slug, 'project.md'),
    `---\nid: ${slug}-id\nslug: ${slug}\ntitle: ${slug}\n---\n# ${slug}\n`,
    'utf-8',
  );
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());
  const broadcast = (_msg: WsMessage): void => {};
  app.use('/api/todos', createTodosRouter(workspaceTodosDir, broadcast, projectsDir));
  app.use('/api/projects/:projectId/todos', createProjectTodosRouter(projectsDir, broadcast, workspaceTodosDir));
  await new Promise<void>((resolvePromise) => {
    const listening = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
      resolvePromise();
    });
    server = listening;
  });
}

async function stopServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-todo-attach-'));
  projectsDir = resolve(testDir, 'projects');
  workspaceTodosDir = resolve(testDir, 'todos');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(workspaceTodosDir, { recursive: true });
  await startServer();
});

afterEach(async () => {
  await stopServer();
  await rm(testDir, { recursive: true, force: true });
});

// --- helpers -----------------------------------------------------------------

async function addWorkspaceTodo(ws: string, description: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/todos/${ws}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

async function addProjectTodo(slug: string, description: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/projects/${slug}/todos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

function uploadUrlWs(ws: string, id: string): string {
  return `${baseUrl}/api/todos/${ws}/${id}/attachments`;
}

async function upload(url: string, filename: string, bytes: Buffer): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-attachment-filename': encodeURIComponent(filename),
    },
    body: new Uint8Array(bytes),
  });
}

// --- workspace scope ---------------------------------------------------------

describe('todo attachments — workspace scope', () => {
  it('uploads, lists, serves exact bytes, and deletes', async () => {
    const ws = 'myws';
    const id = await addWorkspaceTodo(ws, 'has attachments');
    const bytes = Buffer.from([1, 2, 3, 4, 255, 0, 42]);

    const up = await upload(uploadUrlWs(ws, id), 'shot.png', bytes);
    expect(up.status).toBe(201);
    const att = await up.json();
    expect(att.filename).toBe('shot.png');
    expect(att.mime).toBe('image/png');
    expect(att.size).toBe(bytes.length);

    // list GET includes it
    const list = await (await fetch(`${baseUrl}/api/todos/${ws}`)).json();
    const item = list.items.find((i: { id: string }) => i.id === id);
    expect(item.attachments).toHaveLength(1);
    expect(item.attachments[0].id).toBe(att.id);

    // single GET includes it
    const single = await (await fetch(`${baseUrl}/api/todos/${ws}/${id}`)).json();
    expect(single.attachments).toHaveLength(1);

    // GET serves the exact bytes, inline, with nosniff
    const fileRes = await fetch(`${baseUrl}/api/todos/${ws}/${id}/attachments/${att.id}`);
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get('content-type')).toBe('image/png');
    expect(fileRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(fileRes.headers.get('content-disposition')).toMatch(/^inline/);
    const served = Buffer.from(await fileRes.arrayBuffer());
    expect(served.equals(bytes)).toBe(true);

    // delete attachment
    const del = await fetch(`${baseUrl}/api/todos/${ws}/${id}/attachments/${att.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const after = await (await fetch(`${baseUrl}/api/todos/${ws}/${id}`)).json();
    expect(after.attachments).toHaveLength(0);
  });

  it('does not let global express.json() eat a .json upload', async () => {
    const ws = 'myws';
    const id = await addWorkspaceTodo(ws, 'json file');
    const bytes = Buffer.from('{"hello":"world"}', 'utf-8');
    const up = await upload(uploadUrlWs(ws, id), 'data.json', bytes);
    expect(up.status).toBe(201);
    const att = await up.json();
    const fileRes = await fetch(`${baseUrl}/api/todos/${ws}/${id}/attachments/${att.id}`);
    const served = Buffer.from(await fileRes.arrayBuffer());
    expect(served.equals(bytes)).toBe(true);
    // application/json is not in the safe-inline allowlist → forced download.
    expect(fileRes.headers.get('content-disposition')).toMatch(/^attachment/);
  });

  it('forces unsafe types (svg) to download with nosniff', async () => {
    const ws = 'myws';
    const id = await addWorkspaceTodo(ws, 'svg file');
    const up = await upload(uploadUrlWs(ws, id), 'x.svg', Buffer.from('<svg/>', 'utf-8'));
    const att = await up.json();
    const fileRes = await fetch(`${baseUrl}/api/todos/${ws}/${id}/attachments/${att.id}`);
    expect(fileRes.headers.get('content-type')).toBe('application/octet-stream');
    expect(fileRes.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(fileRes.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('rejects empty body and bad filename header', async () => {
    const ws = 'myws';
    const id = await addWorkspaceTodo(ws, 'guards');
    const empty = await upload(uploadUrlWs(ws, id), 'e.png', Buffer.alloc(0));
    expect(empty.status).toBe(400);
    const badName = await fetch(uploadUrlWs(ws, id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-attachment-filename': '%ZZ' },
      body: new Uint8Array([1]),
    });
    expect(badName.status).toBe(400);
  });

  it('rejects a malformed attachment id (400) and 404s an unknown one', async () => {
    const ws = 'myws';
    const id = await addWorkspaceTodo(ws, 'sec');
    await upload(uploadUrlWs(ws, id), 'a.png', Buffer.from([1, 2, 3]));
    const bad = await fetch(`${baseUrl}/api/todos/${ws}/${id}/attachments/not_a_valid_id`);
    expect(bad.status).toBe(400);
    const missing = await fetch(`${baseUrl}/api/todos/${ws}/${id}/attachments/zzzzzzzz-abcd`);
    expect(missing.status).toBe(404);
  });

  it('404s an upload to an unknown todo', async () => {
    const res = await upload(uploadUrlWs('myws', 'beef'), 'a.png', Buffer.from([1]));
    expect(res.status).toBe(404);
  });

  it('deleting a todo removes its attachment dir', async () => {
    const ws = 'myws';
    const id = await addWorkspaceTodo(ws, 'doomed');
    await upload(uploadUrlWs(ws, id), 'a.png', Buffer.from([9, 9, 9]));
    const dir = attachmentDirFor(workspaceTodosDir, ws, id);
    await stat(dir); // exists
    const del = await fetch(`${baseUrl}/api/todos/${ws}/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('archiving a completed todo removes its attachments', async () => {
    const ws = 'myws';
    const id = await addWorkspaceTodo(ws, 'to archive');
    await upload(uploadUrlWs(ws, id), 'a.png', Buffer.from([1, 1]));
    await fetch(`${baseUrl}/api/todos/${ws}/${id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'done' }),
    });
    const dir = attachmentDirFor(workspaceTodosDir, ws, id);
    await stat(dir); // exists
    const arch = await fetch(`${baseUrl}/api/todos/${ws}/archive`, { method: 'POST' });
    expect(arch.status).toBe(200);
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('isolates attachments across workspaces that share a todo id', async () => {
    // Force the same 4-hex id in two workspaces by retrying until they collide is
    // impractical; instead assert that each workspace's attachment dir is scoped by
    // workspace name, so even identical ids cannot collide on disk.
    const a = await addWorkspaceTodo('wsa', 'a');
    const b = await addWorkspaceTodo('wsb', 'b');
    await upload(uploadUrlWs('wsa', a), 'a.png', Buffer.from([1]));
    await upload(uploadUrlWs('wsb', b), 'b.png', Buffer.from([2, 2]));
    const dirA = attachmentDirFor(workspaceTodosDir, 'wsa', a);
    const dirB = attachmentDirFor(workspaceTodosDir, 'wsb', b);
    expect(dirA).not.toBe(dirB);
    expect(dirA).toContain('/attachments/wsa/');
    expect(dirB).toContain('/attachments/wsb/');
    // wsb's list is unaffected by wsa's attachment
    const listB = await (await fetch(`${baseUrl}/api/todos/wsb`)).json();
    expect(listB.items.find((i: { id: string }) => i.id === b).attachments).toHaveLength(1);
  });

  it('migrates attachments on cross-workspace move and 409s on a target conflict', async () => {
    const id = await addWorkspaceTodo('srca', 'movable');
    const up = await upload(uploadUrlWs('srca', id), 'a.png', Buffer.from([7, 7, 7]));
    const att = await up.json();

    const move = await fetch(`${baseUrl}/api/todos/srca/${id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: { workspace: 'srcb' } }),
    });
    expect(move.status).toBe(200);

    // gone from source, present (with the attachment) in target
    expect((await fetch(`${baseUrl}/api/todos/srca/${id}`)).status).toBe(404);
    const moved = await (await fetch(`${baseUrl}/api/todos/srcb/${id}`)).json();
    expect(moved.attachments).toHaveLength(1);
    const served = await fetch(`${baseUrl}/api/todos/srcb/${id}/attachments/${att.id}`);
    expect(Buffer.from(await served.arrayBuffer()).equals(Buffer.from([7, 7, 7]))).toBe(true);
  });

  it('aborts a move when the target already holds attachments for that id', async () => {
    const id = await addWorkspaceTodo('s1', 'conflict');
    await upload(uploadUrlWs('s1', id), 'a.png', Buffer.from([1]));
    // Pre-seed a target attachment dir for the same id (a synthetic orphan).
    const targetDir = attachmentDirFor(workspaceTodosDir, 's2', id);
    await mkdir(targetDir, { recursive: true });
    await writeFile(resolve(targetDir, 'orphan-0000__x.png'), Buffer.from([0]));

    const move = await fetch(`${baseUrl}/api/todos/s1/${id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: { workspace: 's2' } }),
    });
    expect(move.status).toBe(409);
    // Source untouched (still has the todo + its attachment).
    expect((await fetch(`${baseUrl}/api/todos/s1/${id}`)).status).toBe(200);
  });
});

// --- project scope -----------------------------------------------------------

describe('todo attachments — project scope', () => {
  it('uploads, lists, serves, and deletes for a project todo', async () => {
    await seedProject('proj');
    const id = await addProjectTodo('proj', 'p has attachment');
    const bytes = Buffer.from([5, 6, 7, 8]);

    const up = await upload(`${baseUrl}/api/projects/proj/todos/${id}/attachments`, 'p.png', bytes);
    expect(up.status).toBe(201);
    const att = await up.json();

    const list = await (await fetch(`${baseUrl}/api/projects/proj/todos`)).json();
    expect(list.items.find((i: { id: string }) => i.id === id).attachments).toHaveLength(1);

    const fileRes = await fetch(`${baseUrl}/api/projects/proj/todos/${id}/attachments/${att.id}`);
    expect(Buffer.from(await fileRes.arrayBuffer()).equals(bytes)).toBe(true);

    const del = await fetch(`${baseUrl}/api/projects/proj/todos/${id}/attachments/${att.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const after = await (await fetch(`${baseUrl}/api/projects/proj/todos`)).json();
    expect(after.items.find((i: { id: string }) => i.id === id).attachments).toHaveLength(0);
  });

  it('archiving a completed project todo removes its attachments', async () => {
    await seedProject('proj2');
    const id = await addProjectTodo('proj2', 'archive me');
    await upload(`${baseUrl}/api/projects/proj2/todos/${id}/attachments`, 'a.png', Buffer.from([3, 3]));
    await fetch(`${baseUrl}/api/projects/proj2/todos/${id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'done' }),
    });
    const projTodosDir = resolve(projectsDir, 'proj2', 'todos');
    const dir = attachmentDirFor(projTodosDir, 'proj2', id);
    await stat(dir);
    const arch = await fetch(`${baseUrl}/api/projects/proj2/todos/archive`, { method: 'POST' });
    expect(arch.status).toBe(200);
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
