import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { closeSessionDb, initSessionDb } from '../dashboard/session-db.js';
import { createChatRouter } from '../dashboard/api-chat.js';
import { createChatBroker, type ChatBroker } from '../chat/broker.js';
import { connectAcpClient, type AcpClient } from '../chat/acp-client.js';
import { createFakeAgent, textChunk, type FakeAgent, type FakeTurn } from '../chat/fake-agent.js';
import type { WsMessage } from '../dashboard/types.js';

/**
 * Task 7 — the chat router (pattern of `dashboard-api-inbox.test.ts`: a real
 * express app on port 0, on-disk fixtures under a temp SYNTAUR_HOME) plus one
 * real-`ws` test that `chat-item` frames reach a browser client carrying the
 * assignment id.
 */

let sandbox: string;
let projectsDir: string;
let assignmentsDir: string;
let assignmentDir: string;
let worktree: string;
let server: Server;
let baseUrl: string;
let broker: ChatBroker;
let fake: FakeAgent;
let clients: AcpClient[];
let wss: WebSocketServer | null;

const ASSIGNMENT_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

async function boot(turns: FakeTurn[] = [{ steps: [{ kind: 'update', update: textChunk('ok', 'm1') }] }]) {
  fake = createFakeAgent({ turns, sessionIds: ['acp-1'] });
  const wsClients = new Set<WebSocket>();
  const app = express();
  app.use(express.json());
  const http = createServer(app);
  wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (request, socket, head) => {
    if ((request.url ?? '').split('?')[0] !== '/ws') {
      socket.destroy();
      return;
    }
    wss!.handleUpgrade(request, socket, head, (ws) => wss!.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
  });

  const broadcast = (message: WsMessage) => {
    const data = JSON.stringify(message);
    for (const client of wsClients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };

  broker = createChatBroker({
    projectsDir,
    assignmentsDir,
    syntaurHome: sandbox,
    broadcast: (message) => broadcast(message as WsMessage),
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
    timeouts: { flushMs: 1, permissionMs: 500, sessionIdleMs: 60_000 },
  });
  app.use('/api', createChatRouter(projectsDir, assignmentsDir, { broker }));

  server = http;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const url = (path: string) => `${baseUrl}/api${path}`;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-api-chat-'));
  projectsDir = join(sandbox, 'projects');
  assignmentsDir = join(sandbox, 'assignments');
  assignmentDir = join(projectsDir, 'syntaur-meta', 'assignments', 'chat-demo');
  worktree = join(sandbox, 'worktree');
  await mkdir(assignmentDir, { recursive: true });
  await mkdir(assignmentsDir, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(
    join(assignmentDir, 'assignment.md'),
    [
      '---',
      `id: ${ASSIGNMENT_ID}`,
      'slug: chat-demo',
      'title: "Chat demo"',
      'status: ready_to_implement',
      'project: syntaur-meta',
      'workspace:',
      `  repository: ${worktree}`,
      `  worktreePath: ${worktree}`,
      '  branch: feat/chat-demo',
      '---',
      '',
      '# Chat demo',
    ].join('\n'),
    'utf-8',
  );
  clients = [];
  closeSessionDb();
  initSessionDb(join(sandbox, 'syntaur.db'));
});

afterEach(async () => {
  await broker?.stopAll().catch(() => {});
  for (const client of clients) await client.close().catch(() => {});
  wss?.close();
  wss = null;
  await new Promise<void>((r) => server?.close(() => r()));
  closeSessionDb();
  await rm(sandbox, { recursive: true, force: true });
});

describe('GET /api/chat/agents', () => {
  it('lists the builtin definitions with their PATH status', async () => {
    await boot();
    const res = await fetch(url('/chat/agents'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: Array<{ id: string; harness: string; default: boolean; missing: string | null }>;
      errors: string[];
    };
    expect(body.agents.map((a) => a.id)).toEqual(['claude', 'codex', 'cursor']);
    expect(body.agents.find((a) => a.id === 'claude')?.default).toBe(true);
    expect(body.errors).toEqual([]);
    // `missing` is either null (installed on this machine) or the install hint.
    for (const agent of body.agents) {
      expect(agent.missing === null || agent.missing.startsWith('npm i -g')).toBe(true);
    }
  });
});

describe('assignment resolution', () => {
  it('404s on an unknown assignment', async () => {
    await boot();
    for (const path of [
      '/assignments/nope/chat/items',
      '/assignments/nope/chat/session',
      '/assignments/nope/chat/reindex',
    ]) {
      const res = await fetch(url(path), { method: path.endsWith('reindex') ? 'POST' : 'GET' });
      expect(res.status, path).toBe(404);
    }
  });
});

describe('POST /assignments/:id/chat/messages', () => {
  it('accepts a message, streams a reply and records it', async () => {
    await boot();
    const res = await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(202);
    const { messageId } = (await res.json()) as { messageId: string };
    expect(messageId).toMatch(/^[0-9a-f-]{36}$/);

    await waitUntil(() => fake.prompts.length === 1, 'the prompt');
    await waitUntil(
      () => broker.items({ id: ASSIGNMENT_ID } as never, { limit: 50 }).some((i) => i.type === 'agent.message'),
      'the reply item',
    );

    const items = (await (await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/items`))).json()) as {
      items: Array<{ type: string; text?: string }>;
      oldestSeq: number | null;
    };
    expect(items.items.map((i) => i.type)).toContain('user.message');
    expect(items.items.map((i) => i.type)).toContain('agent.message');
    expect(items.oldestSeq).toBe(0);
  });

  it('rejects an empty message with 400', async () => {
    await boot();
    for (const body of [{}, { text: '' }, { text: '   ' }]) {
      const res = await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('falls back to homedir when the workspace has no valid cwd', async () => {
    await boot();
    await writeFile(
      join(assignmentDir, 'assignment.md'),
      [
        '---',
        `id: ${ASSIGNMENT_ID}`,
        'slug: chat-demo',
        'project: syntaur-meta',
        'workspace:',
        '  repository: /nope/nowhere',
        '  worktreePath: /nope/nowhere',
        '---',
        '# Chat demo',
      ].join('\n'),
      'utf-8',
    );
    const res = await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    // No longer a 409 — the chat falls back to the home directory.
    expect(res.status).toBe(202);
  });

  it('404s for an unknown agent id', async () => {
    await boot();
    const res = await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi', agentId: 'nobody' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /assignments/:id/chat/messages/:messageId (Task 1, Decision 3)', () => {
  const state = async (messageId: string) =>
    fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages/${encodeURIComponent(messageId)}`));

  it('reports `ended` once the message’s turn has finished', async () => {
    await boot();
    const res = await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    const { messageId } = (await res.json()) as { messageId: string };

    await waitUntil(
      () =>
        broker
          .items({ id: ASSIGNMENT_ID } as never, { limit: 50 })
          .some((i) => i.type === 'turn.status' && (i as { state: string }).state === 'ended'),
      'the turn to end',
    );

    const got = await state(messageId);
    expect(got.status).toBe(200);
    const body = (await got.json()) as { state: string; stopReason?: string };
    expect(body.state).toBe('ended');
    expect(body.stopReason).toBe('end_turn');
  });

  it('reports `running` while the turn is open, and 404s an id the chat never saw', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await boot([{ steps: [{ kind: 'gate', gate }] }]);

    const res = await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hold' }),
    });
    const { messageId } = (await res.json()) as { messageId: string };
    await waitUntil(() => fake.prompts.length === 1, 'the prompt');

    const open = (await (await state(messageId)).json()) as { state: string };
    expect(open.state).toBe('running');

    // A 404 is "unknown", which the scheduler must NOT read as finished.
    expect((await state('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    release();
  });
});

describe('DELETE /assignments/:id/chat/messages/:messageId', () => {
  it('withdraws a queued message and 409s once it is gone', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await boot([{ steps: [{ kind: 'gate', gate }] }, { steps: [] }]);

    await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'A' }),
    });
    await waitUntil(() => fake.prompts.length === 1, 'the first prompt');

    const queued = (await (
      await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'B' }),
      })
    ).json()) as { messageId: string };

    const del = await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages/${queued.messageId}`), {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ withdrawn: true });

    const again = await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages/${queued.messageId}`), {
      method: 'DELETE',
    });
    expect(again.status).toBe(409);
    release();
  });
});

