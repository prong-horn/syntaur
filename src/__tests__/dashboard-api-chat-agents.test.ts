import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { closeSessionDb, initSessionDb } from '../dashboard/session-db.js';
import { createChatRouter } from '../dashboard/api-chat.js';
import { createChatAgentsRouter } from '../dashboard/api-chat-agents.js';
import { createChatBroker, type ChatBroker } from '../chat/broker.js';
import { connectAcpClient, type AcpClient } from '../chat/acp-client.js';
import { createFakeAgent, textChunk } from '../chat/fake-agent.js';
import { HARNESSES } from '../chat/harnesses.js';
import type { WsMessage } from '../dashboard/types.js';
import { fakeCommandResolver, missingCommandResolver } from './helpers/fake-command-resolver.js';
import { waitUntil } from './helpers/wait-until.js';

let sandbox: string;
let server: Server;
let baseUrl: string;
let broker: ChatBroker;
let clients: AcpClient[];
let wsClients: Set<WebSocket>;
let prevHome: string | undefined;

const authOk = () => 'logged in';

const plannerInput = {
  name: 'Planner',
  color: 'amber' as const,
  harness: 'claude' as const,
  respondsTo: 'mentions' as const,
  default: false,
  systemPrompt: 'You plan things.',
};

async function boot() {
  wsClients = new Set();
  const fake = createFakeAgent({
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'claude-opus-5',
        options: [{ value: 'claude-opus-5', name: 'Opus' }],
      },
    ],
    turns: [{ steps: [{ kind: 'update', update: textChunk('OK') }], stopReason: 'end_turn' }],
  });
  const app = express();
  app.use(express.json());
  const http = createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (request, socket, head) => {
    if ((request.url ?? '').split('?')[0] !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
  });

  broker = createChatBroker({
    projectsDir: join(sandbox, 'projects'),
    syntaurHome: sandbox,
    broadcast: (message) => {
      const data = JSON.stringify(message as WsMessage);
      for (const client of wsClients) {
        if (client.readyState === WebSocket.OPEN) client.send(data);
      }
    },
    clientFactory: (input) => {
      const client = connectAcpClient(fake.app, {
        onUpdate: input.onUpdate,
        onPermissionRequest: input.onPermissionRequest,
        onExtRequest: input.onExtRequest,
        onExtNotification: input.onExtNotification,
      });
      clients.push(client);
      return client;
    },
    commandResolver: fakeCommandResolver,
    authProber: authOk,
    timeouts: { flushMs: 1 },
  });
  app.use('/api', createChatRouter(join(sandbox, 'projects'), { broker }));
  app.use('/api', createChatAgentsRouter({ broker, syntaurHome: sandbox }));

  server = http;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const url = (path: string) => `${baseUrl}/api${path}`;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-api-chat-agents-'));
  clients = [];
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = sandbox;
  initSessionDb(join(sandbox, 'syntaur.db'));
  await boot();
});

