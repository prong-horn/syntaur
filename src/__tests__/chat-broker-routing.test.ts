import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeSessionDb, initSessionDb } from '../dashboard/session-db.js';
import { closeUsageDb, initUsageDb } from '../db/usage-db.js';
import { openChatLog, readEvents } from '../chat/store.js';
import { connectAcpClient, type AcpClient } from '../chat/acp-client.js';
import { createFakeAgent, textChunk, toolCall, type FakeAgent, type FakeTurn } from '../chat/fake-agent.js';
import { assignmentScopeKey, createChatBroker, type ChatBroker } from '../chat/broker.js';
import type { ChatEvent, ChatItem, Participants } from '../chat/types.js';
import type { ResolvedAssignment } from '../utils/assignment-resolver.js';

/**
 * Task 3 — routing through the broker, with one scripted fake ACP agent per
 * participant (Decision 7: no subprocess, no adapter cost). What phase 2 could
 * not do at all is here: a message that fans out to two agents, an
 * agent-to-agent hop chain, the bare-acknowledgement stop, the hop budget,
 * cancel-all, per-target crash repair and a fan-out withdraw.
 */

let sandbox: string;
let assignmentDir: string;
let worktree: string;
let broker: ChatBroker;
let clients: AcpClient[];
let frames: Array<{ type: string; payload: unknown }>;
let fakes: Map<string, FakeAgent>;

const ASSIGNMENT_ID = 'c0ffee00-0000-4000-8000-00000000cafe';
const SCOPE_KEY = assignmentScopeKey(ASSIGNMENT_ID);

const assignment = (): ResolvedAssignment => ({
  assignmentDir,
  projectSlug: 'syntaur-meta',
  assignmentSlug: 'chat-demo',
  id: ASSIGNMENT_ID,
  standalone: false,
  workspaceGroup: null,
});

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
const systemTexts = () => (itemsOfType('system') as Array<{ text: string }>).map((i) => i.text);
const prompts = (agentId: string) => fakes.get(agentId)?.prompts ?? [];
const promptText = (p: { prompt: unknown[] }) => (p.prompt[p.prompt.length - 1] as { text: string }).text;

/** Turns that have started and finished, per agent id. */
function turnsOf(agentId: string): Array<{ state: string; trigger?: { kind: string; hop?: number } }> {
  return itemsOfType('turn.status').filter((i) => i.agentId === agentId) as never;
}

async function writeAgent(
  id: string,
  fields: { respondsTo?: string; default?: boolean; description?: string } = {},
): Promise<void> {
  await mkdir(join(sandbox, 'agents'), { recursive: true });
  await writeFile(
    join(sandbox, 'agents', `${id}.md`),
    [
      '---',
      `id: ${id}`,
      `name: ${id[0].toUpperCase()}${id.slice(1)}`,
      'harness: claude',
      `respondsTo: ${fields.respondsTo ?? 'mentions'}`,
      ...(fields.default ? ['default: true'] : []),
      ...(fields.description ? [`description: ${fields.description}`] : []),
      '---',
      `You are the ${id}.`,
    ].join('\n'),
    'utf-8',
  );
}

async function writeParticipantsFile(participants: Participants): Promise<void> {
  await mkdir(join(assignmentDir, 'chat'), { recursive: true });
  await writeFile(
    join(assignmentDir, 'chat', 'participants.json'),
    JSON.stringify(participants, null, 2),
    'utf-8',
  );
}

/**
 * One fake agent per participant, keyed by the agent id the broker hands the
 * client factory. Each session needs its OWN `AgentApp` — one app does not
 * serve two concurrent client connections.
 */
