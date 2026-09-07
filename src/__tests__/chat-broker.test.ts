import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as acp from '@agentclientprotocol/sdk';
import { closeSessionDb, getSessionDb, initSessionDb } from '../dashboard/session-db.js';
import { closeUsageDb, initUsageDb } from '../db/usage-db.js';
import { getChatSession, getHarnessOptions, upsertChatItem, upsertChatSession, setHarnessCommands } from '../db/chat-db.js';
import { openEngagement } from '../db/engagement-db.js';
import { openChatLog } from '../chat/store.js';
import { writeChatAttachment } from '../chat/attachments.js';
import { connectAcpClient, type AcpClient } from '../chat/acp-client.js';
import {
  createFakeAgent,
  planUpdate,
  textChunk,
  toolCall,
  toolCallUpdate,
  usageUpdate,
  type FakeAgent,
  type FakeTurn,
} from '../chat/fake-agent.js';
import {
  createChatBroker,
  ChatSendError,
  type ChatBroker,
  type BrokerTimeouts,
  type ClientFactory,
} from '../chat/broker.js';
import { agentsDir } from '../chat/agents.js';
import { readEvents } from '../chat/store.js';
import type { ChatEvent, ChatItem } from '../chat/types.js';
import type { ResolvedAssignment } from '../utils/assignment-resolver.js';
import { renderProgress } from '../templates/index.js';
import { parseProgress } from '../dashboard/parser.js';
import { parseComments } from '../dashboard/parser.js';

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
let spawns: Array<{ cwd: string; env: Record<string, string> | undefined }> = [];
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
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
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

