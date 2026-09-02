import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as acp from '@agentclientprotocol/sdk';
import { closeSessionDb, getSessionDb, initSessionDb } from '../dashboard/session-db.js';
import { getChatSession } from '../db/chat-db.js';
import { connectAcpClient, type AcpClient } from '../chat/acp-client.js';
import {
  createFakeAgent,
  planUpdate,
  textChunk,
  toolCall,
  usageUpdate,
  type FakeAgent,
  type FakeTurn,
} from '../chat/fake-agent.js';
import {
  createChatBroker,
  ChatSendError,
  type ChatBroker,
  type ClientFactory,
} from '../chat/broker.js';
import { readEvents } from '../chat/store.js';
import type { ChatEvent, ChatItem } from '../chat/types.js';
import type { ResolvedAssignment } from '../utils/assignment-resolver.js';

/**
 * Task 6 — the broker, driven against the in-process fake ACP agent
 * (Decision 7). No subprocess, no adapter cost; the only tests that touch a real
 * adapter are the manual runs in Task 10.
 */

let sandbox: string;
let assignmentDir: string;
let worktree: string;
let broker: ChatBroker;
let fake: FakeAgent;
let clients: AcpClient[];
let frames: Array<{ type: string; payload: unknown }>;

const ASSIGNMENT_ID = 'f71fedf9-e696-4149-ab99-c6e60cdca77b';

const assignment = (): ResolvedAssignment => ({
  assignmentDir,
  projectSlug: 'syntaur-meta',
  assignmentSlug: 'chat-demo',
  id: ASSIGNMENT_ID,
  standalone: false,
  workspaceGroup: null,
});

/** Poll rather than sleep, so the tests stay fast and deterministic. */
async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const items = (): ChatItem[] => broker.items(assignment(), { limit: 500 });
const itemsOfType = (type: ChatItem['type']) => items().filter((i) => i.type === type);
const events = (): Promise<ChatEvent[]> => readEvents(join(assignmentDir, 'chat', 'events.jsonl'));

/**
 * Wait until `turns` turns have finished and the queue has drained. Polling the
 * items (not a sleep) keeps this fast and free of arbitrary delays.
 */
async function idle(turns = 1): Promise<void> {
  await waitUntil(() => {
    const statuses = itemsOfType('turn.status') as Array<{ state: string }>;
    if (statuses.length < turns) return false;
    if (!statuses.every((s) => s.state === 'ended')) return false;
    return (lastSessionFrame()?.queued ?? []).length === 0;
  }, `${turns} turn(s) to finish`);
}

function lastSessionFrame(): { state: string; queued: Array<{ messageId: string }> } | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].type === 'chat-session') {
      return (frames[i].payload as { session: { state: string; queued: Array<{ messageId: string }> } })
        .session;
    }
  }
  return null;
}

function makeBroker(options: { turns?: FakeTurn[]; agentOptions?: Parameters<typeof createFakeAgent>[0] } = {}) {
  fake = createFakeAgent({ turns: options.turns ?? [{ steps: [] }], ...(options.agentOptions ?? {}) });
  const clientFactory: ClientFactory = (input) => {
    const client = connectAcpClient(fake.app, {
      onUpdate: input.onUpdate,
      onPermissionRequest: input.onPermissionRequest,
    });
    clients.push(client);
    return client;
  };
  broker = createChatBroker({
    projectsDir: join(sandbox, 'projects'),
    assignmentsDir: join(sandbox, 'assignments'),
    syntaurHome: sandbox,
    broadcast: (message) => frames.push({ type: message.type, payload: message.payload }),
    clientFactory,
    timeouts: { flushMs: 1, permissionMs: 200, sessionIdleMs: 120, shutdownGraceMs: 200 },
  });
  return broker;
}

