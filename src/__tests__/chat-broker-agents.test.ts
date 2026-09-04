import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeSessionDb, initSessionDb } from '../dashboard/session-db.js';
import { getHarnessOptions } from '../db/chat-db.js';
import { connectAcpClient, type AcpClient } from '../chat/acp-client.js';
import { createFakeAgent, textChunk, type FakeAgent, type FakeTurn } from '../chat/fake-agent.js';
import { createChatBroker, ChatSendError, type ChatBroker, type ClientFactory } from '../chat/broker.js';
import { HARNESSES } from '../chat/harnesses.js';
import { writeAgentDefinition } from '../chat/agents.js';

let sandbox: string;
let broker: ChatBroker;
let fake: FakeAgent;
let clients: AcpClient[];
let prevHome: string | undefined;

const alwaysInstalled = () => ({ path: '/usr/bin/fake-agent', installHint: null });
const authOk = () => 'logged in';

function makeBroker(
  agentOptions: Parameters<typeof createFakeAgent>[0] = {},
  resolver: () => { path: string | null; installHint: string | null } = alwaysInstalled,
) {
  fake = createFakeAgent({
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'claude-opus-5',
        options: [{ value: 'claude-opus-5', name: 'Opus' }],
      },
    ],
    modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
    turns: [{ steps: [{ kind: 'update', update: textChunk('OK') }], stopReason: 'end_turn' }],
    ...agentOptions,
  });
  const probeChunks: string[] = [];
  const clientFactory: ClientFactory = (input) => {
    const client = connectAcpClient(fake.app, {
      onUpdate: (notification) => {
        input.onUpdate(notification);
        const update = (notification as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } })
          .update;
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          probeChunks.push(update.content.text ?? '');
        }
      },
      onPermissionRequest: input.onPermissionRequest,
      onExtRequest: input.onExtRequest,
      onExtNotification: input.onExtNotification,
    });
    clients.push(client);
    return client;
  };
  broker = createChatBroker({
    projectsDir: join(sandbox, 'projects'),
    assignmentsDir: join(sandbox, 'assignments'),
    syntaurHome: sandbox,
    broadcast: () => {},
    clientFactory,
    commandResolver: resolver,
    authProber: authOk,
    throwawayReplyFallback: () => probeChunks.join('') || fake.chunks.join(''),
    timeouts: { flushMs: 1 },
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-chat-broker-agents-'));
  clients = [];
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = sandbox;
  initSessionDb(join(sandbox, 'syntaur.db'));
});

afterEach(async () => {
  await broker?.stopAll().catch(() => {});
  closeSessionDb();
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(sandbox, { recursive: true, force: true });
});

describe.sequential('throwaway harness refresh and agent test', () => {
  it('refresh persists the fake advertised options', async () => {
    makeBroker();
    const summary = await broker.refreshHarness('claude');
    expect(summary.options?.options.some((o) => o.id === 'model')).toBe(true);
    expect(summary.auth.state).toBe('ok');
    const row = getHarnessOptions('claude');
    expect(row.record?.harness).toBe('claude');
    expect(row.auth.state).toBe('ok');
  });

  it('coalesces two concurrent refreshes into one adapter initialize', async () => {
    makeBroker();
    const [a, b] = await Promise.all([broker.refreshHarness('claude'), broker.refreshHarness('claude')]);
    expect(a.id).toBe('claude');
    expect(b.id).toBe('claude');
    expect(fake.calls.filter((c) => c === 'initialize')).toHaveLength(1);
  });

  it('test returns the fake reply with ok true', async () => {
    makeBroker();
    await writeAgentDefinition(sandbox, {
      id: 'planner',
      name: 'Planner',
      color: 'amber',
      harness: 'claude',
      respondsTo: 'mentions',
      default: false,
      systemPrompt: '',
    });
    const result = await broker.testAgent('planner');
    expect(result.ok).toBe(true);
    expect(result.reply).toBe('OK');
    expect(result.error).toBeNull();
  });

  it('reports initialize failure with the injected auth prober text', async () => {
    makeBroker({ initializeError: 'nope' }, alwaysInstalled);
    await expect(broker.refreshHarness('claude')).rejects.toMatchObject({
      status: 503,
      message: expect.stringMatching(/logged in$/),
    });
    expect(getHarnessOptions('claude').auth).toMatchObject({ state: 'failed', detail: 'logged in' });
  });

  it('times out a hanging turn and cancels the session', async () => {
    makeBroker({ turns: [{ steps: [{ kind: 'hang' }] }] });
    await writeAgentDefinition(sandbox, {
      id: 'planner',
      name: 'Planner',
      color: 'amber',
      harness: 'claude',
      respondsTo: 'mentions',
      default: false,
      systemPrompt: '',
    });
    broker = createChatBroker({
      projectsDir: join(sandbox, 'projects'),
      assignmentsDir: join(sandbox, 'assignments'),
      syntaurHome: sandbox,
      broadcast: () => {},
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
      commandResolver: alwaysInstalled,
      authProber: authOk,
      throwawayTimeoutMs: 200,
      throwawayReplyFallback: () => fake.chunks.join(''),
      timeouts: { flushMs: 1 },
    });
    const result = await broker.testAgent('planner');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
    expect(fake.calls).toContain('session/cancel');
    expect(clients.every((c) => !c.alive())).toBe(true);
  });

  it('surfaces setConfigOption errors in profileErrors while still returning the reply', async () => {
    makeBroker({
      setConfigOptionError: 'bad model',
    });
    await writeAgentDefinition(sandbox, {
      id: 'planner',
      name: 'Planner',
      color: 'amber',
      harness: 'claude',
      model: 'claude-opus-5',
      respondsTo: 'mentions',
      default: false,
      systemPrompt: '',
    });
    const result = await broker.testAgent('planner');
    expect(result.profileErrors.length).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
    expect(result.reply).toBe('OK');
  });

  it('returns 503 with the install hint when the adapter is missing', async () => {
    makeBroker(
      {},
      () => ({ path: null, installHint: HARNESSES.claude.installHint }),
    );
    await expect(broker.refreshHarness('claude')).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining(HARNESSES.claude.installHint),
    });
    expect(fake.calls).not.toContain('initialize');
  });

  it('leaves no events.jsonl under the scratch home', async () => {
    makeBroker();
    await broker.refreshHarness('claude');
    expect(existsSync(join(sandbox, 'projects'))).toBe(false);
  });
});
