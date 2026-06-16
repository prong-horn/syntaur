import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createTodosRouter } from '../dashboard/api-todos.js';
import { createProjectTodosRouter } from '../dashboard/api-project-todos.js';
import {
  writeChecklist,
  appendLogEntry,
  readLog,
  logPath,
} from '../todos/parser.js';
import type { TodoChecklist, LogEntry, TodoItem } from '../todos/types.js';
import type { WsMessage } from '../dashboard/types.js';

let testDir: string;
let server: Server;
let baseUrl: string;

function makeItem(over: Partial<TodoItem> & { id: string; description: string; status: TodoItem['status'] }): TodoItem {
  return {
    tags: [],
    session: null,
    branch: null,
    worktreePath: null,
    createdAt: null,
    updatedAt: null,
    planDir: null,
    linkedAssignmentId: null,
    linkedAssignmentRef: null,
    bundleId: null,
    ...over,
  };
}

function makeEntry(over: Partial<LogEntry> & { timestamp: string; itemIds: string[] }): LogEntry {
  return {
    items: '',
    session: null,
    branch: null,
    summary: '',
    blockers: null,
    status: null,
    ...over,
  };
}

async function startServer(projectsDir: string, workspaceTodosDir: string): Promise<void> {
  const app = express();
  app.use(express.json());
  const broadcast = (_msg: WsMessage): void => {};
  app.use('/api/todos', createTodosRouter(workspaceTodosDir, broadcast, projectsDir));
  app.use(
    '/api/projects/:projectId/todos',
    createProjectTodosRouter(projectsDir, broadcast, workspaceTodosDir),
  );
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
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-archive-trim-test-'));
});

afterEach(async () => {
  await stopServer();
  await rm(testDir, { recursive: true, force: true });
});

describe('B3 — archive trims the active -log.md', () => {
  it('(a) workspace archive removes archived entries from -log.md and (b) a surviving entry keeps its status', async () => {
    const workspace = 'alpha';
    const todosDir = resolve(testDir, 'todos');
    const projectsDir = resolve(testDir, 'projects');
    await mkdir(todosDir, { recursive: true });
    await mkdir(projectsDir, { recursive: true });

    const checklist: TodoChecklist = {
      workspace,
      archiveInterval: 'weekly',
      items: [
        makeItem({ id: 'aaaa', description: 'done task', status: 'completed' }),
        makeItem({ id: 'bbbb', description: 'open task', status: 'open' }),
      ],
    };
    await writeChecklist(todosDir, checklist);

    // Entry for the completed todo (should be archived/removed) — carries a status.
    await appendLogEntry(
      todosDir,
      workspace,
      makeEntry({
        timestamp: '2026-04-07T10:00:00Z',
        itemIds: ['aaaa'],
        items: 'done task',
        summary: 'finished it',
        status: 'completed',
      }),
    );
    // Entry for the still-open todo (must survive) — carries a status to assert preservation.
    await appendLogEntry(
      todosDir,
      workspace,
      makeEntry({
        timestamp: '2026-04-07T11:00:00Z',
        itemIds: ['bbbb'],
        items: 'open task',
        summary: 'in progress',
        status: 'in_progress',
      }),
    );

    await startServer(projectsDir, todosDir);

    const res = await fetch(`${baseUrl}/api/todos/${workspace}/archive`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archived).toBe(1);
    expect(body.logEntries).toBe(1);

    // (a) The archived entry is gone from the active log.
    const raw = await readFile(logPath(todosDir, workspace), 'utf-8');
    expect(raw).not.toContain('t:aaaa');
    expect(raw).not.toContain('finished it');

    // The active log still parses and contains only the surviving entry.
    const log = await readLog(todosDir, workspace);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].itemIds).toEqual(['bbbb']);
    // (b) The surviving entry retains its status (canonical serializer preserves it).
    expect(log.entries[0].status).toBe('in_progress');
    expect(raw).toContain('**Status:** in_progress');
  });

  it('project archive also trims the active -log.md', async () => {
    const slug = 'beta';
    const workspaceTodosDir = resolve(testDir, 'todos');
    const projectsDir = resolve(testDir, 'projects');
    await mkdir(workspaceTodosDir, { recursive: true });
    await mkdir(resolve(projectsDir, slug), { recursive: true });
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(
        resolve(projectsDir, slug, 'project.md'),
        `---\nid: ${slug}-id\nslug: ${slug}\ntitle: ${slug}\n---\n# ${slug}\n`,
        'utf-8',
      ),
    );

    const projTodosDir = resolve(projectsDir, slug, 'todos');
    await mkdir(projTodosDir, { recursive: true });
    await writeChecklist(projTodosDir, {
      workspace: slug,
      archiveInterval: 'weekly',
      items: [
        makeItem({ id: 'cccc', description: 'proj done', status: 'completed' }),
        makeItem({ id: 'dddd', description: 'proj open', status: 'open' }),
      ],
    });
    await appendLogEntry(
      projTodosDir,
      slug,
      makeEntry({ timestamp: '2026-04-08T10:00:00Z', itemIds: ['cccc'], summary: 'proj finished', status: 'completed' }),
    );
    await appendLogEntry(
      projTodosDir,
      slug,
      makeEntry({ timestamp: '2026-04-08T11:00:00Z', itemIds: ['dddd'], summary: 'proj wip', status: 'in_progress' }),
    );

    await startServer(projectsDir, workspaceTodosDir);

    const res = await fetch(`${baseUrl}/api/projects/${slug}/todos/archive`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).archived).toBe(1);

    const raw = await readFile(logPath(projTodosDir, slug), 'utf-8');
    expect(raw).not.toContain('t:cccc');
    const log = await readLog(projTodosDir, slug);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].itemIds).toEqual(['dddd']);
    expect(log.entries[0].status).toBe('in_progress');
  });
});