function makeBroker(scripts: Record<string, FakeTurn[]>, opts: { hopBudget?: number } = {}): void {
  fakes = new Map();
  broker = createChatBroker({
    projectsDir: join(sandbox, 'projects'),
    assignmentsDir: join(sandbox, 'assignments'),
    syntaurHome: sandbox,
    // Cloned: the broker broadcasts the live item object, which the normalizer
    // keeps mutating. In the server the WS layer serialises it immediately.
    broadcast: (message) =>
      frames.push({ type: message.type, payload: structuredClone(message.payload) }),
    clientFactory: (input) => {
      const fake = createFakeAgent({
        turns: scripts[input.agentId] ?? [{ steps: [] }],
        sessionIds: [`acp-${input.agentId}`],
      });
      fakes.set(input.agentId, fake);
      const client = connectAcpClient(fake.app, {
        onUpdate: input.onUpdate,
        onPermissionRequest: input.onPermissionRequest,
      });
      clients.push(client);
      return client;
    },
    timeouts: { flushMs: 1, sessionIdleMs: 60_000, shutdownGraceMs: 200 },
    ...(opts.hopBudget === undefined ? {} : { routing: { hopBudget: opts.hopBudget } }),
  });
}

/**
 * A reply that did work and then named someone — the normal hand-off shape. The
 * `id` must be unique per scripted turn: the normalizer coalesces by
 * `messageId` for the life of a session (spike Decision 5), so reusing one
 * would append the second reply to the first turn's bubble.
 */
const worksThenSays = (text: string, id = 'm1'): FakeTurn => ({
  steps: [
    {
      kind: 'update',
      update: toolCall(`tool-${id}`, { title: 'Read a file', kind: 'read', status: 'completed' }),
    },
    { kind: 'update', update: textChunk(text, id) },
  ],
});

/** A reply with no tool activity at all — the bare-acknowledgement shape. */
const justSays = (text: string, id = 'm1'): FakeTurn => ({
  steps: [{ kind: 'update', update: textChunk(text, id) }],
});

async function idleAll(turns: number): Promise<void> {
  await waitUntil(() => {
    const statuses = itemsOfType('turn.status') as Array<{ state: string }>;
    return statuses.length >= turns && statuses.every((s) => s.state === 'ended');
  }, `${turns} turn(s) to finish`);
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-chat-routing-'));
  assignmentDir = join(sandbox, 'projects', 'syntaur-meta', 'assignments', 'chat-demo');
  worktree = join(sandbox, 'worktree');
  await mkdir(assignmentDir, { recursive: true });
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
  await writeAgent('planner', { default: true });
  await writeAgent('implementer');
  await writeParticipantsFile({ agents: ['planner', 'implementer'], defaultAgent: 'planner' });
  clients = [];
  frames = [];
  closeSessionDb();
  closeUsageDb();
  initSessionDb(join(sandbox, 'syntaur.db'));
  initUsageDb(join(sandbox, 'syntaur.db'));
});

afterEach(async () => {
  await broker?.stopAll().catch(() => {});
  for (const client of clients) await client.close().catch(() => {});
  closeSessionDb();
  closeUsageDb();
  await rm(sandbox, { recursive: true, force: true });
});