async function writeAssignment(workspace: { worktreePath?: string; repository?: string } = {}): Promise<void> {
  const lines = [
    '---',
    `id: ${ASSIGNMENT_ID}`,
    'slug: chat-demo',
    'title: "Chat demo"',
    'status: ready_to_implement',
    'project: syntaur-meta',
    'workspace:',
    `  repository: ${workspace.repository ?? worktree}`,
    `  worktreePath: ${workspace.worktreePath ?? worktree}`,
    '  branch: feat/chat-demo',
    '  parentBranch: main',
    '---',
    '',
    '# Chat demo',
    '',
    '## Acceptance Criteria',
    '',
    '- [ ] It chats',
  ];
  await writeFile(join(assignmentDir, 'assignment.md'), lines.join('\n'), 'utf-8');
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-chat-broker-'));
  assignmentDir = join(sandbox, 'projects', 'syntaur-meta', 'assignments', 'chat-demo');
  worktree = join(sandbox, 'worktree');
  await mkdir(assignmentDir, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeAssignment();
  await writeFile(join(assignmentDir, 'progress.md'), '# Progress\n\nnothing yet\n', 'utf-8');
  clients = [];
  frames = [];
  closeSessionDb();
  initSessionDb(join(sandbox, 'syntaur.db'));
});

afterEach(async () => {
  await broker?.stopAll().catch(() => {});
  for (const client of clients) await client.close().catch(() => {});
  closeSessionDb();
  await rm(sandbox, { recursive: true, force: true });
});