describe('POST /assignments/:id/chat/cancel', () => {
  it('cancels the running turn and reports false when nothing is running', async () => {
    await boot([{ steps: [{ kind: 'awaitCancel' }] }]);
    const idle = await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/cancel`), { method: 'POST' });
    expect(await idle.json()).toEqual({ cancelled: false });

    await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'essay' }),
    });
    await waitUntil(() => fake.prompts.length === 1, 'the prompt');

    const res = await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/cancel`), { method: 'POST' });
    expect(await res.json()).toEqual({ cancelled: true });
  });
});

describe('POST /assignments/:id/chat/permissions/:requestId', () => {
  it('answers a pending request and 409s an unknown one', async () => {
    await boot([
      {
        steps: [
          {
            kind: 'permission',
            request: {
              toolCall: { toolCallId: 't1', title: 'Run `ls`' },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
              ],
            },
          },
        ],
      },
    ]);
    await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'run it' }),
    });

    let requestId = '';
    await waitUntil(() => {
      const items = broker.items({ id: ASSIGNMENT_ID } as never, { limit: 50 });
      const perm = items.find((i) => i.type === 'permission.request') as { requestId: string } | undefined;
      if (perm) requestId = perm.requestId;
      return Boolean(perm);
    }, 'the permission item');

    const bad = await fetch(
      url(`/assignments/${ASSIGNMENT_ID}/chat/permissions/${encodeURIComponent(requestId)}`),
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
    );
    expect(bad.status).toBe(400);

    const ok = await fetch(
      url(`/assignments/${ASSIGNMENT_ID}/chat/permissions/${encodeURIComponent(requestId)}`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optionId: 'allow' }),
      },
    );
    expect(ok.status).toBe(200);
    expect(fake.permissionAnswers[0]).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });

    const gone = await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/permissions/nope`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: 'allow' }),
    });
    expect(gone.status).toBe(409);
  });

  it('forwards allowAllSession to the broker', async () => {
    await boot([
      {
        steps: [
          {
            kind: 'permission',
            request: {
              toolCall: { toolCallId: 't1', title: 'First' },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
              ],
            },
          },
          {
            kind: 'permission',
            request: {
              toolCall: { toolCallId: 't2', title: 'Second' },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
              ],
            },
          },
        ],
      },
    ]);
    await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'run both' }),
    });

    let requestId = '';
    await waitUntil(() => {
      const items = broker.items({ id: ASSIGNMENT_ID } as never, { limit: 50 });
      const perm = items.find((i) => i.type === 'permission.request') as { requestId: string } | undefined;
      if (perm) requestId = perm.requestId;
      return Boolean(perm);
    }, 'the permission item');

    const bad = await fetch(
      url(`/assignments/${ASSIGNMENT_ID}/chat/permissions/${encodeURIComponent(requestId)}`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optionId: 'allow', allowAllSession: 'yes' }),
      },
    );
    expect(bad.status).toBe(400);

    const ok = await fetch(
      url(`/assignments/${ASSIGNMENT_ID}/chat/permissions/${encodeURIComponent(requestId)}`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optionId: 'allow', allowAllSession: true }),
      },
    );
    expect(ok.status).toBe(200);
    await waitUntil(() => fake.permissionAnswers.length === 2, 'both permissions answered');
    expect(fake.permissionAnswers[1]).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });
});

describe('GET /assignments/:id/chat/session and POST reindex', () => {
  it('reports the session and rebuilds the index from the log', async () => {
    await boot();
    const before = (await (
      await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/session`))
    ).json()) as { session: { state: string; harness: string; acpSessionId: string | null } };
    expect(before.session).toMatchObject({ state: 'none', harness: 'claude', acpSessionId: null });

    await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    await waitUntil(
      () =>
        broker.items({ id: ASSIGNMENT_ID } as never, { limit: 50 }).some((i) => i.type === 'agent.message'),
      'the reply',
    );

    const after = (await (
      await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/session`))
    ).json()) as { session: { acpSessionId: string | null; model: string | null } };
    expect(after.session.acpSessionId).toBe('acp-1');

    const items = (await (await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/items`))).json()) as {
      items: unknown[];
    };
    const rebuilt = (await (
      await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/reindex`), { method: 'POST' })
    ).json()) as { events: number; items: number };
    expect(rebuilt.events).toBeGreaterThan(0);
    expect(rebuilt.items).toBe(items.items.length);

    const afterRebuild = (await (
      await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/items`))
    ).json()) as { items: unknown[] };
    expect(afterRebuild.items).toEqual(items.items);
  });

  it('pages items with ?before and ?limit', async () => {
    await boot([{ steps: [] }, { steps: [] }, { steps: [] }]);
    for (const text of ['one', 'two', 'three']) {
      await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      await waitUntil(() => fake.prompts.some((p) => JSON.stringify(p).includes(text)), `prompt ${text}`);
    }
    await waitUntil(
      () =>
        broker
          .items({ id: ASSIGNMENT_ID } as never, { limit: 100 })
          .filter((i) => i.type === 'turn.status')
          .every((i) => (i as { state: string }).state === 'ended'),
      'all turns to end',
    );

    const page = (await (
      await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/items?limit=2`))
    ).json()) as { items: Array<{ seqFirst: number }>; oldestSeq: number };
    expect(page.items).toHaveLength(2);
    const older = (await (
      await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/items?limit=2&before=${page.oldestSeq}`))
    ).json()) as { items: Array<{ seqFirst: number }> };
    expect(older.items.every((i) => i.seqFirst < page.oldestSeq)).toBe(true);
  });
});