afterEach(async () => {
  await broker?.stopAll().catch(() => {});
  await new Promise<void>((r) => server?.close(() => r()));
  closeSessionDb();
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('chat agents API', () => {
  it('creates, lists, updates and deletes an agent', async () => {
    const create = await fetch(url('/chat/agents/planner'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(plannerInput),
    });
    expect(create.status).toBe(201);
    const created = await create.json();
    expect(created.agent.id).toBe('planner');
    expect(created.agent.source).toContain('planner.md');
    expect(created.agent.overridesBuiltin).toBe(false);

    const list = await fetch(url('/chat/agents'));
    const listed = await list.json();
    expect(listed.agents.some((a: { id: string }) => a.id === 'planner')).toBe(true);

    const put = await fetch(url('/chat/agents/planner'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...plannerInput, name: 'Planner v2' }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).agent.name).toBe('Planner v2');

    const del = await fetch(url('/chat/agents/planner'), { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await del.json()).restoredBuiltin).toBe(false);
  });

  it('rejects invalid colour with the validator sentence', async () => {
    const res = await fetch(url('/chat/agents/bad'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...plannerInput, id: 'bad', color: 'purple' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/color.*violet/);
    expect(body.error).not.toMatch(/\//);
  });

  it('round-trips permissions: auto through PUT and GET', async () => {
    await fetch(url('/chat/agents/planner'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...plannerInput, id: 'planner' }),
    });
    const put = await fetch(url('/chat/agents/planner'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...plannerInput, id: 'planner', permissions: 'auto' }),
    });
    expect(put.status).toBe(200);
    const get = await fetch(url('/chat/agents/planner'));
    expect((await get.json()).definition.permissions).toBe('auto');
  });

  it('rejects invalid permissions with the validator message', async () => {
    await fetch(url('/chat/agents/planner'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...plannerInput, id: 'planner' }),
    });
    const res = await fetch(url('/chat/agents/planner'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...plannerInput, id: 'planner', permissions: 'sometimes' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/permissions.*must be one of ask, auto/);
  });

  it('returns 409 when creating an existing file', async () => {
    await fetch(url('/chat/agents/planner'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(plannerInput),
    });
    const res = await fetch(url('/chat/agents/planner'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(plannerInput),
    });
    expect(res.status).toBe(409);
  });

  it('overrides and restores claude', async () => {
    const put = await fetch(url('/chat/agents/claude'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Claude override',
        color: 'violet',
        harness: 'claude',
        respondsTo: 'mentions',
        default: true,
        systemPrompt: '',
      }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).agent.overridesBuiltin).toBe(true);

    const del = await fetch(url('/chat/agents/claude'), { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await del.json()).restoredBuiltin).toBe(true);

    const get = await fetch(url('/chat/agents/claude'));
    expect((await get.json()).definition.source).toBeNull();
  });

  it('refuses deleting codex with no file', async () => {
    const res = await fetch(url('/chat/agents/codex'), { method: 'DELETE' });
    expect(res.status).toBe(409);
  });

  it('rejects path traversal ids on get and test', async () => {
    const get = await fetch(url('/chat/agents/..%2Fx'));
    expect(get.status).toBe(400);

    const test = await fetch(url('/chat/agents/..%2Fx/test'), { method: 'POST' });
    expect(test.status).toBe(400);
  });

  it('rejects path traversal ids on create and delete', async () => {
    const sentinel = join(sandbox, 'sentinel.txt');
    await writeFile(sentinel, 'keep');
    const encoded = '..%2F..%2Fsentinel';

    const post = await fetch(url(`/chat/agents/${encoded}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(plannerInput),
    });
    expect(post.status).toBe(400);
    expect(await readFile(sentinel, 'utf-8')).toBe('keep');

    const del = await fetch(url(`/chat/agents/${encoded}`), { method: 'DELETE' });
    expect(del.status).toBe(400);
    expect(await readFile(sentinel, 'utf-8')).toBe('keep');
  });

  it('broadcasts chat-agents after save', async () => {
    const frames: WsMessage[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (data) => frames.push(JSON.parse(String(data)) as WsMessage));
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    await fetch(url('/chat/agents/planner'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(plannerInput),
    });
    await waitUntil(() => frames.some((f) => f.type === 'chat-agents'), 'the chat-agents broadcast');
    ws.close();
    expect(frames.some((f) => f.type === 'chat-agents')).toBe(true);
  });

  it('lists harnesses and refreshes options', async () => {
    const before = await fetch(url('/chat/harnesses'));
    const listed = await before.json();
    const claude = listed.harnesses.find((h: { id: string }) => h.id === 'claude');
    expect(claude.options).toBeNull();
    expect(claude.auth.state).toBe('unknown');

    const refresh = await fetch(url('/chat/harnesses/claude/refresh'), { method: 'POST' });
    expect(refresh.status).toBe(200);
    expect((await refresh.json()).harness.options?.options.length).toBeGreaterThan(0);
  });

  it('tests an agent and returns 503 when adapter missing', async () => {
    await fetch(url('/chat/agents/planner'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(plannerInput),
    });
    const test = await fetch(url('/chat/agents/planner/test'), { method: 'POST' });
    expect(test.status).toBe(200);
    expect((await test.json()).reply).toBe('OK');

    await broker.stopAll();
    const missing = createChatBroker({
      projectsDir: join(sandbox, 'projects'),
      syntaurHome: sandbox,
      broadcast: () => {},
      commandResolver: missingCommandResolver,
      authProber: authOk,
    });
    const app2 = express();
    app2.use(express.json());
    app2.use('/api', createChatAgentsRouter({ broker: missing, syntaurHome: sandbox }));
    const http2 = createServer(app2);
    await new Promise<void>((r) => http2.listen(0, '127.0.0.1', r));
    const port2 = (http2.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port2}/api/chat/harnesses/claude/refresh`, { method: 'POST' });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain(HARNESSES.claude.installHint);
    await new Promise<void>((r) => http2.close(() => r()));
  });
});