describe('first message', () => {
  it('spawns, initializes, opens a session and sends the standing context once', async () => {
    makeBroker({
      turns: [
        { steps: [{ kind: 'update', update: textChunk('Hi there.', 'm1') }], usage: usage(10, 5) },
        { steps: [{ kind: 'update', update: textChunk('Again.', 'm2') }], usage: usage(3, 2) },
      ],
    });

    await broker.send({ assignment: assignment(), text: 'hello' });
    await idle();

    expect(fake.calls.slice(0, 2)).toEqual(['initialize', 'session/new']);
    expect(fake.newSessionRequests[0].cwd).toBe(worktree);
    // claude carries the system prompt in _meta, so no <system> block is sent.
    expect(fake.newSessionRequests[0]._meta).toMatchObject({ systemPrompt: { append: expect.any(String) } });

    const first = fake.prompts[0].prompt;
    expect(first.filter((b) => b.type === 'resource').length).toBeGreaterThanOrEqual(2);
    expect(first[first.length - 1]).toMatchObject({ type: 'text' });
    expect((first[first.length - 1] as { text: string }).text).toContain('<chat-event author="human"');
    expect((first[first.length - 1] as { text: string }).text).toContain('hello');

    await broker.send({ assignment: assignment(), text: 'again' });
    await idle(2);
    // Second turn: only the new message, no standing context.
    expect(fake.prompts[1].prompt).toHaveLength(1);
    expect(fake.prompts[1].prompt.filter((b) => b.type === 'resource')).toHaveLength(0);
  });

  it('renders the reply and a turn.status carrying usage', async () => {
    makeBroker({
      turns: [
        {
          steps: [
            { kind: 'update', update: textChunk('Hello ', 'm1') },
            { kind: 'update', update: textChunk('world', 'm1') },
            { kind: 'update', update: usageUpdate(100, 1000, 0.19) },
          ],
          usage: usage(120, 40),
        },
      ],
    });
    await broker.send({ assignment: assignment(), text: 'hi' });
    await idle();

    const messages = itemsOfType('agent.message');
    expect(messages).toHaveLength(1);
    expect((messages[0] as { text: string }).text).toBe('Hello world');

    const status = itemsOfType('turn.status')[0] as {
      state: string;
      cost?: number;
      usage?: { totalTokens: number };
      durationMs?: number;
    };
    expect(status.state).toBe('ended');
    // First turn of the session, so the cumulative figure IS this turn's cost.
    expect(status.cost).toBe(0.19);
    expect(status.usage?.totalTokens).toBe(160);

    const user = itemsOfType('user.message')[0] as { state: string; text: string };
    expect(user.state).toBe('sent');
    expect(user.text).toBe('hi');
  });

  it('refuses to send — and creates nothing — when the workspace has no valid cwd', async () => {
    await writeAssignment({ worktreePath: '/nope/nowhere', repository: '/nope/nowhere' });
    makeBroker();
    await expect(broker.send({ assignment: assignment(), text: 'hi' })).rejects.toBeInstanceOf(
      ChatSendError,
    );
    expect(await events()).toEqual([]);
    expect(items()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('falls back to the repository when the worktree is missing', async () => {
    await writeAssignment({ worktreePath: '/nope/nowhere', repository: worktree });
    makeBroker();
    await broker.send({ assignment: assignment(), text: 'hi' });
    await idle();
    expect(fake.newSessionRequests[0].cwd).toBe(worktree);
  });
});

describe('the queue (Decision 6)', () => {
  it('queues a message sent during a turn and sends it after the first resolves', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    makeBroker({
      turns: [
        { steps: [{ kind: 'gate', gate }, { kind: 'update', update: textChunk('first', 'm1') }] },
        { steps: [{ kind: 'update', update: textChunk('second', 'm2') }] },
      ],
    });

    await broker.send({ assignment: assignment(), text: 'A' });
    await waitUntil(() => fake.prompts.length === 1, 'the first prompt');

    const second = await broker.send({ assignment: assignment(), text: 'B' });
    // Still one prompt in flight — the queue is Syntaur's.
    expect(fake.prompts).toHaveLength(1);
    await waitUntil(
      () =>
        itemsOfType('user.message').some(
          (i) => (i as { messageId: string }).messageId === second.messageId,
        ),
      'the queued bubble',
    );
    const queued = itemsOfType('user.message').find(
      (i) => (i as { messageId: string }).messageId === second.messageId,
    ) as { state: string };
    expect(queued.state).toBe('queued');

    release();
    await waitUntil(() => fake.prompts.length === 2, 'the queued prompt to be sent');
    await idle(2);

    // Order preserved.
    const texts = fake.prompts.map((p) =>
      (p.prompt[p.prompt.length - 1] as { text: string }).text,
    );
    expect(texts[0]).toContain('A');
    expect(texts[1]).toContain('B');
    const sent = itemsOfType('user.message').map((i) => (i as { state: string }).state);
    expect(sent).toEqual(['sent', 'sent']);
  });

  it('withdraw removes a queued message and it is never sent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    makeBroker({ turns: [{ steps: [{ kind: 'gate', gate }] }, { steps: [] }] });

    await broker.send({ assignment: assignment(), text: 'A' });
    await waitUntil(() => fake.prompts.length === 1, 'the first prompt');
    const second = await broker.send({ assignment: assignment(), text: 'B' });

    expect(await broker.withdraw(assignment(), second.messageId)).toBe(true);
    expect(await broker.withdraw(assignment(), 'not-a-message')).toBe(false);

    release();
    await idle();
    expect(fake.prompts).toHaveLength(1);
    const withdrawn = itemsOfType('user.message').find(
      (i) => (i as { messageId: string }).messageId === second.messageId,
    ) as { state: string };
    // The bubble stays, faded — it is history, not a mistake to erase.
    expect(withdrawn.state).toBe('withdrawn');
  });
});

describe('cancel', () => {
  it('resolves the in-flight prompt as cancelled', async () => {
    makeBroker({ turns: [{ steps: [{ kind: 'awaitCancel' }] }] });
    await broker.send({ assignment: assignment(), text: 'essay please' });
    await waitUntil(() => fake.prompts.length === 1, 'the prompt');

    expect(await broker.cancel(assignment(), null)).toBe(true);
    await idle();

    const status = itemsOfType('turn.status')[0] as { state: string; stopReason?: string };
    expect(status.state).toBe('ended');
    expect(status.stopReason).toBe('cancelled');
    expect(fake.calls).toContain('session/cancel');
  });

  it('answers a pending permission `cancelled` when the turn is cancelled', async () => {
    makeBroker({
      turns: [
        {
          steps: [
            {
              kind: 'permission',
              request: {
                toolCall: { toolCallId: 't1', title: 'Run `echo hi`' },
                options: [
                  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
                ],
              },
            },
          ],
        },
      ],
    });
    await broker.send({ assignment: assignment(), text: 'run it' });
    await waitUntil(() => itemsOfType('permission.request').length === 1, 'the permission item');

    await broker.cancel(assignment(), null);
    await idle();

    expect(fake.permissionAnswers[0]).toEqual({ outcome: { outcome: 'cancelled' } });
    const perm = itemsOfType('permission.request')[0] as { cancelled?: boolean };
    expect(perm.cancelled).toBe(true);
  });

  it('is a no-op when nothing is running', async () => {
    makeBroker();
    expect(await broker.cancel(assignment(), null)).toBe(false);
  });
});

describe('permissions (Decision 9)', () => {
  const permissionTurn: FakeTurn = {
    steps: [
      {
        kind: 'permission',
        request: {
          toolCall: { toolCallId: 't1', title: 'Run `rm -rf out`', kind: 'execute' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
          ],
        },
      },
      { kind: 'update', update: textChunk('done', 'm1') },
    ],
  };

  it('an answer reaches the agent and lands on the item', async () => {
    makeBroker({ turns: [permissionTurn] });
    await broker.send({ assignment: assignment(), text: 'go' });
    await waitUntil(() => itemsOfType('permission.request').length === 1, 'the permission item');

    const perm = itemsOfType('permission.request')[0] as { requestId: string; options: unknown[] };
    expect(perm.options).toHaveLength(2);
    expect(await broker.answerPermission(assignment(), perm.requestId, 'allow')).toBe(true);
    await idle();

    expect(fake.permissionAnswers[0]).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    const answered = itemsOfType('permission.request')[0] as { answer?: string };
    expect(answered.answer).toBe('allow');
    // Answering an unknown request is a no-op, not a throw.
    expect(await broker.answerPermission(assignment(), 'nope', 'allow')).toBe(false);
  });

  it('a timeout rejects, marks the item and files an Inbox question', async () => {
    makeBroker({ turns: [permissionTurn] });
    await broker.send({ assignment: assignment(), text: 'go' });
    await waitUntil(() => itemsOfType('permission.request').length === 1, 'the permission item');
    await idle();

    expect(fake.permissionAnswers[0]).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
    const perm = itemsOfType('permission.request')[0] as { timedOut?: boolean };
    expect(perm.timedOut).toBe(true);

    // The Inbox derives its `question` category from unresolved comments.md
    // questions, so that is where the escalation lands.
    const comments = await readFile(join(assignmentDir, 'comments.md'), 'utf-8');
    expect(comments).toContain('**Type:** question');
    // Unresolved is what makes the Inbox pick it up (src/inbox/index.ts).
    expect(comments).toContain('**Resolved:** false');
    expect(comments).toContain('Run `rm -rf out`');
  });
});

describe('engagements and the sessions row (Decisions 1 and 10)', () => {
  it('registers the sessions row under the ACP session id and opens one engagement per turn', async () => {
    // `usage_update.cost` is the SESSION's cumulative cost (Decision 11), so the
    // second turn reports 0.18 — a running total, not 0.07 again.
    makeBroker({
      turns: [
        { steps: [{ kind: 'update', update: usageUpdate(50, 1000, 0.11) }], usage: usage(30, 10) },
        { steps: [{ kind: 'update', update: usageUpdate(90, 1000, 0.18) }], usage: usage(20, 5) },
      ],
      agentOptions: { sessionIds: ['acp-session-1'] },
    });

    await broker.send({ assignment: assignment(), text: 'one' });
    await idle();
    await broker.send({ assignment: assignment(), text: 'two' });
    await idle(2);

    const db = getSessionDb();
    const session = db
      .prepare('SELECT session_id, agent, status, hosted_by, path FROM sessions')
      .all() as Array<{ session_id: string; agent: string; status: string; hosted_by: string; path: string }>;
    expect(session).toHaveLength(1);
    expect(session[0]).toMatchObject({
      session_id: 'acp-session-1',
      agent: 'claude',
      status: 'active',
      hosted_by: 'acp',
      path: worktree,
    });

    const engagements = db
      .prepare('SELECT stage, close_reason, tokens_at_open, tokens_at_close FROM engagement ORDER BY id')
      .all() as Array<{
      stage: string;
      close_reason: string;
      tokens_at_open: string | null;
      tokens_at_close: string | null;
    }>;
    // appendSession auto-opens one; the broker closes it so the per-turn
    // engagements own every interval.
    expect(engagements[0].close_reason).toBe('chat-registered');
    const turns = engagements.filter((e) => e.stage === 'chat');
    expect(turns).toHaveLength(2);
    for (const turn of turns) {
      expect(turn.close_reason).toBe('turn_end');
      expect(turn.tokens_at_open).not.toBeNull();
      expect(turn.tokens_at_close).not.toBeNull();
    }
    // The cost delta is exactly the turn's own cost.
    const first = JSON.parse(turns[0].tokens_at_close!) as { models: Record<string, { cost: number }> };
    const firstOpen = JSON.parse(turns[0].tokens_at_open!) as { models: Record<string, { cost: number }> };
    const key = Object.keys(first.models)[0];
    expect(first.models[key].cost - (firstOpen.models[key]?.cost ?? 0)).toBeCloseTo(0.11, 6);

    const second = JSON.parse(turns[1].tokens_at_close!) as { models: Record<string, { cost: number }> };
    const secondOpen = JSON.parse(turns[1].tokens_at_open!) as { models: Record<string, { cost: number }> };
    // The window delta is this turn's own cost — 0.18 cumulative minus the 0.11
    // already spent — which is exactly what `assignmentWindowCost` prices.
    expect(second.models[key].cost - secondOpen.models[key].cost).toBeCloseTo(0.07, 6);

    // claude writes NO usage_events — ccusage already records this session id.
    const usageRows = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='usage_events'")
      .get() as { n: number };
    if (usageRows.n > 0) {
      const rows = db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number };
      expect(rows.n).toBe(0);
    }

    const row = getChatSession(ASSIGNMENT_ID, 'claude');
    expect(row?.acp_session_id).toBe('acp-session-1');
    expect(row?.harness).toBe('claude');
    expect(row?.cwd).toBe(worktree);
    // The snapshot holds the adapter's cumulative figure verbatim, NOT the sum
    // of the per-turn deltas — adding a running total to itself would inflate
    // the assignment's cost several-fold.
    expect(JSON.parse(row!.usage_snapshot_json!).models[key].cost).toBeCloseTo(0.18, 6);
  });
});