describe('routing a human message', () => {
  it('prompts both mentioned agents once each from ONE user.message item', async () => {
    makeBroker({ planner: [justSays('planned')], implementer: [justSays('done')] });

    await broker.send({ assignment: assignment(), text: '@planner @implementer go' });
    await idleAll(2);

    expect(prompts('planner')).toHaveLength(1);
    expect(prompts('implementer')).toHaveLength(1);
    // One bubble, not one per target: the message lives in the assignment scope.
    const messages = itemsOfType('user.message');
    expect(messages).toHaveLength(1);
    expect((messages[0] as { targets: string[] }).targets).toEqual(['planner', 'implementer']);
    expect(messages[0].agentId).toBe('human');
  });

  it('routes an unmentioned message to the default agent only', async () => {
    makeBroker({ planner: [justSays('planned')], implementer: [justSays('done')] });

    await broker.send({ assignment: assignment(), text: 'no mentions here' });
    await idleAll(1);
    await new Promise((r) => setTimeout(r, 20));

    expect(prompts('planner')).toHaveLength(1);
    expect(prompts('implementer')).toHaveLength(0);
  });

  it('adds an attached `all-human` agent to an unmentioned message', async () => {
    await writeAgent('chime', { respondsTo: 'all-human' });
    await writeParticipantsFile({
      agents: ['planner', 'implementer', 'chime'],
      defaultAgent: 'planner',
    });
    makeBroker({
      planner: [justSays('planned')],
      implementer: [justSays('done')],
      chime: [justSays('noted')],
    });

    await broker.send({ assignment: assignment(), text: 'no mentions here' });
    await idleAll(2);
    await new Promise((r) => setTimeout(r, 20));

    expect(prompts('planner')).toHaveLength(1);
    expect(prompts('chime')).toHaveLength(1);
    expect(prompts('implementer')).toHaveLength(0);
  });

  it('files a system row for an unknown mention and still prompts the default', async () => {
    makeBroker({ planner: [justSays('planned')] });

    await broker.send({ assignment: assignment(), text: '@reviewer take a look' });
    await idleAll(1);

    expect(prompts('planner')).toHaveLength(1);
    expect(systemTexts().some((t) => t.includes('@reviewer'))).toBe(true);
  });

  it('grows deliveredTo as each target starts, partial then sent', async () => {
    makeBroker({ planner: [justSays('planned')], implementer: [justSays('done')] });

    await broker.send({ assignment: assignment(), text: '@planner @implementer go' });
    await idleAll(2);

    const states = frames
      .filter((f) => f.type === 'chat-item')
      .map((f) => (f.payload as { patch: { item?: ChatItem } }).patch.item)
      .filter((item): item is ChatItem => item?.type === 'user.message')
      .map((item) => (item as { state: string; deliveredTo: string[] }));
    // The item passes through every state on its way, in order.
    expect(states.map((s) => s.state)).toEqual(
      expect.arrayContaining(['queued', 'partial', 'sent']),
    );
    expect(states.findIndex((s) => s.state === 'partial')).toBeLessThan(
      states.findIndex((s) => s.state === 'sent'),
    );
    const final = itemsOfType('user.message')[0] as { state: string; deliveredTo: string[] };
    expect(final.state).toBe('sent');
    expect(final.deliveredTo.sort()).toEqual(['implementer', 'planner']);
  });
});

describe('agent-to-agent hops', () => {
  it('writes a handoff, triggers the target at hop 1, and stops on a bare acknowledgement', async () => {
    makeBroker({
      planner: [worksThenSays('Outlined it. Over to you @implementer', 'p1')],
      implementer: [justSays('ok @planner', 'i1')],
    });

    await broker.send({ assignment: assignment(), text: '@planner outline it' });
    await idleAll(2);
    await new Promise((r) => setTimeout(r, 30));

    const handoffs = itemsOfType('handoff') as Array<{
      fromAgentId: string;
      toAgentId: string;
      hop: number;
      budget: number;
      triggerItemId: string | null;
    }>;
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ fromAgentId: 'planner', toAgentId: 'implementer', hop: 1 });
    expect(handoffs[0].triggerItemId).toBeTruthy();

    // The implementer's turn names the handoff it answers.
    const implementerTurns = turnsOf('implementer');
    expect(implementerTurns).toHaveLength(1);
    expect(implementerTurns[0].trigger).toMatchObject({ kind: 'handoff', hop: 1 });

    // And the hop is in the prompt the implementer actually received.
    expect(promptText(prompts('implementer')[0] as never)).toContain('Hop 1 of');
    expect(promptText(prompts('implementer')[0] as never)).toContain('author="agent:planner"');

    // "ok @planner" with no tool activity ends the chain: no third turn.
    expect(itemsOfType('turn.status')).toHaveLength(2);
    expect(prompts('planner')).toHaveLength(1);
  });

  it('stops a mutual chain at the hop budget with a system row and exactly `budget` hops', async () => {
    await writeParticipantsFile({
      agents: ['planner', 'implementer'],
      defaultAgent: 'planner',
      hopBudget: 2,
    });
    makeBroker({
      planner: [
        worksThenSays('Your turn @implementer', 'p1'),
        worksThenSays('Your turn @implementer', 'p2'),
      ],
      implementer: [worksThenSays('Back to you @planner', 'i1')],
    });

    await broker.send({ assignment: assignment(), text: '@planner start' });
    await waitUntil(
      () => systemTexts().some((t) => t.includes('budget')),
      'the budget-exhausted notice',
    );
    await idleAll(3);
    await new Promise((r) => setTimeout(r, 30));

    const handoffs = itemsOfType('handoff') as Array<{ hop: number }>;
    expect(handoffs.map((h) => h.hop)).toEqual([1, 2]);
    // Three turns ran: the human's, hop 1 and hop 2. The fourth was refused.
    expect(itemsOfType('turn.status')).toHaveLength(3);
    expect(systemTexts().filter((t) => t.includes('budget'))).toHaveLength(1);
  });

  it('never hops from a cancelled turn', async () => {
    makeBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('Over to @implementer', 'm1') }, { kind: 'awaitCancel' }] }],
      implementer: [justSays('done')],
    });

    await broker.send({ assignment: assignment(), text: '@planner start' });
    await waitUntil(() => prompts('planner').length === 1, 'the planner prompt');
    await waitUntil(
      () => (itemsOfType('agent.message') as Array<{ text: string }>).length > 0,
      'the planner reply to stream',
    );
    expect(await broker.cancel(assignment(), 'planner')).toBe(true);
    await idleAll(1);
    await new Promise((r) => setTimeout(r, 40));

    expect(itemsOfType('handoff')).toHaveLength(0);
    expect(prompts('implementer')).toHaveLength(0);
  });
});

