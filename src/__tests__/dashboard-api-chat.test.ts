import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { closeSessionDb, initSessionDb } from '../dashboard/session-db.js';
import { createChatRouter } from '../dashboard/api-chat.js';
import { MAX_CHAT_ATTACHMENT_BYTES } from '../chat/attachments.js';
import { createChatBroker, type ChatBroker } from '../chat/broker.js';
import { connectAcpClient, type AcpClient } from '../chat/acp-client.js';
import { createFakeAgent, textChunk, type FakeAgent, type FakeTurn } from '../chat/fake-agent.js';
import type { WsMessage } from '../dashboard/types.js';
import { parseDecisionRecord } from '../dashboard/parser.js';

/**
 * Task 7 — the chat router (pattern of `dashboard-api-inbox.test.ts`: a real
 * express app on port 0, on-disk fixtures under a temp SYNTAUR_HOME) plus one
 * real-`ws` test that `chat-item` frames reach a browser client carrying the
 * ticket id.
 */

let sandbox: string;
let projectsDir: string;
let ticketsDir: string;
let ticketDir: string;
let worktree: string;
let server: Server;
let baseUrl: string;
let broker: ChatBroker;
let fake: FakeAgent;
let clients: AcpClient[];
let wss: WebSocketServer | null;

const ASSIGNMENT_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