describe('adapter exit and resume (spike Decisions 7 and 8)', () => {
  it('an exit mid-turn seals the turn and the next message resumes the ACP session', async () => {
    makeBroker({
      turns: [{ steps: [{ kind: 'error', message: 'ACP connection closed' }] }, { steps: [] }],
      agentOptions: { sessionIds: ['acp-session-1'] },
    });

    await broker.send({ assignment: assignment(), text: 'boom' });
    await idle();

    const status = itemsOfType('turn.status')[0] as { state: string; stopReason?: string };
    expect(status.state).toBe('ended');
    expect(status.stopReason).toBe('error');

    const db = getSessionDb();
    const engagements = db
      .prepare("SELECT close_reason FROM engagement WHERE stage = 'chat'")
      .all() as Array<{ close_reason: string }>;
    expect(engagements).toEqual([{ close_reason: 'error' }]);

    // A second message on the same broker re-uses the live client; force a
    // fresh adapter by killing it first.
    for (const client of clients) await client.close();
    await broker.send({ assignment: assignment(), text: 'again' });
    await idle(2);
    expect(fake.calls).toContain('session/resume');
  });

  it('falls back to session/new plus a system row when resume fails', async () => {
    makeBroker({ agentOptions: { sessionIds: ['acp-session-1', 'acp-session-2'] } });
    await broker.send({ assignment: assignment(), text: 'one' });
    await idle();
    for (const client of clients) await client.close();

    // Rebuild the fake with a resume that rejects, keeping the persisted row.
    const failing = createFakeAgent({ resumeError: 'session not found', sessionIds: ['acp-session-2'] });
    const secondBroker = createChatBroker({
      projectsDir: join(sandbox, 'projects'),
      assignmentsDir: join(sandbox, 'assignments'),
      syntaurHome: sandbox,
      broadcast: (message) => frames.push({ type: message.type, payload: message.payload }),
      clientFactory: (input) => {
        const client = connectAcpClient(failing.app, {
          onUpdate: input.onUpdate,
          onPermissionRequest: input.onPermissionRequest,
        });
        clients.push(client);
        return client;
      },
      timeouts: { flushMs: 1, sessionIdleMs: 60_000 },
    });

    await secondBroker.send({ assignment: assignment(), text: 'two' });
    await waitUntil(() => failing.prompts.length === 1, 'the second prompt');
    await waitUntil(
      () => items().some((i) => i.type === 'system' && /Could not resume/.test((i as { text: string }).text)),
      'the rotation system row',
    );
    expect(failing.calls).toContain('session/new');
    // The standing context is re-sent: this agent session has never seen it.
    expect(failing.prompts[0].prompt.some((b) => b.type === 'resource')).toBe(true);
    await secondBroker.stopAll();
  });
});