describe('one prompt in flight per agent', () => {
  it('queues behind a busy agent while another agent runs concurrently', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    makeBroker({
      planner: [{ steps: [{ kind: 'gate', gate }, { kind: 'update', update: textChunk('first', 'm1') }] }, justSays('second')],
      implementer: [justSays('done')],
    });

    await broker.send({ assignment: assignment(), text: '@planner one' });
    await waitUntil(() => prompts('planner').length === 1, 'the planner prompt');

    await broker.send({ assignment: assignment(), text: '@planner two' });
    await broker.send({ assignment: assignment(), text: '@implementer meanwhile' });
    // The implementer runs while the planner is still busy — the queue is per
    // agent, not per assignment (spike Decision 6).
    await waitUntil(() => prompts('implementer').length === 1, 'the implementer prompt');
    expect(prompts('planner')).toHaveLength(1);

    const planner = await broker.getSession(assignment(), 'planner');
    expect(planner?.queued).toHaveLength(1);
    expect(planner?.queued[0].trigger.kind).toBe('human');

    release();
    await waitUntil(() => prompts('planner').length === 2, 'the queued planner prompt');
    await idleAll(3);
    expect(promptText(prompts('planner')[1] as never)).toContain('two');
  });

  it('cancel with no agent id cancels every in-flight turn', async () => {
    makeBroker({
      planner: [{ steps: [{ kind: 'awaitCancel' }] }],
      implementer: [{ steps: [{ kind: 'awaitCancel' }] }],
    });

    await broker.send({ assignment: assignment(), text: '@planner @implementer go' });
    await waitUntil(
      () => prompts('planner').length === 1 && prompts('implementer').length === 1,
      'both prompts',
    );

    expect(await broker.cancel(assignment())).toBe(true);
    await idleAll(2);

    const stopReasons = (itemsOfType('turn.status') as Array<{ stopReason?: string }>).map(
      (t) => t.stopReason,
    );
    expect(stopReasons).toEqual(['cancelled', 'cancelled']);
  });
});