/** Minimal 1×1 PNG (68 bytes). */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function uploadChatAttachment(
  filename: string,
  bytes: Buffer,
  mime?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-attachment-filename': encodeURIComponent(filename),
  };
  if (mime !== undefined) headers['x-attachment-mime'] = mime;
  return fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/attachments`), {
    method: 'POST',
    headers,
    body: new Uint8Array(bytes),
  });
}

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
    ticketsDir,
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
  app.use('/api', createChatRouter(projectsDir, ticketsDir, { broker }));

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
  ticketsDir = join(sandbox, 'tickets');
  ticketDir = join(projectsDir, 'syntaur-meta', 'tickets', 'chat-demo');
  worktree = join(sandbox, 'worktree');
  await mkdir(ticketDir, { recursive: true });
  await mkdir(ticketsDir, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(
    join(ticketDir, 'ticket.md'),
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
      '/tickets/nope/chat/items',
      '/tickets/nope/chat/session',
      '/tickets/nope/chat/reindex',
    ]) {
      const res = await fetch(url(path), { method: path.endsWith('reindex') ? 'POST' : 'GET' });
      expect(res.status, path).toBe(404);
    }
  });
});

describe('POST /tickets/:id/chat/messages', () => {
  it('accepts a message, streams a reply and records it', async () => {
    await boot();
    const res = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
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

    const items = (await (await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/items`))).json()) as {
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
      const res = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('accepts empty text with one attachment id', async () => {
    await boot();
    const up = await uploadChatAttachment('solo.png', PNG_1X1, 'image/png');
    const att = (await up.json()) as { id: string };
    const res = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '', attachmentIds: [att.id] }),
    });
    expect(res.status).toBe(202);
  });

  it('drops non-finite attachmentMeta dimensions', async () => {
    await boot();
    const up = await uploadChatAttachment('dim.png', PNG_1X1, 'image/png');
    const att = (await up.json()) as { id: string };
    const res = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'dims',
        attachmentIds: [att.id],
        attachmentMeta: { [att.id]: { width: '100', height: 64 } },
      }),
    });
    expect(res.status).toBe(202);
    const items = broker.items({ id: ASSIGNMENT_ID } as never, { limit: 50 });
    const msg = items.find(
      (i) => i.type === 'user.message' && Array.isArray((i as { attachments?: unknown[] }).attachments),
    ) as { attachments?: Array<{ width?: number; height?: number }> } | undefined;
    expect(msg?.attachments?.[0]?.width).toBeUndefined();
    expect(msg?.attachments?.[0]?.height).toBe(64);
  });

  it('rejects unknown and excess attachment ids', async () => {
    await boot();
    const unknown = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi', attachmentIds: ['00000000-0000-4000-8000-000000000099'] }),
    });
    expect(unknown.status).toBe(400);

    const up = await uploadChatAttachment('a.png', PNG_1X1, 'image/png');
    const att = (await up.json()) as { id: string };
    const ids = Array.from({ length: 5 }, (_, i) => (i === 0 ? att.id : `00000000-0000-4000-8000-00000000000${i}`));
    const tooMany = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi', attachmentIds: ids }),
    });
    expect(tooMany.status).toBe(400);
  });

  it('falls back to homedir when the workspace has no valid cwd', async () => {
    await boot();
    await writeFile(
      join(ticketDir, 'ticket.md'),
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
    const res = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    // No longer a 409 — the chat falls back to the home directory.
    expect(res.status).toBe(202);
  });

  it('404s for an unknown agent id', async () => {
    await boot();
    const res = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi', agentId: 'nobody' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /tickets/:id/chat/messages/:messageId (Task 1, Decision 3)', () => {
  const state = async (messageId: string) =>
    fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages/${encodeURIComponent(messageId)}`));

  it('reports `ended` once the message’s turn has finished', async () => {
    await boot();
    const res = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
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

    const res = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
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

describe('DELETE /tickets/:id/chat/messages/:messageId', () => {
  it('withdraws a queued message and 409s once it is gone', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await boot([{ steps: [{ kind: 'gate', gate }] }, { steps: [] }]);

    await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'A' }),
    });
    await waitUntil(() => fake.prompts.length === 1, 'the first prompt');

    const queued = (await (
      await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'B' }),
      })
    ).json()) as { messageId: string };

    const del = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages/${queued.messageId}`), {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ withdrawn: true });

    const again = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages/${queued.messageId}`), {
      method: 'DELETE',
    });
    expect(again.status).toBe(409);
    release();
  });
});

describe('POST /tickets/:id/chat/cancel', () => {
  it('cancels the running turn and reports false when nothing is running', async () => {
    await boot([{ steps: [{ kind: 'awaitCancel' }] }]);
    const idle = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/cancel`), { method: 'POST' });
    expect(await idle.json()).toEqual({ cancelled: false });

    await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'essay' }),
    });
    await waitUntil(() => fake.prompts.length === 1, 'the prompt');

    const res = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/cancel`), { method: 'POST' });
    expect(await res.json()).toEqual({ cancelled: true });
  });
});

describe('POST /tickets/:id/chat/permissions/:requestId', () => {
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
    await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
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
      url(`/tickets/${ASSIGNMENT_ID}/chat/permissions/${encodeURIComponent(requestId)}`),
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
    );
    expect(bad.status).toBe(400);

    const ok = await fetch(
      url(`/tickets/${ASSIGNMENT_ID}/chat/permissions/${encodeURIComponent(requestId)}`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optionId: 'allow' }),
      },
    );
    expect(ok.status).toBe(200);
    expect(fake.permissionAnswers[0]).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });

    const gone = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/permissions/nope`), {
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
    await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
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
      url(`/tickets/${ASSIGNMENT_ID}/chat/permissions/${encodeURIComponent(requestId)}`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optionId: 'allow', allowAllSession: 'yes' }),
      },
    );
    expect(bad.status).toBe(400);

    const ok = await fetch(
      url(`/tickets/${ASSIGNMENT_ID}/chat/permissions/${encodeURIComponent(requestId)}`),
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

describe('GET /tickets/:id/chat/session and POST reindex', () => {
  it('reports the session and rebuilds the index from the log', async () => {
    await boot();
    const before = (await (
      await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/session`))
    ).json()) as { session: { state: string; harness: string; acpSessionId: string | null } };
    expect(before.session).toMatchObject({ state: 'none', harness: 'claude', acpSessionId: null });

    await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
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
      await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/session`))
    ).json()) as { session: { acpSessionId: string | null; model: string | null } };
    expect(after.session.acpSessionId).toBe('acp-1');

    const items = (await (await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/items`))).json()) as {
      items: unknown[];
    };
    const rebuilt = (await (
      await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/reindex`), { method: 'POST' })
    ).json()) as { events: number; items: number };
    expect(rebuilt.events).toBeGreaterThan(0);
    expect(rebuilt.items).toBe(items.items.length);

    const afterRebuild = (await (
      await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/items`))
    ).json()) as { items: unknown[] };
    expect(afterRebuild.items).toEqual(items.items);
  });

  it('pages items with ?before and ?limit', async () => {
    await boot([{ steps: [] }, { steps: [] }, { steps: [] }]);
    for (const text of ['one', 'two', 'three']) {
      await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
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
      await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/items?limit=2`))
    ).json()) as { items: Array<{ seqFirst: number }>; oldestSeq: number };
    expect(page.items).toHaveLength(2);
    const older = (await (
      await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/items?limit=2&before=${page.oldestSeq}`))
    ).json()) as { items: Array<{ seqFirst: number }> };
    expect(older.items.every((i) => i.seqFirst < page.oldestSeq)).toBe(true);
  });
});

describe('/ws chat frames', () => {
  it('delivers chat-item frames carrying the ticket id to a real client', async () => {
    await boot();
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
    const received: WsMessage[] = [];
    ws.on('message', (data) => received.push(JSON.parse(String(data)) as WsMessage));
    await new Promise<void>((r) => ws.on('open', () => r()));

    await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
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
      const payload = frame.payload as { ticketId: string; patch: { op: string } };
      expect(payload.ticketId).toBe(ASSIGNMENT_ID);
      expect(payload.patch.op).toMatch(/^(upsert|retract)$/);
      expect(frame.ticketSlug).toBe('chat-demo');
    }
    const sessionFrames = received.filter((m) => m.type === 'chat-session');
    expect(sessionFrames.length).toBeGreaterThan(0);
    expect((sessionFrames[0].payload as { agentId: string }).agentId).toBe('claude');

    ws.close();
  });
});

describe('chat attachment routes (Task 1)', () => {
  it('uploads a PNG, serves it inline, and stores under chat/attachments', async () => {
    await boot();
    const up = await uploadChatAttachment('dot.png', PNG_1X1, 'image/png');
    expect(up.status).toBe(201);
    const att = (await up.json()) as { id: string; mimeType: string; bytes: number; name: string };
    expect(att.mimeType).toBe('image/png');
    expect(att.bytes).toBe(PNG_1X1.length);
    expect(att.name).toBe('dot.png');
    expect(att.id).toMatch(/^[0-9a-f-]{36}$/);

    const stored = await readdir(join(ticketDir, 'chat', 'attachments'));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toBe(`${att.id}__dot.png.png`);

    const fileRes = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/attachments/${att.id}`));
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get('content-type')).toBe('image/png');
    expect(fileRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(fileRes.headers.get('content-disposition')).toMatch(/^inline/);
    expect(Buffer.from(await fileRes.arrayBuffer()).equals(PNG_1X1)).toBe(true);
  });

  it('rejects unsupported mime, missing mime header, and oversize uploads', async () => {
    await boot();
    const svg = await uploadChatAttachment('x.svg', Buffer.from('<svg/>'), 'image/svg+xml');
    expect(svg.status).toBe(400);

    const noMime = await uploadChatAttachment('a.png', PNG_1X1);
    expect(noMime.status).toBe(400);

    const huge = await uploadChatAttachment(
      'big.png',
      Buffer.alloc(MAX_CHAT_ATTACHMENT_BYTES + 1, 1),
      'image/png',
    );
    expect(huge.status).toBe(413);
  });

  it('uses the mime header for the stored extension and keeps the display name', async () => {
    await boot();
    const up = await uploadChatAttachment('photo.jpg', PNG_1X1, 'image/png');
    expect(up.status).toBe(201);
    const att = (await up.json()) as { id: string; name: string };
    expect(att.name).toBe('photo.jpg');
    const stored = await readdir(join(ticketDir, 'chat', 'attachments'));
    expect(stored[0]).toBe(`${att.id}__photo.jpg.png`);
  });

  it('404s malformed and unknown attachment ids', async () => {
    await boot();
    const bad = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/attachments/not-a-uuid`));
    expect(bad.status).toBe(404);
    const missing = await fetch(
      url(`/tickets/${ASSIGNMENT_ID}/chat/attachments/00000000-0000-4000-8000-000000000099`),
    );
    expect(missing.status).toBe(404);
  });
});

describe('participants routes (Task 1, Decision 1)', () => {
  it('reports the derived default and every definition', async () => {
    await boot();
    const res = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/participants`));
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

    const res = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/participants`), {
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
    expect((frame.payload as { ticketId: string }).ticketId).toBe(ASSIGNMENT_ID);
    expect((frame.payload as { participants: { defaultAgent: string } }).participants.defaultAgent).toBe(
      'codex',
    );

    const reread = (await (
      await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/participants`))
    ).json()) as { participants: { agents: string[] } };
    expect(reread.participants.agents).toEqual(['codex']);
    ws.close();
  });

  it('rejects an unknown id with 400', async () => {
    await boot();
    const res = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/participants`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agents: ['ghost'], defaultAgent: null }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('ghost');
  });

  it('rejects a default that is not attached with 400', async () => {
    await boot();
    const res = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/participants`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agents: ['claude'], defaultAgent: 'codex' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s for a ticket that does not exist', async () => {
    await boot();
    const res = await fetch(url('/tickets/00000000-0000-4000-8000-000000000999/chat/participants'));
    expect(res.status).toBe(404);
  });
});