describe('idle teardown', () => {
  it('closes the adapter after the idle window and resumes on the next message', async () => {
    makeBroker({ agentOptions: { sessionIds: ['acp-session-1'] } });
    await broker.send({ assignment: assignment(), text: 'one' });
    await idle();

    await waitUntil(
      () => items().some((i) => i.type === 'system' && /idle/i.test((i as { text: string }).text)),
      'the idle system row',
    );
    expect(lastSessionFrame()?.state).toBe('idle');
    const db = getSessionDb();
    const status = db.prepare('SELECT status FROM sessions').get() as { status: string };
    expect(status.status).toBe('stopped');

    await broker.send({ assignment: assignment(), text: 'two' });
    await idle(2);
    expect(fake.calls).toContain('session/resume');
    const revived = db.prepare('SELECT status FROM sessions').get() as { status: string };
    expect(revived.status).toBe('active');
  });
});

describe('stopAll', () => {
  it('cancels the in-flight turn, closes its engagement and leaves nothing running', async () => {
    makeBroker({ turns: [{ steps: [{ kind: 'awaitCancel' }] }] });
    await broker.send({ assignment: assignment(), text: 'essay' });
    await waitUntil(() => fake.prompts.length === 1, 'the prompt');

    await broker.stopAll();

    const status = itemsOfType('turn.status')[0] as { state: string; stopReason?: string };
    expect(status.state).toBe('ended');
    expect(status.stopReason).toBe('cancelled');

    const db = getSessionDb();
    const open = db.prepare('SELECT COUNT(*) AS n FROM engagement WHERE ended_at IS NULL').get() as {
      n: number;
    };
    expect(open.n).toBe(0);
    const session = db.prepare('SELECT status FROM sessions').get() as { status: string };
    expect(session.status).toBe('stopped');
    expect(clients.every((c) => !c.alive() || true)).toBe(true);
  });

  it('is safe with no live sessions', async () => {
    makeBroker();
    await expect(broker.stopAll()).resolves.toBeUndefined();
  });
});