describe('withdrawing a fan-out message', () => {
  it('removes it from every queue while nothing has started, and refuses once one has', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    makeBroker({
      planner: [{ steps: [{ kind: 'gate', gate }] }, justSays('planner second')],
      implementer: [{ steps: [{ kind: 'gate', gate }] }, justSays('implementer second')],
    });

    const first = await broker.send({ assignment: assignment(), text: '@planner @implementer one' });
    await waitUntil(
      () => prompts('planner').length === 1 && prompts('implementer').length === 1,
      'both first prompts',
    );
    // The first message reached both agents, so it cannot be unsent.
    expect(await broker.withdraw(assignment(), first.messageId)).toBe(false);

    const second = await broker.send({ assignment: assignment(), text: '@planner @implementer two' });
    await waitUntil(
      () =>
        itemsOfType('user.message').some(
          (i) => (i as { messageId: string }).messageId === second.messageId,
        ),
      'the queued fan-out bubble',
    );

    expect(await broker.withdraw(assignment(), second.messageId)).toBe(true);
    expect((await broker.getSession(assignment(), 'planner'))?.queued).toEqual([]);
    expect((await broker.getSession(assignment(), 'implementer'))?.queued).toEqual([]);

    release();
    await idleAll(2);
    await new Promise((r) => setTimeout(r, 30));
    // Neither agent ever saw it.
    expect(prompts('planner')).toHaveLength(1);
    expect(prompts('implementer')).toHaveLength(1);
    const withdrawn = itemsOfType('user.message').find(
      (i) => (i as { messageId: string }).messageId === second.messageId,
    ) as { state: string };
    expect(withdrawn.state).toBe('withdrawn');
  });

  it('refuses a PARTIALLY delivered message and leaves the other queue untouched', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    makeBroker({
      // The planner is busy with an earlier message, so the fan-out queues
      // behind it — while the implementer starts the same message at once.
      planner: [{ steps: [{ kind: 'gate', gate }] }, justSays('planner second', 'p2')],
      implementer: [justSays('implementer first', 'i1')],
    });

    await broker.send({ assignment: assignment(), text: '@planner busy' });
    await waitUntil(() => prompts('planner').length === 1, 'the planner to be busy');

    const fanout = await broker.send({ assignment: assignment(), text: '@planner @implementer two' });
    await waitUntil(() => prompts('implementer').length === 1, 'the implementer to start it');

    const message = itemsOfType('user.message').find(
      (i) => (i as { messageId: string }).messageId === fanout.messageId,
    ) as { state: string; deliveredTo: string[] };
    expect(message.state).toBe('partial');
    expect(message.deliveredTo).toEqual(['implementer']);

    // One target already has it, so it cannot be unsent — not even from the
    // queue of the target that has not started.
    expect(await broker.withdraw(assignment(), fanout.messageId)).toBe(false);
    expect((await broker.getSession(assignment(), 'planner'))?.queued).toHaveLength(1);

    release();
    await idleAll(3);
    expect(prompts('planner')).toHaveLength(2);
  });
});