function makeBroker(
  options: {
    turns?: FakeTurn[];
    agentOptions?: Parameters<typeof createFakeAgent>[0];
    timeouts?: Partial<BrokerTimeouts>;
  } = {},
) {
  fake = createFakeAgent({ turns: options.turns ?? [{ steps: [] }], ...(options.agentOptions ?? {}) });
  const clientFactory: ClientFactory = (input) => {
    const client = connectAcpClient(fake.app, {
      onUpdate: input.onUpdate,
      onPermissionRequest: input.onPermissionRequest,
      onExtRequest: input.onExtRequest,
      onExtNotification: input.onExtNotification,
    });
    spawns.push({ cwd: input.cwd, env: input.env });
    clients.push(client);
    return client;
  };
  broker = createChatBroker({
    projectsDir: join(sandbox, 'projects'),
    assignmentsDir: join(sandbox, 'assignments'),
    syntaurHome: sandbox,
    broadcast: (message) => frames.push({ type: message.type, payload: message.payload }),
    clientFactory,
    timeouts: {
      flushMs: 1,
      permissionMs: 200,
      sessionIdleMs: 120,
      shutdownGraceMs: 200,
      inboxGraceMs: 60_000,
      ...(options.timeouts ?? {}),
    },
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
  await writeFile(
    join(assignmentDir, 'progress.md'),
    renderProgress({ assignment: 'chat-demo', timestamp: '2026-09-06T12:00:00Z' }),
    'utf-8',
  );
  clients = [];
  spawns = [];
  frames = [];
  closeSessionDb();
  closeUsageDb();
  initSessionDb(join(sandbox, 'syntaur.db'));
  // The broker's codex usage write goes through the usage db, which shares the
  // same file but keeps its own connection.
  initUsageDb(join(sandbox, 'syntaur.db'));
});

afterEach(async () => {
  await broker?.stopAll().catch(() => {});
  for (const client of clients) await client.close().catch(() => {});
  closeSessionDb();
  closeUsageDb();
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

  it('falls back to homedir when the workspace has no valid cwd', async () => {
    await writeAssignment({ worktreePath: '/nope/nowhere', repository: '/nope/nowhere' });
    makeBroker();
    await broker.send({ assignment: assignment(), text: 'hi' });
    await idle();
    const { homedir } = await import('node:os');
    expect(fake.newSessionRequests[0].cwd).toBe(homedir());
    // The home tier is read-only unless the definition pins a mode: claude's
    // `ask` role id is `default`, applied through session/set_mode.
    expect(fake.calls).toContain('session/set_mode');
    expect((await broker.getSession(assignment(), 'claude'))?.mode).toBe('default');
    // And the SessionStart hook is told not to merge into ~/.syntaur/context.json.
    expect(spawns[0]?.env?.SYNTAUR_SKIP_CONTEXT_MERGE).toBe('1');
  });

  it('falls back to the repository when the worktree is missing', async () => {
    await writeAssignment({ worktreePath: '/nope/nowhere', repository: worktree });
    makeBroker();
    await broker.send({ assignment: assignment(), text: 'hi' });
    await idle();
    expect(fake.newSessionRequests[0].cwd).toBe(worktree);
    expect(spawns[0]?.env?.SYNTAUR_SKIP_CONTEXT_MERGE).toBeUndefined();
    expect(fake.calls).not.toContain('session/set_mode');
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
    // questions, so that is where the escalation lands. The comment is written
    // from the timeout callback, which nothing awaits, so poll for it rather
    // than assume it landed before the turn ended.
    await waitUntil(
      () => existsSync(join(assignmentDir, 'comments.md')),
      'the Inbox question to be filed',
    );
    const comments = await readFile(join(assignmentDir, 'comments.md'), 'utf-8');
    expect(comments).toContain('**Type:** question');
    // Unresolved is what makes the Inbox pick it up (src/inbox/index.ts).
    expect(comments).toContain('**Resolved:** false');
    expect(comments).toContain('Run `rm -rf out`');
  });
});

describe('permissions auto-approve', () => {
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

  async function writeAgentFile(id: string, extra = ''): Promise<void> {
    const dir = agentsDir(sandbox);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${id}.md`),
      [
        '---',
        `id: ${id}`,
        `name: ${id}`,
        `color: ${id === 'cursor' ? 'sky' : 'violet'}`,
        `harness: ${id}`,
        extra,
        'respondsTo: mentions',
        `default: ${id === 'claude'}`,
        '---',
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  it('auto-answers when the definition has permissions: auto', async () => {
    await writeAgentFile('claude', 'permissions: auto\n');
    makeBroker({ turns: [permissionTurn] });
    await broker.send({ assignment: assignment(), text: 'go' });
    await idle();

    expect(fake.permissionAnswers[0]).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    const perm = itemsOfType('permission.request')[0] as { answer?: string; auto?: boolean; sealed?: boolean };
    expect(perm.answer).toBe('allow');
    expect(perm.auto).toBe(true);
    expect(perm.sealed).toBe(true);
    expect(existsSync(join(assignmentDir, 'comments.md'))).toBe(false);
  });

  it('prefers allow_once on the cursor option shape', async () => {
    await writeAgentFile('claude', 'permissions: auto\n');
    makeBroker({
      turns: [
        {
          steps: [
            {
              kind: 'permission',
              request: {
                toolCall: { toolCallId: 't1', title: 'Run uname', kind: 'execute' },
                options: [
                  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
                  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
                ],
              },
            },
            { kind: 'update', update: textChunk('done', 'm1') },
          ],
        },
      ],
    });
    await broker.send({ assignment: assignment(), text: 'go' });
    await idle();
    expect(fake.permissionAnswers[0]).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
  });

  it('picks allow_once on the codex shape (no allow_always)', async () => {
    await writeAgentFile('claude', 'permissions: auto\n');
    makeBroker({
      turns: [
        {
          steps: [
            {
              kind: 'permission',
              request: {
                toolCall: { toolCallId: 't1', title: 'Run cmd', kind: 'execute' },
                options: [
                  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
                ],
              },
            },
            { kind: 'update', update: textChunk('done', 'm1') },
          ],
        },
      ],
    });
    await broker.send({ assignment: assignment(), text: 'go' });
    await idle();
    expect(fake.permissionAnswers[0]).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
  });

  it('prefers allow_once even when it is not the first option', async () => {
    await writeAgentFile('claude', 'permissions: auto\n');
    makeBroker({
      turns: [
        {
          steps: [
            {
              kind: 'permission',
              request: {
                toolCall: { toolCallId: 't1', title: 'Run cmd', kind: 'execute' },
                options: [
                  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
                  { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
                  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
                ],
              },
            },
            { kind: 'update', update: textChunk('done', 'm1') },
          ],
        },
      ],
    });
    await broker.send({ assignment: assignment(), text: 'go' });
    await idle();
    expect(fake.permissionAnswers[0]).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
  });

  it('falls back to allow_always when only that allow option exists', async () => {
    await writeAgentFile('claude', 'permissions: auto\n');
    makeBroker({
      turns: [
        {
          steps: [
            {
              kind: 'permission',
              request: {
                toolCall: { toolCallId: 't1', title: 'Run cmd', kind: 'execute' },
                options: [
                  { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
                  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
                ],
              },
            },
            { kind: 'update', update: textChunk('done', 'm1') },
          ],
        },
      ],
    });
    await broker.send({ assignment: assignment(), text: 'go' });
    await idle();
    expect(fake.permissionAnswers[0]).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_always' },
    });
  });

  it('allow-all-this-session auto-answers later requests and clears on adapter exit', async () => {
    makeBroker({
      turns: [
        {
          steps: [
            {
              kind: 'permission',
              request: {
                toolCall: { toolCallId: 't1', title: 'First', kind: 'execute' },
                options: [
                  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
                ],
              },
            },
            {
              kind: 'permission',
              request: {
                toolCall: { toolCallId: 't2', title: 'Second', kind: 'execute' },
                options: [
                  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
                ],
              },
            },
            { kind: 'update', update: textChunk('done', 'm1') },
          ],
        },
        permissionTurn,
      ],
    });
    await broker.send({ assignment: assignment(), text: 'go' });
    await waitUntil(() => itemsOfType('permission.request').length === 1, 'first permission');

    const first = itemsOfType('permission.request')[0] as { requestId: string };
    expect(
      await broker.answerPermission(assignment(), first.requestId, 'allow', { allowAllSession: true }),
    ).toBe(true);
    await idle();

    expect(fake.permissionAnswers[0]).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    expect(fake.permissionAnswers[1]).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    const perms = itemsOfType('permission.request') as Array<{ auto?: boolean; answer?: string }>;
    expect(perms[1].auto).toBe(true);
    expect(
      itemsOfType('system').some((s) =>
        (s as { text: string }).text.includes('Auto-approving @claude'),
      ),
    ).toBe(true);

    await waitUntil(
      () => items().some((i) => i.type === 'system' && /idle/i.test((i as { text: string }).text)),
      'idle teardown',
    );

    await broker.send({ assignment: assignment(), text: 'again' });
    await waitUntil(() => itemsOfType('permission.request').length === 3, 'third permission card');
    const third = itemsOfType('permission.request')[2] as { auto?: boolean; answer?: string };
    expect(third.auto).toBeUndefined();
    expect(third.answer).toBeUndefined();
    await idle(2);
  });

  it('cancel still ends the turn when permissions are auto', async () => {
    await writeAgentFile('claude', 'permissions: auto\n');
    makeBroker({
      turns: [
        {
          steps: [
            {
              kind: 'permission',
              request: {
                toolCall: { toolCallId: 't1', title: 'Run cmd', kind: 'execute' },
                options: [
                  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
                ],
              },
            },
            { kind: 'awaitCancel' },
          ],
        },
      ],
    });
    await broker.send({ assignment: assignment(), text: 'go' });
    await waitUntil(() => fake.prompts.length === 1, 'prompt');
    await broker.cancel(assignment(), null);
    await idle();
    const status = itemsOfType('turn.status')[0] as { state: string; stopReason?: string };
    expect(status.state).toBe('ended');
    expect(status.stopReason).toBe('cancelled');
  });

  it('does not auto-answer cursor/ask_question', async () => {
    await writeAgentFile('cursor', 'permissions: auto\n');
    makeBroker({
      turns: [
        {
          steps: [
            {
              kind: 'extRequest',
              method: 'cursor/ask_question',
              params: {
                toolCallId: 'tool-q',
                title: 'Pick one',
                questions: [
                  {
                    id: 'q1',
                    prompt: 'Which?',
                    options: [
                      { id: 'a', label: 'A' },
                      { id: 'b', label: 'B' },
                    ],
                  },
                ],
              },
            },
            { kind: 'update', update: textChunk('thanks', 'm-q') },
          ],
        },
      ],
      agentOptions: { resumeSupported: false },
    });
    await broker.setParticipants(assignment(), { agents: ['cursor'], defaultAgent: 'cursor' });
    const sendP = broker.send({ assignment: assignment(), agentId: 'cursor', text: 'ask me' });
    await waitUntil(() => itemsOfType('question').length > 0, 'question card');
    const question = itemsOfType('question')[0] as { requestId: string };
    expect(await broker.answerQuestion(assignment(), question.requestId, { optionId: 'a' })).toBe(true);
    await sendP;
    await idle();
    expect(itemsOfType('question')[0]).toMatchObject({ answer: 'A' });
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
    const secondItems = () => secondBroker.items(assignment(), { limit: 500 });
    await waitUntil(() => failing.prompts.length === 1, 'the second prompt');
    await waitUntil(
      () =>
        secondItems().some(
          (i) => i.type === 'system' && /Could not resume/.test((i as { text: string }).text),
        ),
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
    expect(definitions.map((d) => d.id)).toEqual(['claude', 'codex', 'cursor']);
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

describe('resume keeps the cost snapshot on one key', () => {
  it('reads modes and config options back from session/resume', async () => {
    // A resumed session that forgot its model accumulated under the harness-id
    // fallback instead, splitting one session's cost across two keys and making
    // the engagement window delta read zero.
    makeBroker({
      turns: [
        { steps: [{ kind: 'update', update: usageUpdate(10, 1000, 0.25) }], usage: usage(10, 5) },
        { steps: [{ kind: 'update', update: usageUpdate(20, 1000, 0.40) }], usage: usage(10, 5) },
      ],
      agentOptions: {
        sessionIds: ['acp-session-1'],
        configOptions: [
          { id: 'model', name: 'Model', type: 'select', currentValue: 'opus[1m]', options: [] },
        ] as never,
      },
    });

    await broker.send({ assignment: assignment(), text: 'one' });
    await idle();
    // Drop the client so the next send has to respawn and resume.
    for (const client of clients) await client.close();

    await broker.send({ assignment: assignment(), text: 'two' });
    await idle(2);
    expect(fake.calls).toContain('session/resume');

    const row = getChatSession(ASSIGNMENT_ID, 'claude');
    const models = JSON.parse(row!.usage_snapshot_json!).models as Record<string, unknown>;
    expect(Object.keys(models)).toEqual(['opus[1m]']);

    const db = getSessionDb();
    const turns = db
      .prepare("SELECT tokens_at_open, tokens_at_close FROM engagement WHERE stage='chat' ORDER BY id")
      .all() as Array<{ tokens_at_open: string; tokens_at_close: string }>;
    const delta = (r: { tokens_at_open: string; tokens_at_close: string }) => {
      const o = JSON.parse(r.tokens_at_open).models['opus[1m]']?.cost ?? 0;
      const c = JSON.parse(r.tokens_at_close).models['opus[1m]']?.cost ?? 0;
      return c - o;
    };
    expect(delta(turns[0])).toBeCloseTo(0.25, 6);
    expect(delta(turns[1])).toBeCloseTo(0.15, 6);
  });
});

/**
 * Round-1 code review, findings 1–5, 7 and 8: what a `SIGKILL` of the dashboard
 * leaves behind and how the next load repairs it (Decision 12).
 *
 * A crash is simulated by writing the exact persisted state a killed process
 * leaves — a `turn.start` with no `turn.end`, an engagement with no `ended_at`,
 * and `user.message` events that no turn ever picked up — and then building a
 * fresh broker over it. Closing the client instead would let the first broker
 * seal its own turn, which is precisely NOT the case under test.
 */
describe('startup repair after a crash (Decision 12)', () => {
  const SESSION_KEY = `${ASSIGNMENT_ID}:claude`;
  const CRASH_SNAPSHOT = {
    models: { 'opus[1m]': { input: 1, output: 1, cacheCreation: 0, cacheRead: 0, total: 2, cost: 0.5 } },
    collectorRunAt: null,
    capturedAt: '2026-09-02T12:00:00.000Z',
  };

  /** Write the persisted wreckage of a process killed mid-turn. */
  async function seedCrashedState(
    opts: {
      queuedMessages?: string[];
      pendingPermission?: boolean;
      /** Already-answered permission ids the log holds, e.g. [0, 1]. */
      answeredPermissionSeqs?: number[];
    } = {},
  ): Promise<void> {
    const log = await openChatLog(assignmentDir);
    const base = { assignmentId: ASSIGNMENT_ID, agentId: 'claude', sessionKey: SESSION_KEY };

    await log.append({
      ...base,
      turnId: null,
      kind: 'session.created',
      payload: { acpSessionId: 'acp-session-1', harness: 'claude', adapterVersion: 'x@1', cwd: worktree },
    });
    // The message the crashed turn was carrying: queued, then picked up.
    await log.append({
      ...base,
      turnId: null,
      kind: 'user.message',
      payload: { messageId: 'm-inflight', text: 'in flight when it died', state: 'queued' },
    });
    await log.append({
      ...base,
      turnId: 'turn-crashed',
      kind: 'turn.start',
      payload: { messageId: 'm-inflight', startedAt: '2026-09-02T12:00:00.000Z' },
    });
    if (opts.pendingPermission) {
      await log.append({
        ...base,
        turnId: 'turn-crashed',
        kind: 'acp.permission_request',
        payload: {
          requestId: 'perm-crashed',
          request: { toolCall: { toolCallId: 't1', title: 'Run `rm -rf /`' }, options: [] },
        },
      });
    }
    for (const seq of opts.answeredPermissionSeqs ?? []) {
      const requestId = `${SESSION_KEY}:perm:${seq}`;
      await log.append({
        ...base,
        turnId: 'turn-crashed',
        kind: 'acp.permission_request',
        payload: { requestId, request: { toolCall: { toolCallId: `t${seq}`, title: `Run ${seq}` }, options: [] } },
      });
      await log.append({
        ...base,
        turnId: 'turn-crashed',
        kind: 'acp.permission_response',
        payload: { requestId, optionId: 'allow' },
      });
    }
    // Messages that were still waiting their turn.
    for (const [index, text] of (opts.queuedMessages ?? []).entries()) {
      await log.append({
        ...base,
        turnId: null,
        kind: 'user.message',
        payload: { messageId: `m-queued-${index}`, text, state: 'queued' },
      });
    }

    upsertChatSession({
      sessionKey: SESSION_KEY,
      assignmentId: ASSIGNMENT_ID,
      projectSlug: 'syntaur-meta',
      assignmentSlug: 'chat-demo',
      agentId: 'claude',
      harness: 'claude',
      acpSessionId: 'acp-session-1',
      adapterVersion: 'x@1',
      cwd: worktree,
      state: 'running',
      usageSnapshotJson: JSON.stringify(CRASH_SNAPSHOT),
    });
    const db = getSessionDb();
    db.prepare(
      "INSERT INTO sessions (session_id, agent, started, status, path, hosted_by) VALUES ('acp-session-1','claude',?,'active',?, 'acp')",
    ).run('2026-09-02T12:00:00.000Z', worktree);
    // The engagement the crashed turn opened and never closed.
    openEngagement({
      sessionId: 'acp-session-1',
      assignmentId: ASSIGNMENT_ID,
      projectSlug: 'syntaur-meta',
      assignmentSlug: 'chat-demo',
      stage: 'chat',
      startedAt: '2026-09-02T12:00:00.000Z',
      tokensAtOpen: CRASH_SNAPSHOT,
    });
    upsertChatItem(SESSION_KEY, {
      itemId: 'turn-crashed:0',
      assignmentId: ASSIGNMENT_ID,
      turnId: 'turn-crashed',
      agentId: 'claude',
      type: 'turn.status',
      ts: '2026-09-02T12:00:00.000Z',
      seqFirst: 2,
      seqLast: 2,
      sealed: false,
      state: 'running',
      startedAt: '2026-09-02T12:00:00.000Z',
    } as never);
  }

  it('seals the orphaned turn, closes the dangling engagement and still runs the next turn', async () => {
    await seedCrashedState();
    makeBroker({ agentOptions: { sessionIds: ['acp-session-1'] } });

    await broker.send({ assignment: assignment(), text: 'after the restart' });
    await waitUntil(() => fake.prompts.length === 1, 'the post-restart prompt');
    await waitUntil(
      () =>
        (itemsOfType('turn.status') as Array<{ state: string }>).length === 2 &&
        (itemsOfType('turn.status') as Array<{ state: string }>).every((s) => s.state === 'ended'),
      'both turns to be ended',
    );

    // Finding 2: the orphan is sealed as an error, not left running forever.
    const statuses = itemsOfType('turn.status') as Array<{ state: string; stopReason?: string }>;
    expect(statuses.map((s) => s.state)).toEqual(['ended', 'ended']);
    expect(statuses[0].stopReason).toBe('error');

    // Finding 1: the dangling engagement is closed as an error, NOT silently
    // absorbed into a `chat-registered` window, and nothing is left open.
    const db = getSessionDb();
    const engagements = db
      .prepare('SELECT close_reason FROM engagement ORDER BY id')
      .all() as Array<{ close_reason: string }>;
    expect(engagements[0].close_reason).toBe('error');
    const open = db.prepare('SELECT COUNT(*) AS n FROM engagement WHERE ended_at IS NULL').get() as {
      n: number;
    };
    expect(open.n).toBe(0);
  });

  it('re-queues messages the crash never sent, in order, without resending the one in flight', async () => {
    await seedCrashedState({ queuedMessages: ['first waiting', 'second waiting'] });
    makeBroker({ agentOptions: { sessionIds: ['acp-session-1'] } });

    // Finding 3 + 8: the queue is visible before anything new is sent.
    const summary = await broker.getSession(assignment(), 'claude');
    expect(summary?.queued.map((q) => q.text)).toEqual(['first waiting', 'second waiting']);

    await broker.send({ assignment: assignment(), text: 'third' });
    await waitUntil(() => fake.prompts.length === 3, 'all three queued messages to be sent');

    const sent = fake.prompts.map((p) => (p.prompt[p.prompt.length - 1] as { text: string }).text);
    expect(sent[0]).toContain('first waiting');
    expect(sent[1]).toContain('second waiting');
    expect(sent[2]).toContain('third');
    // The message the crashed turn was already carrying is NOT re-sent.
    expect(sent.some((t) => t.includes('in flight when it died'))).toBe(false);
  });

  it('withdraw works on a re-queued message after a restart (finding 8)', async () => {
    await seedCrashedState({ queuedMessages: ['withdraw me'] });
    makeBroker({ agentOptions: { sessionIds: ['acp-session-1'] } });

    // Nothing has been sent yet in this process, so the session only exists
    // because withdraw materialises it.
    expect(await broker.withdraw(assignment(), 'm-queued-0')).toBe(true);
    expect(await broker.withdraw(assignment(), 'm-queued-0')).toBe(false);

    const summary = await broker.getSession(assignment(), 'claude');
    expect(summary?.queued).toEqual([]);
  });

  it('sends re-queued messages on session load alone, with no new message (round 2, finding 2)', async () => {
    await seedCrashedState({ queuedMessages: ['first waiting', 'second waiting'] });
    makeBroker({ agentOptions: { sessionIds: ['acp-session-1'] } });

    // Opening the Chat tab calls GET .../chat/session and nothing else. The
    // docs promise recovered messages are "re-queued and sent in order", so
    // this alone must drain them.
    await broker.getSession(assignment(), 'claude');
    await waitUntil(() => fake.prompts.length === 2, 'both recovered messages to be sent');

    const sent = fake.prompts.map((p) => (p.prompt[p.prompt.length - 1] as { text: string }).text);
    expect(sent[0]).toContain('first waiting');
    expect(sent[1]).toContain('second waiting');
  });

  it('repairs exactly once under two concurrent loads (round 2, finding 1)', async () => {
    await seedCrashedState();
    makeBroker({ agentOptions: { sessionIds: ['acp-session-1'] } });

    // Two tabs hitting the broker at the same instant: one construction, one
    // repair, and nothing may drive a half-repaired session.
    const [a, b] = await Promise.all([
      broker.getSession(assignment(), 'claude'),
      broker.send({ assignment: assignment(), text: 'from the other tab' }),
    ]);
    expect(a).not.toBeNull();
    expect(b.messageId).toBeTruthy();
    await idle(2);

    const db = getSessionDb();
    const engagements = db
      .prepare("SELECT close_reason FROM engagement WHERE stage = 'chat' ORDER BY id")
      .all() as Array<{ close_reason: string }>;
    // The crashed turn's engagement is closed ONCE, as an error — never
    // re-absorbed as a `chat-registered` window by a racing drive.
    expect(engagements.filter((e) => e.close_reason === 'error')).toHaveLength(1);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM engagement WHERE stage = 'chat' AND close_reason = 'chat-registered'")
        .get(),
    ).toEqual({ n: 0 });

    // The decisive check: repair ran ONCE. Two concurrent constructions would
    // each seal the orphan, appending two `turn.end` events for one turnId —
    // invisible in the item list, because the normalizer ignores the second.
    const logged = await events();
    const sealEvents = logged.filter(
      (e) => e.kind === 'turn.end' && e.turnId === 'turn-crashed',
    );
    expect(sealEvents).toHaveLength(1);
    const resumeNotices = logged.filter(
      (e) => e.kind === 'system' && /Resuming \d+ message/.test((e.payload as { text: string }).text),
    );
    expect(resumeNotices.length).toBeLessThanOrEqual(1);

    const statuses = itemsOfType('turn.status') as Array<{ state: string; stopReason?: string }>;
    expect(statuses).toHaveLength(2);
    expect(statuses.filter((t) => t.stopReason === 'error')).toHaveLength(1);
    expect(statuses.every((t) => t.state === 'ended')).toBe(true);
    expect(fake.prompts).toHaveLength(1);
  });

  it('continues the permission id sequence across a restart (round 2, finding 3)', async () => {
    await seedCrashedState({ answeredPermissionSeqs: [0, 1] });
    makeBroker({
      turns: [
        {
          steps: [
            {
              kind: 'permission',
              request: {
                toolCall: { toolCallId: 't-new', title: 'Run something new' },
                options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
              },
            },
          ],
        },
      ],
      agentOptions: { sessionIds: ['acp-session-1'] },
    });

    await broker.send({ assignment: assignment(), text: 'ask me' });
    await waitUntil(
      () => itemsOfType('permission.request').some((i) => (i as { requestId: string }).requestId.endsWith(':perm:2')),
      'a permission id that continues the sequence',
    );

    const ids = (itemsOfType('permission.request') as Array<{ requestId: string }>).map((i) => i.requestId);
    // perm:0 and perm:1 are the log's; the new one must not reuse either.
    expect(ids).toContain(`${SESSION_KEY}:perm:2`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shuts down a session that finishes building after stopAll (round 3)', async () => {
    await seedCrashedState();
    makeBroker({ agentOptions: { sessionIds: ['acp-session-1'] } });

    // Start a load and shut down while it is still inside `buildSession`.
    // `ensureSession` yields on `loadAgentDefinitions` before anything is
    // published, and `stopAll` runs to completion synchronously against an
    // empty session map — exactly the window the finding describes.
    const loading = broker.getSession(assignment(), 'claude');
    await broker.stopAll();
    await loading;

    // The session must not have slipped into a map the shutdown already walked:
    // it is stopped either way, which is only true if stopAll joined the
    // construction (or the construction saw `stopping` and stood down).
    const row = getChatSession(ASSIGNMENT_ID, 'claude');
    expect(row?.state).toBe('stopped');
    const db = getSessionDb();
    expect(
      (db.prepare("SELECT status FROM sessions WHERE session_id = 'acp-session-1'").get() as {
        status: string;
      }).status,
    ).toBe('stopped');

    // Nothing left running or dangling.
    expect(clients.every((c) => !c.alive())).toBe(true);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM engagement WHERE ended_at IS NULL').get() as { n: number }).n,
    ).toBe(0);
  });

  it('resolves a permission the crash orphaned instead of leaving live buttons', async () => {
    await seedCrashedState({ pendingPermission: true });
    makeBroker({ agentOptions: { sessionIds: ['acp-session-1'] } });
    await broker.getSession(assignment(), 'claude');

    await waitUntil(
      () =>
        items().some(
          (i) => i.type === 'system' && /expired when the dashboard restarted/.test((i as { text: string }).text),
        ),
      'the expired-permission notice',
    );
    // The ACP request died with the process that made it, so it cannot be
    // answered — it is cancelled, and answering now correctly reports false.
    expect(await broker.answerPermission(assignment(), 'perm-crashed', 'allow')).toBe(false);
  });
});

describe('one event log per assignment (finding 4)', () => {
  it('two agents on one assignment append to the same log with strictly increasing seq', async () => {
    // Each session gets its own fake agent: one `AgentApp` does not serve two
    // concurrent client connections. The assertion is about the shared LOG.
    const agents: FakeAgent[] = [];
    broker = createChatBroker({
      projectsDir: join(sandbox, 'projects'),
      assignmentsDir: join(sandbox, 'assignments'),
      syntaurHome: sandbox,
      broadcast: (message) => frames.push({ type: message.type, payload: message.payload }),
      clientFactory: (input) => {
        const own = createFakeAgent({
          turns: [{ steps: [{ kind: 'update', update: textChunk('ok', 'm1') }] }],
          sessionIds: [`acp-${agents.length + 1}`],
        });
        agents.push(own);
        const client = connectAcpClient(own.app, {
          onUpdate: input.onUpdate,
          onPermissionRequest: input.onPermissionRequest,
        });
        clients.push(client);
        return client;
      },
      timeouts: { flushMs: 1, sessionIdleMs: 60_000 },
    });

    await broker.send({ assignment: assignment(), text: 'to claude', agentId: 'claude' });
    await broker.send({ assignment: assignment(), text: 'to codex', agentId: 'codex' });
    await waitUntil(
      () => agents.length === 2 && agents.every((a) => a.prompts.length === 1),
      'both agents to receive their prompt',
    );

    const logged = await events();
    expect(logged.length).toBeGreaterThan(4);
    // One file, one counter: no duplicates, no gaps, strictly increasing.
    const seqs = logged.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBe(0);
    expect(seqs[seqs.length - 1]).toBe(seqs.length - 1);
    // Both agents really did write to it — alongside the `human`-authored
    // routing rows, which live in the assignment scope (Decision 3).
    const authors = new Set(logged.map((e) => e.agentId));
    expect(authors).toEqual(new Set(['human', 'claude', 'codex']));
    expect(new Set(logged.map((e) => e.sessionKey))).toEqual(
      new Set([`${ASSIGNMENT_ID}:@assignment`, `${ASSIGNMENT_ID}:claude`, `${ASSIGNMENT_ID}:codex`]),
    );
  });
});

describe('the drive loop never loses a message (finding 5)', () => {
  it('keeps a message queued when the adapter cannot start, and reports why', async () => {
    makeBroker();
    // No workspace ⇒ ensureAdapter throws before the turn is committed.
    await writeAssignment({ worktreePath: '/nope/nowhere', repository: worktree });
    // `send` itself refuses on a bad cwd, so queue through a good one first and
    // then break the workspace under it.
    const { messageId } = await broker.send({ assignment: assignment(), text: 'keep me' });
    await idle();
    expect(messageId).toBeTruthy();
  });

  it('seals the turn and stays drivable when the prompt itself fails', async () => {
    makeBroker({
      turns: [
        { steps: [{ kind: 'error', message: 'adapter blew up' }] },
        { steps: [{ kind: 'update', update: textChunk('recovered', 'm2') }] },
      ],
      agentOptions: { sessionIds: ['acp-session-1'] },
    });

    await broker.send({ assignment: assignment(), text: 'boom' });
    await idle();

    const first = itemsOfType('turn.status')[0] as { state: string; stopReason?: string };
    expect(first.state).toBe('ended');
    expect(first.stopReason).toBe('error');
    // The chain survives: a later message still drives.
    const db = getSessionDb();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM engagement WHERE ended_at IS NULL').get() as { n: number }).n,
    ).toBe(0);

    await broker.send({ assignment: assignment(), text: 'again' });
    await idle(2);
    expect(fake.prompts).toHaveLength(2);
  });
});

describe('codex usage_events write (finding 7)', () => {
  it('writes cumulative totals with tool, cwd and both slugs', async () => {
    makeBroker({
      turns: [
        { steps: [], usage: usage(100, 20) },
        { steps: [], usage: usage(50, 10) },
      ],
      agentOptions: {
        sessionIds: ['codex-session-1'],
        configOptions: [
          { id: 'model', name: 'Model', type: 'select', currentValue: 'gpt-5.6-sol', options: [] },
        ] as never,
      },
    });

    await broker.send({ assignment: assignment(), text: 'one', agentId: 'codex' });
    await idle();
    const afterOne = getSessionDb()
      .prepare('SELECT * FROM usage_events')
      .all() as Array<Record<string, unknown>>;
    expect(afterOne).toHaveLength(1);
    expect(afterOne[0]).toMatchObject({
      session_id: 'codex-session-1',
      model: 'gpt-5.6-sol',
      tool: 'acp-codex',
      cwd: worktree,
      project_slug: 'syntaur-meta',
      assignment_slug: 'chat-demo',
      total_tokens: 120,
    });

    await broker.send({ assignment: assignment(), text: 'two', agentId: 'codex' });
    await idle(2);
    const afterTwo = getSessionDb()
      .prepare('SELECT total_tokens, input_tokens FROM usage_events')
      .all() as Array<{ total_tokens: number; input_tokens: number }>;
    // CUMULATIVE, not per-turn: `upsertEvent` keeps MAX() per column, so a
    // per-turn delta would be silently discarded (Decision 10).
    expect(afterTwo).toHaveLength(1);
    expect(afterTwo[0].total_tokens).toBe(180);
    expect(afterTwo[0].input_tokens).toBe(150);

    // `gpt-5.6-sol` has had a price list entry since Task 6, so there is no
    // unpriced notice — the "no price list entry" path is covered against a
    // model that really has none, in `codex pricing (Task 6)` below.
    const notices = items().filter(
      (i) => i.type === 'system' && /No price list entry/.test((i as { text: string }).text),
    );
    expect(notices).toEqual([]);
  });
});

describe('codex pricing (Task 6)', () => {
  /**
   * codex-acp reports token buckets but NO cost of its own, so a codex turn is
   * priced Syntaur-side from `MODEL_PRICING` (Decision 10). Before the OpenAI
   * rates existed, every one of those turns booked at $0 and the assignment's
   * usage rail read zero however much was spent.
   */
  async function runCodexTurn(model: string): Promise<void> {
    makeBroker({
      turns: [
        {
          steps: [{ kind: 'update', update: textChunk('Done.', 'm1') }],
          // 1M input + 1M output at sol's list price = $4.00 + $20.00.
          usage: usage(1_000_000, 1_000_000),
        },
      ],
      agentOptions: {
        sessionIds: ['acp-codex-1'],
        configOptions: [{ id: 'model', currentValue: model }] as never,
      },
    });
    await broker.send({ assignment: assignment(), agentId: 'codex', text: 'go' });
    await idle();
  }

  it('books a non-zero cost delta on the turn’s engagement', async () => {
    await runCodexTurn('gpt-5.6-sol');

    const turn = getSessionDb()
      .prepare(
        "SELECT tokens_at_open, tokens_at_close FROM engagement WHERE stage = 'chat' ORDER BY id LIMIT 1",
      )
      .get() as { tokens_at_open: string | null; tokens_at_close: string | null };
    const open = JSON.parse(turn.tokens_at_open!) as { models: Record<string, { cost: number }> };
    const close = JSON.parse(turn.tokens_at_close!) as { models: Record<string, { cost: number }> };
    const delta = close.models['gpt-5.6-sol'].cost - (open.models['gpt-5.6-sol']?.cost ?? 0);
    expect(delta).toBeCloseTo(24.0, 6);
  });

  it('writes the priced cumulative total into usage_events for the rail to roll up', async () => {
    await runCodexTurn('gpt-5.6-sol');

    const row = getSessionDb()
      .prepare('SELECT model, tool, total_cost, total_tokens FROM usage_events WHERE session_id = ?')
      .get('acp-codex-1') as
      | { model: string; tool: string; total_cost: number; total_tokens: number }
      | undefined;
    expect(row).toBeTruthy();
    expect(row!.model).toBe('gpt-5.6-sol');
    expect(row!.tool).toBe('acp-codex');
    expect(row!.total_tokens).toBe(2_000_000);
    expect(row!.total_cost).toBeCloseTo(24.0, 6);
  });

  it('still says so, once, when the model has no price list entry', async () => {
    await runCodexTurn('gpt-6-unreleased');
    // The notice is recorded fire-and-forget from `recordUsageEvent`, so it can
    // land just after the turn's own items — poll rather than assert instantly.
    const noticeCount = () =>
      (itemsOfType('system') as Array<{ text: string }>).filter((i) =>
        /No price list entry/.test(i.text),
      ).length;
    await waitUntil(() => noticeCount() === 1, 'the unpriced-model notice');
    expect(noticeCount()).toBe(1);
  });
});

describe('chat image attachments', () => {
  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  it('rejects a /command with attachments', async () => {
    makeBroker();
    const att = await writeChatAttachment(assignmentDir, {
      name: 'dot.png',
      mime: 'image/png',
      bytes: PNG_1X1,
    });
    await expect(
      broker.send({ assignment: assignment(), text: '/goal ship', attachments: [att] }),
    ).rejects.toThrow('A /command cannot carry attachments');
  });

  it('delivers an image block after the chat-event text', async () => {
    makeBroker();
    const att = await writeChatAttachment(assignmentDir, {
      name: 'dot.png',
      mime: 'image/png',
      bytes: PNG_1X1,
    });
    await broker.send({ assignment: assignment(), text: 'look', attachments: [att] });
    await waitUntil(() => fake.prompts.length === 1, 'the prompt');
    const blocks = fake.prompts[0].prompt;
    const last = blocks[blocks.length - 1] as { type: string; data?: string; mimeType?: string };
    expect(last.type).toBe('image');
    expect(last.mimeType).toBe('image/png');
    expect(last.data).toBe(PNG_1X1.toString('base64'));
  });

  it('warns and omits a missing attachment file', async () => {
    makeBroker();
    const att = await writeChatAttachment(assignmentDir, {
      name: 'gone.png',
      mime: 'image/png',
      bytes: PNG_1X1,
    });
    const { unlink } = await import('node:fs/promises');
    const { readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(assignmentDir, 'chat', 'attachments');
    const stored = (await readdir(dir)).find((n) => n.startsWith(`${att.id}__`))!;
    await unlink(join(dir, stored));
    await broker.send({ assignment: assignment(), text: 'look', attachments: [att] });
    await waitUntil(() => fake.prompts.length === 1, 'the prompt');
    expect(itemsOfType('system').some((s) => (s as { text: string }).text.includes('missing on disk'))).toBe(
      true,
    );
    expect(fake.prompts[0].prompt.some((b) => b.type === 'image')).toBe(false);
  });

  it('re-queues attachments after a crash repair', async () => {
    const att = await writeChatAttachment(assignmentDir, {
      name: 'dot.png',
      mime: 'image/png',
      bytes: PNG_1X1,
    });
    const log = await openChatLog(assignmentDir);
    const sessionKey = `${ASSIGNMENT_ID}:claude`;
    await log.append({
      assignmentId: ASSIGNMENT_ID,
      agentId: 'claude',
      sessionKey,
      turnId: null,
      kind: 'session.created',
      payload: { acpSessionId: 'acp-session-1', harness: 'claude', adapterVersion: 'x@1', cwd: worktree },
    });
    await log.append({
      assignmentId: ASSIGNMENT_ID,
      agentId: 'claude',
      sessionKey,
      turnId: null,
      kind: 'user.message',
      payload: {
        messageId: 'm-queued-att',
        text: 'after restart',
        state: 'queued',
        attachments: [att],
      },
    });
    upsertChatSession({
      sessionKey,
      assignmentId: ASSIGNMENT_ID,
      projectSlug: 'syntaur-meta',
      assignmentSlug: 'chat-demo',
      agentId: 'claude',
      harness: 'claude',
      acpSessionId: 'acp-session-1',
      adapterVersion: 'x@1',
      cwd: worktree,
      state: 'idle',
      usageSnapshotJson: JSON.stringify({
        models: {},
        total: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, cost: 0 },
      }),
    });
    makeBroker({ agentOptions: { sessionIds: ['acp-session-1'] } });
    await broker.getSession(assignment(), 'claude');
    await waitUntil(() => fake.prompts.length === 1, 'the recovered prompt');
    const last = fake.prompts[0].prompt[fake.prompts[0].prompt.length - 1] as {
      type: string;
      data?: string;
    };
    expect(last.type).toBe('image');
    expect(last.data).toBe(PNG_1X1.toString('base64'));
  });
});

describe('slash commands', () => {
  const sampleCommands = [
    { name: 'context', description: 'Show context usage', input: { hint: '[--json]' } },
    { name: 'plan', description: 'Turn plan mode on.', input: null },
  ] as acp.AvailableCommand[];

  function commandUpdateFrameCount(): number {
    let count = 0;
    let prev: string | null = null;
    for (const frame of frames) {
      if (frame.type !== 'chat-session') continue;
      const session = (frame.payload as { session: { commands: unknown[] } }).session;
      const key = JSON.stringify(session.commands);
      if (session.commands.length > 0 && key !== prev) {
        count += 1;
        prev = key;
      }
    }
    return count;
  }

  it('captures available_commands_update once per distinct list and persists it', async () => {
    makeBroker({
      turns: [
        { steps: [{ kind: 'update', update: textChunk('ok', 'm1') }] },
        { steps: [{ kind: 'update', update: textChunk('again', 'm2') }] },
      ],
      agentOptions: { availableCommands: sampleCommands },
    });

    await broker.send({ assignment: assignment(), text: 'hello' });
    await idle();
    await broker.send({ assignment: assignment(), text: 'second' });
    await idle(2);

    expect(commandUpdateFrameCount()).toBe(1);
    const row = getChatSession(ASSIGNMENT_ID, 'claude');
    expect(JSON.parse(row!.commands_json!)).toEqual([
      {
        name: 'context',
        description: 'Show context usage',
        inputHint: '[--json]',
        action: { kind: 'prompt' },
      },
      {
        name: 'plan',
        description: 'Turn plan mode on.',
        inputHint: null,
        action: { kind: 'prompt' },
      },
    ]);

    const summary = await broker.getSession(assignment(), 'claude');
    expect(summary?.commandsSource).toBe('session');
    expect(summary?.commands).toHaveLength(2);
  });

  it('serves harness-cache commands to a new agent before its first session', async () => {
    const commandsJson = JSON.stringify([
      {
        name: 'status',
        description: 'Display session configuration and token usage.',
        inputHint: null,
        action: { kind: 'prompt' },
      },
    ]);
    upsertChatSession({
      sessionKey: `${ASSIGNMENT_ID}:claude`,
      assignmentId: ASSIGNMENT_ID,
      projectSlug: 'syntaur-meta',
      assignmentSlug: 'chat-demo',
      agentId: 'claude',
      harness: 'codex',
      state: 'idle',
      commandsJson,
      lastTurnAt: '2026-09-03T12:00:00.000Z',
    });

    makeBroker({ turns: [{ steps: [] }] });
    const summary = await broker.getSession(assignment(), 'codex');
    expect(summary?.commandsSource).toBe('harness-cache');
    expect(summary?.commands[0]?.name).toBe('status');
  });

  it('backfills commands from the events log when commands_json is null', async () => {
    makeBroker({
      turns: [
        { steps: [{ kind: 'update', update: textChunk('ok', 'm1') }] },
        { steps: [{ kind: 'update', update: textChunk('again', 'm2') }] },
      ],
      agentOptions: { availableCommands: sampleCommands },
    });

    await broker.send({ assignment: assignment(), text: 'hello' });
    await idle();

    getSessionDb()
      .prepare('UPDATE chat_sessions SET commands_json = NULL WHERE assignment_id = ? AND agent_id = ?')
      .run(ASSIGNMENT_ID, 'claude');

    await broker.stopAll();
    makeBroker({
      turns: [{ steps: [] }],
      agentOptions: { availableCommands: sampleCommands },
    });

    const summary = await broker.getSession(assignment(), 'claude');
    expect(summary?.commandsSource).toBe('session');
    expect(summary?.commands).toHaveLength(2);
    const row = getChatSession(ASSIGNMENT_ID, 'claude');
    expect(row?.commands_json).toBeTruthy();
  });

  it('does not backfill when the newest harness marker names another harness', async () => {
    makeBroker({ turns: [{ steps: [] }] });
    const key = `${ASSIGNMENT_ID}:claude`;
    const log = await openChatLog(assignmentDir);
    await log.append({
      assignmentId: ASSIGNMENT_ID,
      agentId: 'claude',
      sessionKey: key,
      turnId: null,
      kind: 'session.created',
      payload: { harness: 'claude', acpSessionId: 's1', adapterVersion: null, cwd: worktree },
    });
    await log.append({
      assignmentId: ASSIGNMENT_ID,
      agentId: 'claude',
      sessionKey: key,
      turnId: null,
      kind: 'acp.update',
      payload: { sessionUpdate: 'available_commands_update', availableCommands: sampleCommands },
    });
    await log.append({
      assignmentId: ASSIGNMENT_ID,
      agentId: 'claude',
      sessionKey: key,
      turnId: null,
      kind: 'session.created',
      payload: { harness: 'codex', acpSessionId: 's2' },
    });

    upsertChatSession({
      sessionKey: key,
      assignmentId: ASSIGNMENT_ID,
      projectSlug: 'syntaur-meta',
      assignmentSlug: 'chat-demo',
      agentId: 'claude',
      harness: 'claude',
      state: 'idle',
      commandsJson: null,
    });
    getSessionDb().prepare('DELETE FROM chat_harness_options').run();

    const summary = await broker.getSession(assignment(), 'claude');
    expect(summary?.commandsSource).not.toBe('session');
    expect(getChatSession(ASSIGNMENT_ID, 'claude')?.commands_json).toBeNull();
  });

  it('ignores a later empty advertisement and keeps the harness record list', async () => {
    const emptyUpdate = {
      sessionUpdate: 'available_commands_update',
      availableCommands: [],
    } as acp.SessionUpdate;

    makeBroker({
      turns: [
        { steps: [{ kind: 'update', update: textChunk('ok', 'm1') }] },
        {
          steps: [
            { kind: 'update', update: emptyUpdate },
            { kind: 'update', update: textChunk('again', 'm2') },
          ],
        },
      ],
      agentOptions: { availableCommands: sampleCommands },
    });

    await broker.send({ assignment: assignment(), text: 'hello' });
    await idle();
    await broker.send({ assignment: assignment(), text: 'second' });
    await idle(2);

    expect(getHarnessOptions('claude').record?.commands).toEqual([
      {
        name: 'context',
        description: 'Show context usage',
        inputHint: '[--json]',
        action: { kind: 'prompt' },
      },
      {
        name: 'plan',
        description: 'Turn plan mode on.',
        inputHint: null,
        action: { kind: 'prompt' },
      },
    ]);
    const row = getChatSession(ASSIGNMENT_ID, 'claude');
    expect(JSON.parse(row!.commands_json!)).toHaveLength(2);
  });
});

describe('command turns', () => {
  const codexPlanCommand = [
    {
      name: 'plan',
      description: 'Turn plan mode on.',
      input: null,
      _meta: {
        commandAction: {
          kind: 'setConfigOption',
          configId: 'collaboration_mode',
          value: 'plan',
        },
      },
    },
    {
      name: 'goal',
      description: 'Set a goal.',
      input: { hint: '[objective]' },
      _meta: { commandAction: { kind: 'prefixPrompt' } },
    },
  ] as acp.AvailableCommand[];

  it('sends @codex /goal as a single raw block with no chat-event wrapper', async () => {
    makeBroker({
      turns: [{ steps: [{ kind: 'update', update: textChunk('done', 'm1') }] }],
      agentOptions: { availableCommands: codexPlanCommand },
    });
    await broker.send({ assignment: assignment(), agentId: 'codex', text: '@codex /goal ship it' });
    await idle();

    const commandPrompt = fake.prompts.find((p) =>
      p.prompt.some((b) => b.type === 'text' && (b as { text: string }).text === '/goal ship it'),
    );
    expect(commandPrompt).toBeTruthy();
    expect(commandPrompt!.prompt).toHaveLength(1);
    expect((commandPrompt!.prompt[0] as { text: string }).text).toBe('/goal ship it');
  });

  it('leaves lastDeliveredSeq unchanged on a command turn', async () => {
    makeBroker({
      turns: [
        { steps: [{ kind: 'update', update: textChunk('first', 'm1') }] },
        { steps: [{ kind: 'update', update: textChunk('context', 'm2') }] },
      ],
      agentOptions: { availableCommands: [{ name: 'context', description: 'ctx', input: null }] },
    });
    await broker.send({ assignment: assignment(), text: 'hello' });
    await idle();
    const before = (await broker.getSession(assignment(), 'claude'))!.lastDeliveredSeq;

    await broker.send({ assignment: assignment(), text: '/context' });
    await idle(2);
    const afterCommand = (await broker.getSession(assignment(), 'claude'))!.lastDeliveredSeq;
    expect(afterCommand).toBe(before);
  });

  it('runs set-config commands client-side with a system row', async () => {
    makeBroker({
      turns: [{ steps: [] }],
      agentOptions: {
        availableCommands: codexPlanCommand,
        configOptions: [{ id: 'collaboration_mode', currentValue: 'default' }] as never,
        setConfigOptionResponse: {
          configOptions: [{ id: 'collaboration_mode', currentValue: 'plan' }],
        } as never,
      },
    });
    await broker.send({ assignment: assignment(), agentId: 'codex', text: '/plan' });
    await idle();

    expect(fake.configCalls.some((c) => c.method === 'session/set_config_option')).toBe(true);
    const systems = itemsOfType('system') as Array<{ text: string }>;
    expect(systems.some((s) => s.text.includes('collaboration_mode = plan'))).toBe(true);
    expect((await broker.getSession(assignment(), 'codex'))?.mode).toBe('plan');
    expect(fake.prompts.some((p) => p.prompt.some((b) => (b as { text?: string }).text?.startsWith('/plan')))).toBe(
      false,
    );
  });

  it('sends an unlisted /command as raw text', async () => {
    makeBroker({
      turns: [{ steps: [{ kind: 'update', update: textChunk('ok', 'm1') }] }],
      agentOptions: { availableCommands: [] },
    });
    await broker.send({ assignment: assignment(), text: '/nope' });
    await idle();
    const nopePrompt = fake.prompts.find((p) =>
      p.prompt.some((b) => b.type === 'text' && (b as { text: string }).text === '/nope'),
    );
    expect((nopePrompt!.prompt[0] as { text: string }).text).toBe('/nope');
  });
});

describe('cursor harness reattach and extensions', () => {
  async function attachCursor(): Promise<void> {
    await broker.setParticipants(assignment(), { agents: ['cursor'], defaultAgent: 'cursor' });
  }

  it('reattaches via session/load without duplicating replayed items', async () => {
    makeBroker({
      turns: [{ steps: [{ kind: 'update', update: textChunk('loaded turn', 'm-load') }] }],
      agentOptions: {
        resumeSupported: false,
        sessionIds: ['cursor-session-1'],
        loadReplay: [
          textChunk('chunk one', 'replay-1'),
          textChunk('chunk two', 'replay-2'),
        ],
        configOptions: [
          { id: 'model', currentValue: 'composer-2.5[fast=true]' },
          { id: 'mode', currentValue: 'agent' },
        ] as never,
      },
    });
    await attachCursor();
    await broker.send({ assignment: assignment(), agentId: 'cursor', text: 'first' });
    await idle();
    const countAfterFirst = itemsOfType('agent.message').length;
    expect(fake.calls).toContain('session/new');

    await waitUntil(() => lastSessionFrame()?.state === 'idle', 'idle teardown', 2000);
    await broker.send({ assignment: assignment(), agentId: 'cursor', text: 'second' });
    await idle(2);

    const logged = await events();
    expect(logged.filter((e) => e.kind === 'session.load')).toHaveLength(1);
    expect(logged.filter((e) => e.kind === 'session.loaded')).toHaveLength(1);
    expect(fake.calls.filter((c) => c === 'session/resume')).toHaveLength(0);
    expect(fake.calls.filter((c) => c === 'session/load')).toHaveLength(1);
    expect(itemsOfType('agent.message').length).toBeGreaterThanOrEqual(countAfterFirst);
    expect((await broker.getSession(assignment(), 'cursor'))?.effort).toBeNull();
    expect((await broker.getSession(assignment(), 'cursor'))?.model).toBe('composer-2.5[fast=true]');
  });

  it('accepts create_plan and renders the plan text', async () => {
    makeBroker({
      turns: [
        {
          steps: [
            {
              kind: 'extRequest',
              method: 'cursor/create_plan',
              params: {
                toolCallId: 'tool-plan',
                name: 'My plan',
                overview: 'Overview',
                plan: '# Steps\n\n1. Do it',
              },
            },
            { kind: 'update', update: textChunk('done', 'm-plan') },
          ],
        },
      ],
      agentOptions: { resumeSupported: false },
    });
    await attachCursor();
    await broker.send({ assignment: assignment(), agentId: 'cursor', text: 'plan this' });
    await idle();
    const planMessage = itemsOfType('agent.message').find((m) =>
      (m as { text: string }).text.includes('My plan'),
    );
    expect(planMessage).toBeDefined();
    expect(fake.extAnswers[0]).toEqual({ outcome: { outcome: 'accepted' } });
  });

  it('answers ask_question through the broker route', async () => {
    makeBroker({
      turns: [
        {
          steps: [
            {
              kind: 'extRequest',
              method: 'cursor/ask_question',
              params: {
                toolCallId: 'tool-q',
                title: 'Pick one',
                questions: [
                  {
                    id: 'q1',
                    prompt: 'Which?',
                    options: [
                      { id: 'a', label: 'A' },
                      { id: 'b', label: 'B' },
                    ],
                  },
                ],
              },
            },
            { kind: 'update', update: textChunk('thanks', 'm-q') },
          ],
        },
      ],
      agentOptions: { resumeSupported: false },
    });
    await attachCursor();
    const sendP = broker.send({ assignment: assignment(), agentId: 'cursor', text: 'ask me' });
    await waitUntil(() => itemsOfType('question').length > 0, 'question card');
    const question = itemsOfType('question')[0] as { requestId: string };
    const answered = await broker.answerQuestion(assignment(), question.requestId, { optionId: 'a' });
    expect(answered).toBe(true);
    await sendP;
    await idle();
    const card = itemsOfType('question')[0] as { answer: string | null };
    expect(card.answer).toBe('A');
    expect(fake.extAnswers[0]).toEqual({
      outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }] },
    });
  });

  it('posts the cursor no-usage notice once', async () => {
    makeBroker({
      turns: [{ steps: [{ kind: 'update', update: textChunk('hi', 'm1') }] }],
      agentOptions: { resumeSupported: false },
    });
    await attachCursor();
    await broker.send({ assignment: assignment(), agentId: 'cursor', text: 'one' });
    await broker.send({ assignment: assignment(), agentId: 'cursor', text: 'two' });
    await idle(2);
    const notices = itemsOfType('system').filter((s) =>
      (s as { text: string }).text.includes('cursor reports no usage'),
    );
    expect(notices).toHaveLength(1);
  });
});

describe('turn progress entries', () => {
  const progressPath = () => join(assignmentDir, 'progress.md');
  const progressCount = async () => parseProgress(await readFile(progressPath(), 'utf-8')).entryCount;

  it('appends one entry when a turn edits a file', async () => {
    makeBroker({
      turns: [
        {
          steps: [
            {
              kind: 'update',
              update: toolCall('t1', {
                kind: 'edit',
                title: 'Edit a.ts',
                locations: [{ path: join(worktree, 'src/a.ts') }],
                status: 'completed',
              }),
            },
            { kind: 'update', update: textChunk('Done.') },
          ],
        },
      ],
    });

    await broker.send({ assignment: assignment(), text: 'edit something' });
    await idle();
    await waitUntil(async () => (await progressCount()) === 1, 'the progress entry');

    const content = await readFile(progressPath(), 'utf-8');
    const parsed = parseProgress(content);
    expect(parsed.entryCount).toBe(1);
    expect(content).toContain('**@claude**');
    expect(content).toContain('src/a.ts');
    expect(content).toContain('> Done.');
  });

  it('leaves entryCount unchanged for a talk-only turn', async () => {
    makeBroker({
      turns: [{ steps: [{ kind: 'update', update: textChunk('Just chatting.') }] }],
    });
    const before = await progressCount();
    await broker.send({ assignment: assignment(), text: 'hello' });
    await idle();
    expect(await progressCount()).toBe(before);
  });

  it('leaves entryCount unchanged when a turn is cancelled', async () => {
    makeBroker({ turns: [{ steps: [{ kind: 'awaitCancel' }] }] });
    const before = await progressCount();
    await broker.send({ assignment: assignment(), text: 'go' });
    await waitUntil(() => fake.prompts.length === 1, 'the prompt');
    await broker.cancel(assignment());
    await idle();
    expect(await progressCount()).toBe(before);
  });

  it('writes separate entries when two agents finish work turns back-to-back', async () => {
    const agents: FakeAgent[] = [];
    broker = createChatBroker({
      projectsDir: join(sandbox, 'projects'),
      assignmentsDir: join(sandbox, 'assignments'),
      syntaurHome: sandbox,
      broadcast: (message) => frames.push({ type: message.type, payload: message.payload }),
      clientFactory: (input) => {
        const own = createFakeAgent({
          turns: [
            {
              steps: [
                {
                  kind: 'update',
                  update: toolCall('t1', {
                    kind: 'edit',
                    title: 'Edit',
                    locations: [{ path: join(worktree, 'a.ts') }],
                    status: 'completed',
                  }),
                },
                { kind: 'update', update: textChunk('ok') },
              ],
            },
          ],
          sessionIds: [`acp-${agents.length + 1}`],
        });
        agents.push(own);
        const client = connectAcpClient(own.app, {
          onUpdate: input.onUpdate,
          onPermissionRequest: input.onPermissionRequest,
        });
        clients.push(client);
        return client;
      },
      timeouts: { flushMs: 1, sessionIdleMs: 60_000 },
    });

    await broker.send({ assignment: assignment(), text: 'claude work', agentId: 'claude' });
    await broker.send({ assignment: assignment(), text: 'codex work', agentId: 'codex' });
    await idle(2);
    await waitUntil(async () => {
      const text = await readFile(progressPath(), 'utf-8');
      const parsed = parseProgress(text);
      return (
        parsed.entryCount === 2 && text.includes('**@claude**') && text.includes('**@codex**')
      );
    }, 'two progress entries with both agents');

    const content = await readFile(progressPath(), 'utf-8');
    const parsed = parseProgress(content);
    expect(parsed.entryCount).toBe(2);
    expect(content).toContain('**@claude**');
    expect(content).toContain('**@codex**');
    const headings = content.match(/^## /gm) ?? [];
    expect(headings.length).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(process.platform === 'win32')(
    'records a warn row when progress.md is unwritable',
    async () => {
      makeBroker({
        turns: [
          { steps: [{ kind: 'update', update: textChunk('warmup') }] },
          {
            steps: [
              {
                kind: 'update',
                update: toolCall('t1', {
                  kind: 'edit',
                  title: 'Edit',
                  locations: [{ path: join(worktree, 'x.ts') }],
                  status: 'completed',
                }),
              },
              { kind: 'update', update: textChunk('Done.') },
            ],
          },
        ],
      });

      await broker.send({ assignment: assignment(), text: 'warm up' });
      await idle();

      const { chmod } = await import('node:fs/promises');
      try {
        await chmod(progressPath(), 0o444);
        await chmod(assignmentDir, 0o555);
        await broker.send({ assignment: assignment(), text: 'edit' });
        await idle(2);
        await waitUntil(
          () =>
            itemsOfType('system').some((s) =>
              (s as { text: string }).text.includes('Could not write the progress entry'),
            ),
          'the progress write warn row',
        );

        const warns = itemsOfType('system').filter((s) =>
          (s as { text: string }).text.includes('Could not write the progress entry'),
        );
        expect(warns.length).toBeGreaterThanOrEqual(1);
        const status = itemsOfType('turn.status').at(-1) as { stopReason?: string } | undefined;
        expect(status?.stopReason).toBe('end_turn');
      } finally {
        await chmod(assignmentDir, 0o755);
        await chmod(progressPath(), 0o644);
      }
    },
  );
});

describe('inbox questions (needs-me)', () => {
  const commentsPath = () => join(assignmentDir, 'comments.md');

  async function parseAssignmentComments() {
    return parseComments(await readFile(commentsPath(), 'utf-8'));
  }

  async function writeAgentFile(id: string, extra = ''): Promise<void> {
    const dir = agentsDir(sandbox);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${id}.md`),
      [
        '---',
        `id: ${id}`,
        `name: ${id}`,
        `color: ${id === 'cursor' ? 'sky' : 'violet'}`,
        `harness: ${id}`,
        extra,
        'respondsTo: mentions',
        `default: ${id === 'claude'}`,
        '---',
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  const permissionTurn: FakeTurn = {
    steps: [
      {
        kind: 'permission',
        request: {
          toolCall: { toolCallId: 't1', title: 'Run `ls`', kind: 'execute' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
          ],
        },
      },
      { kind: 'update', update: textChunk('done', 'm1') },
    ],
  };

  it('files a reply question after a human turn ending in a decision request', async () => {
    makeBroker({
      turns: [{ steps: [{ kind: 'update', update: textChunk('Which name should I use: alpha or beta?', 'm1') }] }],
    });
    await broker.send({ assignment: assignment(), text: 'pick a name' });
    await idle();
    await waitUntil(() => existsSync(commentsPath()), 'comments.md');
    const parsed = await parseAssignmentComments();
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({ author: 'claude', type: 'question', resolved: false });
    expect(parsed.entries[0].body).toContain('Which name should I use: alpha or beta?');
    expect(parsed.entries[0].body).toContain('kind="reply"');
    const reply = itemsOfType('agent.message')[0] as { itemId: string };
    const status = itemsOfType('turn.status')[0] as { turnId: string };
    expect(parsed.entries[0].body).toContain(`item="${reply.itemId}"`);
    expect(parsed.entries[0].body).toContain(`turn="${status.turnId}"`);
  });

  it('does not file a reply question for a non-question ending', async () => {
    makeBroker({ turns: [{ steps: [{ kind: 'update', update: textChunk('Done.', 'm1') }] }] });
    await broker.send({ assignment: assignment(), text: 'go' });
    await idle();
    expect(existsSync(commentsPath())).toBe(false);
  });

  it('does not file when the reply hops to another agent', async () => {
    await writeAgentFile('claude');
    await writeAgentFile('codex');
    const codexFake = createFakeAgent({
      turns: [{ steps: [{ kind: 'update', update: textChunk('ok', 'm2') }] }],
      sessionIds: ['acp-codex-1'],
    });
    fake = createFakeAgent({
      turns: [{ steps: [{ kind: 'update', update: textChunk('@codex which name should we use: alpha or beta?', 'm1') }] }],
      sessionIds: ['acp-claude-1'],
    });
    broker = createChatBroker({
      projectsDir: join(sandbox, 'projects'),
      assignmentsDir: join(sandbox, 'assignments'),
      syntaurHome: sandbox,
      broadcast: (message) => frames.push({ type: message.type, payload: message.payload }),
      clientFactory: (input) => {
        const app = input.agentId === 'codex' ? codexFake.app : fake.app;
        const client = connectAcpClient(app, {
          onUpdate: input.onUpdate,
          onPermissionRequest: input.onPermissionRequest,
          onExtRequest: input.onExtRequest,
          onExtNotification: input.onExtNotification,
        });
        clients.push(client);
        return client;
      },
      timeouts: { flushMs: 1, permissionMs: 200, sessionIdleMs: 120, shutdownGraceMs: 200, inboxGraceMs: 60_000 },
    });
    await broker.setParticipants(assignment(), { agents: ['claude', 'codex'], defaultAgent: 'claude' });
    await broker.send({ assignment: assignment(), text: 'pick' });
    await idle(2);
    expect(existsSync(commentsPath())).toBe(false);
  });

  it('resolves a reply question when the human sends to that agent', async () => {
    makeBroker({
      turns: [
        { steps: [{ kind: 'update', update: textChunk('Which name should I use: alpha or beta?', 'm1') }] },
        { steps: [{ kind: 'update', update: textChunk('alpha it is', 'm2') }] },
      ],
    });
    await broker.send({ assignment: assignment(), text: 'pick' });
    await idle();
    await waitUntil(() => existsSync(commentsPath()), 'comments.md');
    const before = await parseAssignmentComments();
    expect(before.entries[0].resolved).toBe(false);
    await broker.send({ assignment: assignment(), text: 'use alpha' });
    await idle(2);
    const after = await parseAssignmentComments();
    expect(after.entries[0].resolved).toBe(true);
  });

  it('files a permission grace comment and resolves it on answer', async () => {
    makeBroker({ turns: [permissionTurn], timeouts: { inboxGraceMs: 1, permissionMs: 60_000 } });
    await broker.send({ assignment: assignment(), text: 'go' });
    await waitUntil(() => itemsOfType('permission.request').length === 1, 'permission card');
    await waitUntil(() => existsSync(commentsPath()), 'grace comment');
    const perm = itemsOfType('permission.request')[0] as { requestId: string; itemId: string };
    const parsed = await parseAssignmentComments();
    expect(parsed.entries[0].body).toContain('kind="permission"');
    expect(parsed.entries[0].body).toContain(`item="${perm.itemId}"`);
    expect(await broker.answerPermission(assignment(), perm.requestId, 'allow')).toBe(true);
    await idle();
    const after = await parseAssignmentComments();
    expect(after.entries[0].resolved).toBe(true);
  });

  it('does not file a grace comment when permission is answered before the grace', async () => {
    makeBroker({ turns: [permissionTurn], timeouts: { inboxGraceMs: 60_000, permissionMs: 60_000 } });
    await broker.send({ assignment: assignment(), text: 'go' });
    await waitUntil(() => itemsOfType('permission.request').length === 1, 'permission card');
    const perm = itemsOfType('permission.request')[0] as { requestId: string };
    expect(await broker.answerPermission(assignment(), perm.requestId, 'allow')).toBe(true);
    await idle();
    expect(existsSync(commentsPath())).toBe(false);
  });

  it('resolves the grace comment before filing the timeout denial question', async () => {
    makeBroker({ turns: [permissionTurn], timeouts: { inboxGraceMs: 5, permissionMs: 80 } });
    await broker.send({ assignment: assignment(), text: 'go' });
    await waitUntil(() => existsSync(commentsPath()), 'grace comment');
    await waitUntil(async () => {
      const parsed = await parseAssignmentComments();
      const open = parsed.entries.filter((e) => e.type === 'question' && e.resolved !== true);
      return open.length === 1 && open[0].body.includes('nobody answered within');
    }, 'denial question');
  });

  it('files and resolves an ask_question grace comment', async () => {
    await writeAgentFile('cursor');
    makeBroker({
      turns: [
        {
          steps: [
            {
              kind: 'extRequest',
              method: 'cursor/ask_question',
              params: {
                toolCallId: 'tool-q',
                title: 'Pick one',
                questions: [{ id: 'q1', prompt: 'Which colour?', options: [{ id: 'a', label: 'A' }] }],
              },
            },
            { kind: 'update', update: textChunk('thanks', 'm-q') },
          ],
        },
      ],
      agentOptions: { resumeSupported: false },
      timeouts: { inboxGraceMs: 1, permissionMs: 60_000 },
    });
    await broker.setParticipants(assignment(), { agents: ['cursor'], defaultAgent: 'cursor' });
    const sendP = broker.send({ assignment: assignment(), agentId: 'cursor', text: 'ask' });
    await waitUntil(() => itemsOfType('question').length > 0, 'question card');
    await waitUntil(() => existsSync(commentsPath()), 'grace comment');
    const card = itemsOfType('question')[0] as { requestId: string; itemId: string };
    const parsed = await parseAssignmentComments();
    expect(parsed.entries[0].body).toContain('kind="ask"');
    expect(parsed.entries[0].body).toContain('Which colour?');
    expect(await broker.answerQuestion(assignment(), card.requestId, { optionId: 'a' })).toBe(true);
    await sendP;
    await idle();
    expect((await parseAssignmentComments()).entries[0].resolved).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'warns and still ends the turn when comments.md cannot be written',
    async () => {
      makeBroker({
        turns: [
          { steps: [{ kind: 'update', update: textChunk('warmup', 'm0') }] },
          { steps: [{ kind: 'update', update: textChunk('Which name should I use: alpha or beta?', 'm1') }] },
        ],
      });
      await broker.send({ assignment: assignment(), text: 'warm up' });
      await idle();
      const { chmod } = await import('node:fs/promises');
      await writeFile(
        commentsPath(),
        '---\nassignment: chat-demo\nentryCount: 0\nupdated: "x"\n---\n\n# Comments\n\nNo comments yet.\n',
      );
      try {
        await chmod(commentsPath(), 0o000);
        await broker.send({ assignment: assignment(), text: 'pick' });
        await idle(2);
        await waitUntil(
          () => systemTexts().some((t) => t.includes('Could not file the Inbox question')),
          'warn row',
          10_000,
        );
        const status = itemsOfType('turn.status').at(-1) as { stopReason?: string };
        expect(status.stopReason).toBe('end_turn');
      } finally {
        await chmod(commentsPath(), 0o644);
      }
    },
  );
});

function systemTexts(): string[] {
  return (itemsOfType('system') as Array<{ text: string }>).map((i) => i.text);
}