describe('/ws chat frames', () => {
  it('delivers chat-item frames carrying the assignment id to a real client', async () => {
    await boot();
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
    const received: WsMessage[] = [];
    ws.on('message', (data) => received.push(JSON.parse(String(data)) as WsMessage));
    await new Promise<void>((r) => ws.on('open', () => r()));

    await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });

    await waitUntil(
      () =>
        received.some(
          (m) =>
            m.type === 'chat-item' &&
            (m.payload as { patch: { item?: { type: string } } }).patch.item?.type === 'agent.message',
        ),
      'a chat-item frame for the reply',
    );

    const itemFrames = received.filter((m) => m.type === 'chat-item');
    for (const frame of itemFrames) {
      const payload = frame.payload as { assignmentId: string; patch: { op: string } };
      expect(payload.assignmentId).toBe(ASSIGNMENT_ID);
      expect(payload.patch.op).toMatch(/^(upsert|retract)$/);
      expect(frame.assignmentSlug).toBe('chat-demo');
    }
    const sessionFrames = received.filter((m) => m.type === 'chat-session');
    expect(sessionFrames.length).toBeGreaterThan(0);
    expect((sessionFrames[0].payload as { agentId: string }).agentId).toBe('claude');

    ws.close();
  });
});

describe('participants routes (Task 1, Decision 1)', () => {
  it('reports the derived default and every definition', async () => {
    await boot();
    const res = await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/participants`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      participants: { agents: string[]; defaultAgent: string | null };
      agents: Array<{ id: string; respondsTo: string; avatar: string; source: string | null }>;
    };
    expect(body.participants.agents).toEqual(['claude', 'codex', 'cursor']);
    expect(body.participants.defaultAgent).toBe('claude');
    // The widened summary: `respondsTo`, model/mode/effort, avatar and the
    // definition path the picker shows read-only.
    expect(body.agents.map((a) => a.id)).toEqual(['claude', 'codex', 'cursor']);
    expect(body.agents[0].respondsTo).toBe('mentions');
    expect(body.agents[0].avatar).toBe('C');
    expect(body.agents[0].source).toBeNull();
  });

  it('persists a PUT, broadcasts chat-participants and reads back', async () => {
    await boot();
    const frames: Array<{ type: string; payload: unknown }> = [];
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
    await new Promise<void>((r) => ws.on('open', () => r()));
    ws.on('message', (data) => frames.push(JSON.parse(String(data))));

    const res = await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/participants`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agents: ['codex'], defaultAgent: 'codex', hopBudget: 2 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { participants: unknown }).participants).toEqual({
      agents: ['codex'],
      defaultAgent: 'codex',
      hopBudget: 2,
    });

    await waitUntil(() => frames.some((f) => f.type === 'chat-participants'), 'a chat-participants frame');
    const frame = frames.find((f) => f.type === 'chat-participants')!;
    expect((frame.payload as { assignmentId: string }).assignmentId).toBe(ASSIGNMENT_ID);
    expect((frame.payload as { participants: { defaultAgent: string } }).participants.defaultAgent).toBe(
      'codex',
    );

    const reread = (await (
      await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/participants`))
    ).json()) as { participants: { agents: string[] } };
    expect(reread.participants.agents).toEqual(['codex']);
    ws.close();
  });

  it('rejects an unknown id with 400', async () => {
    await boot();
    const res = await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/participants`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agents: ['ghost'], defaultAgent: null }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('ghost');
  });

  it('rejects a default that is not attached with 400', async () => {
    await boot();
    const res = await fetch(url(`/assignments/${ASSIGNMENT_ID}/chat/participants`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agents: ['claude'], defaultAgent: 'codex' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s for an assignment that does not exist', async () => {
    await boot();
    const res = await fetch(url('/assignments/00000000-0000-4000-8000-000000000999/chat/participants'));
    expect(res.status).toBe(404);
  });
});