describe('per-target crash repair (Decision 12 extended)', () => {
  /** Write the log a crashed process would have left, with no live broker. */
  async function seed(lines: Array<Partial<ChatEvent> & Pick<ChatEvent, 'kind' | 'payload'>>): Promise<void> {
    const log = await openChatLog(assignmentDir);
    for (const line of lines) {
      await log.append({
        assignmentId: ASSIGNMENT_ID,
        agentId: line.agentId ?? 'human',
        sessionKey: line.sessionKey ?? SCOPE_KEY,
        turnId: line.turnId ?? null,
        kind: line.kind,
        payload: line.payload,
      });
    }
  }

  it('re-queues only the target whose turn never started', async () => {
    await seed([
      {
        kind: 'user.message',
        payload: {
          messageId: 'm-fanout',
          text: 'two targets',
          state: 'queued',
          mentions: ['planner', 'implementer'],
          targets: ['planner', 'implementer'],
          unknown: [],
        },
      },
      {
        sessionKey: `${ASSIGNMENT_ID}:planner`,
        agentId: 'planner',
        turnId: 'turn-planner',
        kind: 'turn.start',
        payload: { startedAt: '2026-09-02T12:00:00.000Z', trigger: { kind: 'human', messageId: 'm-fanout' } },
      },
      {
        sessionKey: `${ASSIGNMENT_ID}:planner`,
        agentId: 'planner',
        turnId: 'turn-planner',
        kind: 'turn.end',
        payload: { stopReason: 'end_turn', endedAt: '2026-09-02T12:00:05.000Z', durationMs: 5000 },
      },
    ]);
    makeBroker({ planner: [justSays('planned')], implementer: [justSays('done')] });

    // Materialising the sessions is enough — recovery drives itself.
    await broker.getSession(assignment(), 'implementer');
    await waitUntil(() => prompts('implementer').length === 1, 'the recovered implementer prompt');
    expect(promptText(prompts('implementer')[0] as never)).toContain('two targets');

    await broker.getSession(assignment(), 'planner');
    await new Promise((r) => setTimeout(r, 30));
    // The planner already ran it; nothing is re-sent to it.
    expect(prompts('planner')).toHaveLength(0);
  });

  it('re-enqueues a recorded handoff with its original trigger and writes no second handoff', async () => {
    await seed([
      {
        kind: 'user.message',
        payload: {
          messageId: 'm1',
          text: 'start',
          state: 'queued',
          mentions: ['planner'],
          targets: ['planner'],
          unknown: [],
        },
      },
      {
        sessionKey: `${ASSIGNMENT_ID}:planner`,
        agentId: 'planner',
        turnId: 'turn-planner',
        kind: 'turn.start',
        payload: { startedAt: '2026-09-02T12:00:00.000Z', trigger: { kind: 'human', messageId: 'm1' } },
      },
      {
        sessionKey: `${ASSIGNMENT_ID}:planner`,
        agentId: 'planner',
        turnId: 'turn-planner',
        kind: 'turn.end',
        payload: { stopReason: 'end_turn', endedAt: '2026-09-02T12:00:05.000Z', durationMs: 5000 },
      },
      {
        agentId: 'planner',
        kind: 'handoff',
        payload: {
          handoffId: 'h-crashed',
          fromAgentId: 'planner',
          toAgentId: 'implementer',
          triggerItemId: 'turn-planner:1',
          text: 'Over to you @implementer',
          hop: 1,
          budget: 4,
        },
      },
    ]);
    makeBroker({ planner: [justSays('planned')], implementer: [justSays('ok @planner')] });

    await broker.getSession(assignment(), 'implementer');
    await waitUntil(() => prompts('implementer').length === 1, 'the recovered hop');
    await idleAll(1);
    await new Promise((r) => setTimeout(r, 30));

    // The hop keeps its ORIGINAL trigger — routing is never re-run…
    const implementerTurns = turnsOf('implementer');
    expect(implementerTurns[0].trigger).toEqual({
      kind: 'handoff',
      handoffId: 'h-crashed',
      fromAgentId: 'planner',
      hop: 1,
    });
    expect(promptText(prompts('implementer')[0] as never)).toContain('Hop 1 of');
    // …and no second `handoff` is invented for the same hop.
    const handoffEvents = (await events()).filter((e) => e.kind === 'handoff');
    expect(handoffEvents).toHaveLength(1);
  });

  it('does not re-queue a hop the target already started', async () => {
    await seed([
      {
        agentId: 'planner',
        kind: 'handoff',
        payload: {
          handoffId: 'h-done',
          fromAgentId: 'planner',
          toAgentId: 'implementer',
          triggerItemId: null,
          text: 'over to you',
          hop: 1,
          budget: 4,
        },
      },
      {
        sessionKey: `${ASSIGNMENT_ID}:implementer`,
        agentId: 'implementer',
        turnId: 'turn-impl',
        kind: 'turn.start',
        payload: {
          startedAt: '2026-09-02T12:00:00.000Z',
          trigger: { kind: 'handoff', handoffId: 'h-done', fromAgentId: 'planner', hop: 1 },
        },
      },
    ]);
    makeBroker({ implementer: [justSays('done')] });

    await broker.getSession(assignment(), 'implementer');
    await new Promise((r) => setTimeout(r, 40));
    expect(prompts('implementer')).toHaveLength(0);
    // The orphaned turn is still sealed as an error, as in phase 2.
    expect((turnsOf('implementer')[0] as { state: string }).state).toBe('ended');
  });

});