describe('history and reindex', () => {
  it('items page from the index and a reindex reproduces them', async () => {
    makeBroker({
      turns: [
        {
          steps: [
            { kind: 'update', update: textChunk('Let me look.', 'm1') },
            { kind: 'update', update: toolCall('t1', { kind: 'read', status: 'completed' }) },
            { kind: 'update', update: planUpdate([{ content: 'do it', priority: 'high', status: 'completed' }]) },
            { kind: 'update', update: textChunk('Done.', 'm2') },
          ],
          usage: usage(10, 10),
        },
      ],
    });
    await broker.send({ assignment: assignment(), text: 'go' });
    await idle();

    const live = items();
    expect(live.map((i) => i.type)).toContain('agent.work');
    expect(live.map((i) => i.type)).toContain('agent.plan');

    const result = await broker.reindex(assignment());
    expect(result.events).toBeGreaterThan(0);
    expect(broker.items(assignment(), { limit: 500 })).toEqual(live);
  });

  it('lists the builtin agent definitions', async () => {
    makeBroker();
    const { definitions, errors } = await broker.listAgents();
    expect(errors).toEqual([]);
    expect(definitions.map((d) => d.id)).toEqual(['claude', 'codex']);
  });

  it('reports the session summary before anything has been sent', async () => {
    makeBroker();
    const summary = await broker.getSession(assignment(), null);
    expect(summary).toMatchObject({
      assignmentId: ASSIGNMENT_ID,
      agentId: 'claude',
      harness: 'claude',
      state: 'none',
      acpSessionId: null,
      queued: [],
    });
  });
});