describe('POST /tickets/:id/chat/items/:itemId/file', () => {
  async function replyItemId(): Promise<string> {
    await boot();
    await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    await waitUntil(() => fake.prompts.length === 1, 'the prompt');
    await waitUntil(
      () =>
        broker
          .items({ id: ASSIGNMENT_ID } as never, { limit: 50 })
          .some((i) => i.type === 'agent.message' && i.sealed),
      'the sealed reply',
    );
    const reply = broker
      .items({ id: ASSIGNMENT_ID } as never, { limit: 50 })
      .find((i) => i.type === 'agent.message' && i.sealed)!;
    return reply.itemId;
  }

  async function fileItem(itemId: string, body: Record<string, unknown>) {
    return fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/items/${encodeURIComponent(itemId)}/file`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('files a sealed reply as a decision with a system row', async () => {
    const itemId = await replyItemId();
    const res = await fileItem(itemId, { kind: 'decision', title: 'Use X', body: 'ok reply text' });
    expect(res.status).toBe(201);
    const { record } = (await res.json()) as { record: { ref: string; label: string } };
    expect(record.ref).toBe('Decision 1');
    expect(record.label).toBe('Decision 1: Use X');

    const decisionMd = await readFile(join(ticketDir, 'decision-record.md'), 'utf-8');
    expect(decisionMd).toContain('## Use X');
    expect(decisionMd).toContain('**Recorded:**');
    expect(decisionMd).toContain('_Filed from chat (@claude,');
    expect(parseDecisionRecord(decisionMd).decisionCount).toBe(1);

    const items = (await (await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/items`))).json()) as {
      items: Array<{ type: string; text?: string }>;
    };
    const filed = items.items.find((i) => i.type === 'system' && i.text?.startsWith('Filed '));
    expect(filed?.text).toContain('Decision 1: Use X');
  });

  it('files a progress entry and bumps entryCount', async () => {
    const itemId = await replyItemId();
    const res = await fileItem(itemId, { kind: 'progress', body: 'Filed manually.' });
    expect(res.status).toBe(201);
    const progressMd = await readFile(join(ticketDir, 'progress.md'), 'utf-8');
    expect(progressMd).toMatch(/entryCount: 1/);
  });

  it('files a comment with author human and default type note', async () => {
    const itemId = await replyItemId();
    const res = await fileItem(itemId, { kind: 'comment', body: 'A note.' });
    expect(res.status).toBe(201);
    const commentsMd = await readFile(join(ticketDir, 'comments.md'), 'utf-8');
    expect(commentsMd).toContain('**Author:** human');
    expect(commentsMd).toContain('**Type:** note');
  });

  it('uses (you, …) provenance for the humans own message filed as progress', async () => {
    await boot();
    const send = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'my thought' }),
    });
    const { messageId } = (await send.json()) as { messageId: string };
    await waitUntil(() => fake.prompts.length === 1, 'the prompt');
    await waitUntil(
      () =>
        broker
          .items({ id: ASSIGNMENT_ID } as never, { limit: 50 })
          .some((i) => i.type === 'user.message' && (i as { messageId: string }).messageId === messageId),
      'the user message item',
    );
    const userItem = broker
      .items({ id: ASSIGNMENT_ID } as never, { limit: 50 })
      .find((i) => i.type === 'user.message' && (i as { messageId: string }).messageId === messageId)!;
    const res = await fileItem(userItem.itemId, { kind: 'progress', body: 'mine' });
    expect(res.status).toBe(201);
    const progressMd = await readFile(join(ticketDir, 'progress.md'), 'utf-8');
    expect(progressMd).toContain('_Filed from chat (you,');
  });

  it('rejects an oversized body with 413', async () => {
    const itemId = await replyItemId();
    const res = await fileItem(itemId, { kind: 'progress', body: 'x'.repeat(100_001) });
    expect(res.status).toBe(413);
  });

  it('rejects filing a withdrawn user message with 400', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await boot([{ steps: [{ kind: 'gate', gate }] }, { steps: [] }]);

    await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'busy turn' }),
    });
    await waitUntil(() => fake.prompts.length === 1, 'the first prompt');

    const queued = (await (
      await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'withdraw me' }),
      })
    ).json()) as { messageId: string };

    const del = await fetch(url(`/tickets/${ASSIGNMENT_ID}/chat/messages/${queued.messageId}`), {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);

    await waitUntil(
      () =>
        broker
          .items({ id: ASSIGNMENT_ID } as never, { limit: 50 })
          .some(
            (i) =>
              i.type === 'user.message' &&
              (i as { messageId: string; state: string }).messageId === queued.messageId &&
              (i as { state: string }).state === 'withdrawn',
          ),
      'the withdrawn user message item',
    );
    const withdrawnItem = broker
      .items({ id: ASSIGNMENT_ID } as never, { limit: 50 })
      .find(
        (i) =>
          i.type === 'user.message' &&
          (i as { messageId: string }).messageId === queued.messageId,
      )!;

    const res = await fileItem(withdrawnItem.itemId, { kind: 'progress', body: 'too late' });
    expect(res.status).toBe(400);
    release();
  });

  it('rejects an invalid commentType with 400', async () => {
    const itemId = await replyItemId();
    const res = await fileItem(itemId, { kind: 'comment', body: 'note', commentType: 'rant' });
    expect(res.status).toBe(400);
  });

  it('rejects a title longer than 200 characters with 400', async () => {
    const itemId = await replyItemId();
    const res = await fileItem(itemId, {
      kind: 'decision',
      title: 'x'.repeat(201),
      body: 'body',
    });
    expect(res.status).toBe(400);
  });

  it('accepts a padded title that trims to 10 characters', async () => {
    const itemId = await replyItemId();
    const res = await fileItem(itemId, {
      kind: 'decision',
      title: `${'a'.repeat(10)}${' '.repeat(191)}`,
      body: 'body',
    });
    expect(res.status).toBe(201);
  });

  it('rejects missing title, multiline title, empty body, bad kind and unknown items', async () => {
    const itemId = await replyItemId();
    expect((await fileItem(itemId, { kind: 'decision', body: 'x' })).status).toBe(400);
    expect((await fileItem(itemId, { kind: 'decision', title: 'a\nb', body: 'x' })).status).toBe(400);
    expect((await fileItem(itemId, { kind: 'progress', body: '   ' })).status).toBe(400);
    expect((await fileItem(itemId, { kind: 'nope', body: 'x' })).status).toBe(400);
    expect((await fileItem('missing-item', { kind: 'progress', body: 'x' })).status).toBe(404);

    const status = broker
      .items({ id: ASSIGNMENT_ID } as never, { limit: 50 })
      .find((i) => i.type === 'turn.status')!;
    expect((await fileItem(status.itemId, { kind: 'progress', body: 'x' })).status).toBe(400);
  });

  it('files a decision on a standalone ticket', async () => {
    const standaloneId = '00000000-0000-4000-8000-0000000000ab';
    const standaloneDir = join(ticketsDir, standaloneId);
    await mkdir(standaloneDir, { recursive: true });
    await writeFile(
      join(standaloneDir, 'ticket.md'),
      [
        '---',
        `id: ${standaloneId}`,
        'slug: standalone-demo',
        'title: Standalone',
        'project: null',
        'workspace:',
        `  repository: ${worktree}`,
        `  worktreePath: ${worktree}`,
        '---',
        '# Standalone',
      ].join('\n'),
      'utf-8',
    );

    await boot([{ steps: [{ kind: 'update', update: textChunk('standalone ok', 'm1') }] }]);

    await fetch(url(`/tickets/${standaloneId}/chat/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'standalone first' }),
    });
    await waitUntil(() => fake.prompts.length === 1, 'standalone prompt');
    await waitUntil(
      () =>
        broker
          .items({ id: standaloneId } as never, { limit: 50 })
          .some((i) => i.type === 'agent.message' && i.sealed),
      'standalone reply',
    );
    const standaloneReply = broker
      .items({ id: standaloneId } as never, { limit: 50 })
      .find((i) => i.type === 'agent.message' && i.sealed)!;

    const res = await fetch(
      url(`/tickets/${standaloneId}/chat/items/${encodeURIComponent(standaloneReply.itemId)}/file`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'decision', title: 'Standalone', body: 'yes' }),
      },
    );
    expect(res.status).toBe(201);
    const decisionMd = await readFile(join(standaloneDir, 'decision-record.md'), 'utf-8');
    expect(decisionMd).toContain('## Standalone');
  });
});