describe('the history delta and its cursor (Task 4)', () => {
  it('quotes what the other agent said, once, and not the agent’s own trigger back', async () => {
    makeBroker({
      planner: [justSays('planner here', 'p1')],
      implementer: [justSays('implementer here', 'i1'), justSays('again', 'i2')],
    });

    await broker.send({ assignment: assignment(), text: '@planner @implementer one' });
    await idleAll(2);
    await broker.send({ assignment: assignment(), text: '@implementer two' });
    await idleAll(3);

    const second = prompts('implementer')[1] as never as { prompt: Array<{ text: string }> };
    const history = second.prompt.map((b) => b.text).find((t) => t.includes('<chat-history>'));
    expect(history).toBeDefined();
    // The planner's sealed reply is new to the implementer…
    expect(history).toContain('planner here');
    // …its own reply is not quoted back to it…
    expect(history).not.toContain('implementer here');
    // …neither is the first message, which was its own turn-1 trigger…
    expect(history).not.toContain('one');
    // …and neither is THIS turn's trigger, which is appended separately.
    expect(history).not.toContain('two');
    expect(promptText(second)).toContain('two');
  });

  it('leaves the cursor where it was after an error turn, so the next turn re-delivers', async () => {
    makeBroker({
      planner: [justSays('planner here', 'p1')],
      implementer: [{ steps: [{ kind: 'error', message: 'adapter blew up' }] }, justSays('recovered', 'i2')],
    });

    await broker.send({ assignment: assignment(), text: '@planner one' });
    await idleAll(1);
    await broker.send({ assignment: assignment(), text: '@implementer two' });
    await idleAll(2);

    expect((await broker.getSession(assignment(), 'implementer'))?.lastDeliveredSeq).toBe(0);

    await broker.send({ assignment: assignment(), text: '@implementer three' });
    await idleAll(3);
    // The planner's reply was never actually delivered, so it is sent again.
    const retry = prompts('implementer')[1] as never as { prompt: Array<{ text: string }> };
    expect(retry.prompt.map((b) => b.text).join('\n')).toContain('planner here');
  });

  it('advances the cursor after a cancelled turn — the agent did see the prompt', async () => {
    makeBroker({
      planner: [justSays('planner here', 'p1')],
      implementer: [{ steps: [{ kind: 'awaitCancel' }] }],
    });

    await broker.send({ assignment: assignment(), text: '@planner one' });
    await idleAll(1);
    await broker.send({ assignment: assignment(), text: '@implementer two' });
    await waitUntil(() => prompts('implementer').length === 1, 'the implementer prompt');
    expect(await broker.cancel(assignment(), 'implementer')).toBe(true);
    await idleAll(2);

    const cursor = (await broker.getSession(assignment(), 'implementer'))?.lastDeliveredSeq ?? 0;
    expect(cursor).toBeGreaterThan(0);
  });

  it('persists the cursor across a broker restart', async () => {
    makeBroker({
      planner: [justSays('planner here', 'p1')],
      implementer: [justSays('implementer here', 'i1')],
    });
    await broker.send({ assignment: assignment(), text: '@planner one' });
    await idleAll(1);
    await broker.send({ assignment: assignment(), text: '@implementer two' });
    await idleAll(2);
    const before = (await broker.getSession(assignment(), 'implementer'))?.lastDeliveredSeq ?? 0;
    expect(before).toBeGreaterThan(0);

    await broker.stopAll();
    makeBroker({ implementer: [justSays('after', 'i2')] });
    expect((await broker.getSession(assignment(), 'implementer'))?.lastDeliveredSeq).toBe(before);
  });

  it('sends the roster and the agent’s own identity in the standing context', async () => {
    makeBroker({ planner: [justSays('planned', 'p1')] });
    await broker.send({ assignment: assignment(), text: '@planner go' });
    await idleAll(1);

    const first = prompts('planner')[0] as never as { prompt: Array<{ text?: string }> };
    const standing = first.prompt.map((b) => b.text ?? '').join('\n');
    expect(standing).toContain('You are @planner (Planner)');
    expect(standing).toContain('Participants:');
    expect(standing).toContain('@implementer — Implementer, claude');
    expect(standing).toContain('Human: the assignment owner');
  });
});