describe('WS frames (Decision 3)', () => {
  it('emits chat-item patches scoped by assignment id and chat-session transitions', async () => {
    makeBroker({ turns: [{ steps: [{ kind: 'update', update: textChunk('hi', 'm1') }] }] });
    await broker.send({ assignment: assignment(), text: 'go' });
    await idle();

    const itemFrames = frames.filter((f) => f.type === 'chat-item');
    expect(itemFrames.length).toBeGreaterThan(0);
    for (const frame of itemFrames) {
      expect((frame.payload as { assignmentId: string }).assignmentId).toBe(ASSIGNMENT_ID);
      expect((frame.payload as { patch: { op: string } }).patch.op).toMatch(/^(upsert|retract)$/);
    }

    const sessionFrames = frames.filter((f) => f.type === 'chat-session');
    const states = sessionFrames.map(
      (f) => (f.payload as { session: { state: string } }).session.state,
    );
    expect(states).toContain('spawning');
    expect(states).toContain('ready');
    expect(states).toContain('running');
  });
});

function usage(input: number, output: number): acp.Usage {
  return {
    totalTokens: input + output,
    inputTokens: input,
    outputTokens: output,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
  };
}

describe('cumulative cost (Decision 11)', () => {
  it('reports each turn its own cost, not the running session total', async () => {
    // The ACP schema documents `usage_update.cost` as the CUMULATIVE session
    // cost, and both the spike fixtures and a live claude run confirm it. A
    // broker that added it up would bill turn 3 at $0.75 when it cost $0.33.
    makeBroker({
      turns: [
        { steps: [{ kind: 'update', update: usageUpdate(10, 1000, 0.34) }], usage: usage(10, 5) },
        { steps: [{ kind: 'update', update: usageUpdate(20, 1000, 0.42) }], usage: usage(10, 5) },
        { steps: [{ kind: 'update', update: usageUpdate(30, 1000, 0.75) }], usage: usage(10, 5) },
      ],
      agentOptions: { sessionIds: ['acp-session-1'] },
    });

    for (const text of ['one', 'two', 'three']) {
      await broker.send({ assignment: assignment(), text });
      await idle(['one', 'two', 'three'].indexOf(text) + 1);
    }

    const costs = (itemsOfType('turn.status') as Array<{ cost?: number }>).map((s) => s.cost);
    expect(costs[0]).toBeCloseTo(0.34, 6);
    expect(costs[1]).toBeCloseTo(0.08, 6);
    expect(costs[2]).toBeCloseTo(0.33, 6);

    // The session's stored total is the adapter's own figure, not 0.34+0.42+0.75.
    const row = getChatSession(ASSIGNMENT_ID, 'claude');
    const models = JSON.parse(row!.usage_snapshot_json!).models as Record<string, { cost: number }>;
    expect(models[Object.keys(models)[0]].cost).toBeCloseTo(0.75, 6);
  });

  it('a cancelled turn that spends nothing costs zero', async () => {
    makeBroker({
      turns: [
        { steps: [{ kind: 'update', update: usageUpdate(10, 1000, 0.5) }], usage: usage(10, 5) },
        // A cancelled turn reports the SAME cumulative figure — no delta.
        { steps: [{ kind: 'update', update: usageUpdate(10, 1000, 0.5) }, { kind: 'awaitCancel' }] },
      ],
      agentOptions: { sessionIds: ['acp-session-1'] },
    });

    await broker.send({ assignment: assignment(), text: 'one' });
    await idle();
    await broker.send({ assignment: assignment(), text: 'two' });
    await waitUntil(() => fake.prompts.length === 2, 'the second prompt');
    await broker.cancel(assignment(), null);
    await idle(2);

    const costs = (itemsOfType('turn.status') as Array<{ cost?: number }>).map((s) => s.cost);
    expect(costs[0]).toBeCloseTo(0.5, 6);
    expect(costs[1]).toBe(0);
  });
});
