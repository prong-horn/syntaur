import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeSessionDb, initSessionDb } from '../dashboard/session-db.js';
import { closeUsageDb, initUsageDb } from '../db/usage-db.js';
import { getChatSession, getChatSessionByKey, getHarnessOptions, setHarnessCommands, upsertChatSession, upsertHarnessOptions } from '../db/chat-db.js';
import { connectAcpClient, type AcpClient } from '../chat/acp-client.js';
import { createFakeAgent, textChunk, toolCall, type FakeAgent, type FakeTurn } from '../chat/fake-agent.js';
import { createChatBroker, ChatSendError, type ChatBroker, type ClientFactory, type BrokerTimeouts } from '../chat/broker.js';
import { HARNESSES } from '../chat/harnesses.js';
import { writeAgentDefinition, AgentWriteError, loadAgentDefinitions } from '../chat/agents.js';
import { participantsPath, writeParticipants } from '../chat/participants.js';
import type { ChatItem, Harness, Participants } from '../chat/types.js';
import type { ChatCommand } from '../chat/commands.js';
import type { ResolvedAssignment } from '../utils/assignment-resolver.js';
import type * as acp from '@agentclientprotocol/sdk';

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
  timeoutOverrides: Partial<BrokerTimeouts> = {},
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
  const clientFactory: ClientFactory = (input) => {
    const client = connectAcpClient(fake.app, {
      onUpdate: input.onUpdate,
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
    timeouts: { flushMs: 1, throwawayCommandsMs: 100, ...timeoutOverrides },
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
      timeouts: { flushMs: 1, throwawayMs: 200 },
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

  it('does not leak probe dirs when the adapter is missing', async () => {
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith('syntaur-chat-probe-'));
    makeBroker({}, () => ({ path: null, installHint: 'install me' }));
    await expect(broker.refreshHarness('claude')).rejects.toMatchObject({ status: 503 });
    const after = (await readdir(tmpdir())).filter((name) => name.startsWith('syntaur-chat-probe-'));
    expect(after.length).toBe(before.length);
  });

  it('leaves no events.jsonl under the scratch home', async () => {
    makeBroker();
    await broker.refreshHarness('claude');
    expect(existsSync(join(sandbox, 'projects'))).toBe(false);
  });

  const probeCommands = [
    { name: 'context', description: 'Show context usage', input: { hint: '[--json]' } },
    { name: 'plan', description: 'Turn plan mode on.', input: null },
  ] as acp.AvailableCommand[];

  const parsedProbeCommands: ChatCommand[] = [
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
  ];

  it('refresh captures advertised commands into the harness record', async () => {
    makeBroker({ availableCommands: probeCommands });
    await broker.refreshHarness('claude');
    expect(getHarnessOptions('claude').record?.commands).toEqual(parsedProbeCommands);
  });

  it('serves harness-cache from the record for a row-less agent', async () => {
    const assignId = 'probe-assign-1';
    const assignDir = join(sandbox, 'assignments', 'probe');
    await mkdir(assignDir, { recursive: true });
    const resolved: ResolvedAssignment = {
      assignmentDir: assignDir,
      projectSlug: 'test',
      assignmentSlug: 'probe',
      id: assignId,
      standalone: false,
      workspaceGroup: null,
    };
    makeBroker({ availableCommands: probeCommands });
    await broker.refreshHarness('claude');
    const summary = await broker.getSession(resolved, 'claude');
    expect(summary?.commandsSource).toBe('harness-cache');
    expect(summary?.commands).toEqual(parsedProbeCommands);
  });

  it('refresh with no advertised commands returns within the bounded wait', async () => {
    makeBroker({}, alwaysInstalled, { throwawayCommandsMs: 100 });
    const started = Date.now();
    await broker.refreshHarness('claude');
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(getHarnessOptions('claude').record?.commands).toBeUndefined();
  });

  it('upsertHarnessOptions preserves commands captured by refresh', async () => {
    makeBroker({ availableCommands: probeCommands });
    await broker.refreshHarness('claude');
    upsertHarnessOptions({
      harness: 'claude',
      adapterVersion: '1.0.0',
      capturedAt: new Date().toISOString(),
      options: [{ id: 'model', name: 'Model', category: null, currentValue: 'x', choices: [] }],
      modes: null,
    });
    expect(getHarnessOptions('claude').record?.commands).toEqual(parsedProbeCommands);
  });

  it('refresh with only an empty advertisement leaves an existing record intact', async () => {
    setHarnessCommands('claude', parsedProbeCommands);
    makeBroker({ availableCommands: [] }, alwaysInstalled, { throwawayCommandsMs: 100 });
    const started = Date.now();
    await broker.refreshHarness('claude');
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(getHarnessOptions('claude').record?.commands).toEqual(parsedProbeCommands);
  });

  it('test captures commands advertised during the prompt', async () => {
    makeBroker({
      turns: [
        {
          steps: [
            {
              kind: 'update',
              update: {
                sessionUpdate: 'available_commands_update',
                availableCommands: probeCommands,
              } as acp.SessionUpdate,
            },
            { kind: 'update', update: textChunk('OK') },
          ],
          stopReason: 'end_turn',
        },
      ],
    });
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
    expect(getHarnessOptions('claude').record?.commands).toEqual(parsedProbeCommands);
  });
});

// --- Task 5: live session bookkeeping ----------------------------------------

const ASSIGNMENT_ID = 'a0a0a0a0-0000-4000-8000-00000000a5e5';

let assignmentDir: string;
let worktree: string;
let frames: Array<{ type: string; payload: unknown }>;
let fakes: Map<string, FakeAgent>;
let spawnHarnesses: Harness[];
let resolvedHarnesses: Harness[];

const assignment = (): ResolvedAssignment => ({
  assignmentDir,
  projectSlug: 'syntaur-meta',
  assignmentSlug: 'chat-demo',
  id: ASSIGNMENT_ID,
  standalone: false,
  workspaceGroup: null,
});

const sessionKey = (agentId: string) => `${ASSIGNMENT_ID}:${agentId}`;

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const items = (): ChatItem[] => broker.items(assignment(), { limit: 500 });
const handoffs = () => items().filter((i) => i.type === 'handoff');
const systemTexts = () =>
  items()
    .filter((i) => i.type === 'system')
    .map((i) => (i as { text: string }).text);

/** A reply that did work and then named someone — the normal hand-off shape. */
const worksThenSays = (text: string, id = 'm1'): FakeTurn => ({
  steps: [
    {
      kind: 'update',
      update: toolCall(`tool-${id}`, { title: 'Read a file', kind: 'read', status: 'completed' }),
    },
    { kind: 'update', update: textChunk(text, id) },
  ],
});

async function writeAssignmentMd(): Promise<void> {
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
}

async function writeParticipantsFile(participants: Participants): Promise<void> {
  await mkdir(join(assignmentDir, 'chat'), { recursive: true });
  await writeFile(participantsPath(assignmentDir), `${JSON.stringify(participants, null, 2)}\n`, 'utf-8');
}

const plannerInput = (overrides: Record<string, unknown> = {}) => ({
  id: 'planner',
  name: 'Planner',
  color: 'amber' as const,
  harness: 'claude' as const,
  model: 'claude-opus-5',
  mode: 'plan' as const,
  respondsTo: 'mentions' as const,
  default: false,
  description: 'Plans things',
  systemPrompt: 'You are the planner.',
  ...overrides,
});

const fakeModes = {
  currentModeId: 'plan',
  availableModes: [
    { id: 'plan', name: 'Plan' },
    { id: 'acceptEdits', name: 'Edits' },
    { id: 'default', name: 'Default' },
  ],
};

const fakeConfigOptions = [
  {
    id: 'model',
    name: 'Model',
    type: 'select' as const,
    currentValue: 'claude-opus-5',
    options: [
      { value: 'claude-opus-5', name: 'Opus' },
      { value: 'claude-sonnet-5', name: 'Sonnet' },
    ],
  },
];

function makeAssignmentBroker(
  scripts: Record<string, FakeTurn[]> = {},
  opts: {
    sessionIds?: Record<string, string[]>;
    loadDefinitions?: (root: string) => ReturnType<typeof loadAgentDefinitions>;
    availableCommands?: Record<string, acp.AvailableCommand[]>;
  } = {},
): void {
  fakes = new Map();
  spawnHarnesses = [];
  resolvedHarnesses = [];
  frames = [];
  broker = createChatBroker({
    projectsDir: join(sandbox, 'projects'),
    assignmentsDir: join(sandbox, 'assignments'),
    syntaurHome: sandbox,
    loadDefinitions: opts.loadDefinitions,
    broadcast: (message) =>
      frames.push({ type: message.type, payload: structuredClone(message.payload) }),
    clientFactory: (input) => {
      spawnHarnesses.push(input.harness.id);
      let fake = fakes.get(input.agentId);
      if (!fake) {
        fake = createFakeAgent({
          turns: scripts[input.agentId] ?? [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
          sessionIds: opts.sessionIds?.[input.agentId] ?? [`acp-${input.agentId}`],
          modes: fakeModes,
          configOptions: fakeConfigOptions,
          availableCommands: opts.availableCommands?.[input.agentId],
          agentCapabilities: { loadSession: true },
        });
        fakes.set(input.agentId, fake);
      }
      const client = connectAcpClient(fake.app, {
        onUpdate: input.onUpdate,
        onPermissionRequest: input.onPermissionRequest,
        onExtRequest: input.onExtRequest,
        onExtNotification: input.onExtNotification,
      });
      clients.push(client);
      return client;
    },
    commandResolver: (spec) => {
      resolvedHarnesses.push(spec.id);
      return alwaysInstalled();
    },
    authProber: authOk,
    timeouts: { flushMs: 1, sessionIdleMs: 60_000, shutdownGraceMs: 300 },
  });
}

async function idleTurns(count = 1): Promise<void> {
  await waitUntil(() => {
    const turns = items().filter((i) => i.type === 'turn.status') as Array<{ state: string }>;
    return turns.length >= count && turns.every((t) => t.state === 'ended');
  }, `${count} turn(s) to finish`);
}

function staleSessionFrames(agentId: string): boolean[] {
  return frames
    .filter((f) => f.type === 'chat-session')
    .map((f) => f.payload as { agentId: string; session: { staleDefinition?: boolean } })
    .filter((p) => p.agentId === agentId)
    .map((p) => Boolean(p.session.staleDefinition));
}

describe.sequential('live session bookkeeping (Task 5)', () => {
  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'syntaur-chat-broker-bookkeeping-'));
    assignmentDir = join(sandbox, 'projects', 'syntaur-meta', 'assignments', 'chat-demo');
    worktree = join(sandbox, 'worktree');
    clients = [];
    frames = [];
    fakes = new Map();
    prevHome = process.env.SYNTAUR_HOME;
    process.env.SYNTAUR_HOME = sandbox;
    closeSessionDb();
    closeUsageDb();
    initSessionDb(join(sandbox, 'syntaur.db'));
    initUsageDb(join(sandbox, 'syntaur.db'));
    await mkdir(assignmentDir, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeAssignmentMd();
    await writeParticipantsFile({ agents: ['planner'], defaultAgent: 'planner' });
  });

  afterEach(async () => {
    if (broker) await broker.stopAll().catch(() => {});
    for (const client of clients) await client.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    closeSessionDb();
    closeUsageDb();
    if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = prevHome;
    await rm(sandbox, { recursive: true, force: true });
  });

  it('save while idle-with-live-client re-attaches and re-applies pins', async () => {
    await writeAgentDefinition(sandbox, plannerInput());
    makeAssignmentBroker({ planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }] });

    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    const before = await broker.getSession(assignment(), 'planner');
    expect(before?.acpSessionId).toBe('acp-planner');
    const clientBefore = clients[0];
    expect(clientBefore.alive()).toBe(true);

    await broker.saveAgent(
      plannerInput({ model: 'claude-sonnet-5', mode: 'edits', description: 'Updated plans' }),
    );
    expect(clientBefore.alive()).toBe(false);

    const fake = fakes.get('planner')!;
    const callsBefore = fake.calls.length;
    await broker.send({ assignment: assignment(), text: '@planner again' });
    await idleTurns(2);

    const tail = fake.calls.slice(callsBefore);
    expect(tail).toContain('session/resume');
    expect(tail).not.toContain('session/new');
    expect(fake.configCalls.some((c) => c.method === 'session/set_config_option' && c.params.value === 'claude-sonnet-5')).toBe(true);
    expect(fake.configCalls.some((c) => c.method === 'session/set_mode' && c.params.modeId === 'acceptEdits')).toBe(true);
    expect(systemTexts().some((t) => t.includes("Applied @planner's updated definition"))).toBe(true);
  });

  it('save while a turn runs marks staleDefinition then re-applies pins after', async () => {
    await writeAgentDefinition(sandbox, plannerInput());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'gate', gate }, { kind: 'update', update: textChunk('OK', 'm1') }] }],
    });

    const sendP = broker.send({ assignment: assignment(), text: '@planner hold' });
    await waitUntil(
      () => fakes.has('planner') && (fakes.get('planner')?.prompts.length ?? 0) === 1,
      'prompt started',
    );
    await broker.saveAgent(plannerInput({ model: 'claude-sonnet-5', mode: 'edits' }));
    expect(staleSessionFrames('planner').some(Boolean)).toBe(true);

    release();
    await sendP;
    await idleTurns(1);

    await broker.send({ assignment: assignment(), text: '@planner after' });
    await idleTurns(2);
    expect(systemTexts().some((t) => t.includes("Applied @planner's updated definition"))).toBe(true);
  });

  it('harness change drops the persisted session row and opens with session/new', async () => {
    await writeAgentDefinition(sandbox, plannerInput());
    makeAssignmentBroker(
      {
        planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
      },
      { sessionIds: { planner: ['acp-planner'] } },
    );

    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    expect(getChatSessionByKey(sessionKey('planner'))?.acp_session_id).toBe('acp-planner');

    const fake = fakes.get('planner')!;
    fake.calls.length = 0;
    fake.configCalls.length = 0;

    await broker.saveAgent(plannerInput({ harness: 'codex' }));
    expect(getChatSessionByKey(sessionKey('planner'))).toBeNull();

    await broker.send({ assignment: assignment(), text: '@planner on codex' });
    await idleTurns(2);
    expect(fake.calls).toContain('session/new');
    expect(fake.calls).not.toContain('session/resume');
    expect(fake.calls).not.toContain('session/load');
    expect(resolvedHarnesses.at(-1)).toBe('codex');
  });

  it('delete an attached agent mid-turn detaches and rewrites participants', async () => {
    await writeAgentDefinition(sandbox, {
      id: 'implementer',
      name: 'Implementer',
      color: 'sky',
      harness: 'claude',
      respondsTo: 'mentions',
      default: false,
      systemPrompt: 'You implement.',
    });
    await writeParticipantsFile({ agents: ['implementer'], defaultAgent: 'implementer' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    makeAssignmentBroker({
      implementer: [{ steps: [{ kind: 'gate', gate }, { kind: 'update', update: textChunk('OK', 'm1') }] }],
    });

    const sendP = broker.send({ assignment: assignment(), text: '@implementer hold' });
    await waitUntil(
      () => fakes.has('implementer') && (fakes.get('implementer')?.prompts.length ?? 0) === 1,
      'prompt started',
    );
    await broker.deleteAgent('implementer');
    release();
    await sendP.catch(() => {});

    const participants = JSON.parse(await readFile(participantsPath(assignmentDir), 'utf-8')) as Participants;
    expect(participants.agents).not.toContain('implementer');
    expect(systemTexts().some((t) => t.includes('@implementer is no longer in this chat'))).toBe(true);
    expect(frames.some((f) => f.type === 'chat-participants')).toBe(true);
  });

  it('delete claude.md override while idle restores builtin without detaching', async () => {
    await writeAgentDefinition(sandbox, {
      id: 'claude',
      name: 'Claude override',
      color: 'violet',
      harness: 'claude',
      respondsTo: 'mentions',
      default: true,
      systemPrompt: 'Override prompt.',
    });
    await writeParticipantsFile({ agents: ['claude'], defaultAgent: 'claude' });
    makeAssignmentBroker(
      { claude: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }] },
      { sessionIds: { claude: ['acp-claude'] } },
    );

    await broker.send({ assignment: assignment(), text: '@claude hello' });
    await idleTurns(1);
    const client = clients[0];
    expect(client.alive()).toBe(true);

    await broker.deleteAgent('claude');
    expect(client.alive()).toBe(false);
    const participants = JSON.parse(await readFile(participantsPath(assignmentDir), 'utf-8')) as Participants;
    expect(participants.agents).toContain('claude');

    const fake = fakes.get('claude')!;
    fake.calls.length = 0;
    await broker.send({ assignment: assignment(), text: '@claude again' });
    await idleTurns(2);
    expect(fake.calls).toContain('session/resume');
    expect(systemTexts().some((t) => t.includes('@claude is back to its built-in definition'))).toBe(true);
  });

  it('delete claude.md cursor override tears down and respawns on builtin harness', async () => {
    await writeAgentDefinition(sandbox, {
      id: 'claude',
      name: 'Claude cursor',
      color: 'violet',
      harness: 'cursor',
      respondsTo: 'mentions',
      default: true,
      systemPrompt: 'Cursor override.',
    });
    await writeParticipantsFile({ agents: ['claude'], defaultAgent: 'claude' });
    makeAssignmentBroker(
      { claude: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }] },
      { sessionIds: { claude: ['acp-claude'] } },
    );

    await broker.send({ assignment: assignment(), text: '@claude hello' });
    await idleTurns(1);
    expect(spawnHarnesses).toContain('cursor');

    await broker.deleteAgent('claude');
    expect(getChatSessionByKey(sessionKey('claude'))).toBeNull();
    expect(systemTexts().some((t) => t.includes('@claude is back to its built-in definition'))).toBe(
      true,
    );

    spawnHarnesses.length = 0;
    await broker.send({ assignment: assignment(), text: '@claude builtin' });
    await idleTurns(2);
    expect(spawnHarnesses[0]).toBe('claude');
    expect(fakes.get('claude')!.calls).toContain('session/new');
  });

  it('drops ghost participant ids lazily with one system row', async () => {
    await writeAgentDefinition(sandbox, plannerInput());
    await writeParticipantsFile({ agents: ['planner', 'ghost'], defaultAgent: 'planner' });
    makeAssignmentBroker();

    const first = await broker.getParticipants(assignment());
    expect(first.participants.agents).toEqual(['planner']);
    expect(systemTexts().filter((t) => t.includes('@ghost is no longer in this chat'))).toHaveLength(1);

    const second = await broker.getParticipants(assignment());
    expect(second.participants.agents).toEqual(['planner']);
    expect(systemTexts().filter((t) => t.includes('@ghost is no longer in this chat'))).toHaveLength(1);
  });

  it('construction race: saveAgent updates the session definition before publish', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ description: 'Before roster' }));
    await writeParticipantsFile({ agents: ['planner', 'codex'], defaultAgent: 'planner' });
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
      codex: [{ steps: [{ kind: 'update', update: textChunk('OK codex', 'c1') }] }],
    });
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    await broker.send({ assignment: assignment(), text: '@codex hello' });
    await idleTurns(2);
    await broker.stopAll();

    let releaseConstructionLoad!: () => void;
    const constructionLoadGate = new Promise<void>((resolve) => {
      releaseConstructionLoad = resolve;
    });
    let gatedOnce = false;
    makeAssignmentBroker(
      {
        planner: [{ steps: [{ kind: 'update', update: textChunk('OK2', 'm2') }] }],
        codex: [{ steps: [{ kind: 'update', update: textChunk('OK codex2', 'c2') }] }],
      },
      {
        loadDefinitions: async (root) => {
          // Gate on entry: getSession → ensureSession → loadDefs() runs in the same
          // tick as getSession; save/delete loader calls are later microtasks.
          if (!gatedOnce) {
            gatedOnce = true;
            const result = await loadAgentDefinitions(root);
            await constructionLoadGate;
            return result;
          }
          return loadAgentDefinitions(root);
        },
      },
    );

    const sessionP = broker.getSession(assignment(), 'codex');
    const saveP = broker.saveAgent(plannerInput({ description: 'After roster' }));
    await saveP;
    releaseConstructionLoad();
    expect(await sessionP).not.toBeNull();

    await broker.send({ assignment: assignment(), text: '@codex roster check' });
    await waitUntil(() => (fakes.get('codex')?.prompts.length ?? 0) >= 1, 'codex prompt');

    const fake = fakes.get('codex')!;
    const promptText = fake.prompts[0]!.prompt
      .map((b) => (b as { text?: string }).text ?? '')
      .join('\n');
    expect(promptText).toContain('After roster');
    expect(promptText).not.toContain('Before roster');
  });

  it('construction race: saveAgent during session build rechecks standing fingerprint', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ description: 'Before roster' }));
    await writeParticipantsFile({ agents: ['planner', 'codex'], defaultAgent: 'planner' });
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
      codex: [{ steps: [{ kind: 'update', update: textChunk('OK codex', 'c1') }] }],
    });
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    await broker.send({ assignment: assignment(), text: '@codex hello' });
    await idleTurns(2);
    expect(getChatSession(ASSIGNMENT_ID, 'planner')?.standing_fingerprint).toBeTruthy();
    expect(getChatSession(ASSIGNMENT_ID, 'codex')?.standing_fingerprint).toBeTruthy();
    await broker.stopAll();

    const standingGate = gateDefinitionsLoad(2);
    makeAssignmentBroker(
      {
        planner: [{ steps: [{ kind: 'update', update: textChunk('OK2', 'm2') }] }],
        codex: [{ steps: [{ kind: 'update', update: textChunk('OK codex2', 'c2') }] }],
      },
      { loadDefinitions: standingGate.loadDefinitions },
    );

    const sessionP = broker.getSession(assignment(), 'codex');
    await standingGate.waitEntered();
    const saveP = broker.saveAgent(plannerInput({ description: 'After roster' }));
    await saveP;
    standingGate.release();
    expect(await sessionP).not.toBeNull();

    await broker.send({ assignment: assignment(), text: '@codex roster check' });
    await waitUntil(() => (fakes.get('codex')?.prompts.length ?? 0) >= 1, 'codex prompt');
    await idleTurns(1);

    const promptText = fakes
      .get('codex')!
      .prompts[0]!.prompt.map((b) => (b as { text?: string }).text ?? '')
      .join('\n');
    expect(promptText).toContain('<context>');
    expect(promptText).toContain('After roster');
    expect(promptText).not.toContain('Before roster');
  });

  it('construction race: setParticipants during session build rechecks standing fingerprint', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ description: 'Plans' }));
    await writeParticipantsFile({ agents: ['planner', 'codex'], defaultAgent: 'planner' });
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
      codex: [{ steps: [{ kind: 'update', update: textChunk('OK codex', 'c1') }] }],
    });
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    await broker.send({ assignment: assignment(), text: '@codex hello' });
    await idleTurns(2);
    expect(getChatSession(ASSIGNMENT_ID, 'planner')?.standing_fingerprint).toBeTruthy();
    expect(getChatSession(ASSIGNMENT_ID, 'codex')?.standing_fingerprint).toBeTruthy();
    await broker.stopAll();

    const standingGate = gateDefinitionsLoad(2);
    makeAssignmentBroker(
      {
        planner: [{ steps: [{ kind: 'update', update: textChunk('OK2', 'm2') }] }],
        codex: [{ steps: [{ kind: 'update', update: textChunk('OK codex2', 'c2') }] }],
      },
      { loadDefinitions: standingGate.loadDefinitions },
    );

    const sessionP = broker.getSession(assignment(), 'codex');
    await standingGate.waitEntered();
    await broker.setParticipants(assignment(), {
      agents: ['planner', 'codex', 'claude'],
      defaultAgent: 'planner',
    });
    standingGate.release();
    expect(await sessionP).not.toBeNull();

    await broker.send({ assignment: assignment(), text: '@codex roster check' });
    await waitUntil(() => (fakes.get('codex')?.prompts.length ?? 0) >= 1, 'codex prompt');
    await idleTurns(1);

    const promptText = fakes
      .get('codex')!
      .prompts[0]!.prompt.map((b) => (b as { text?: string }).text ?? '')
      .join('\n');
    expect(promptText).toContain('<context>');
    expect(rosterAgentLines(promptText)).toHaveLength(3);
    expect(promptText).toContain('@claude');
  });

  it('construction race: detach during session build does not publish or spawn', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ description: 'Plans' }));
    await writeParticipantsFile({ agents: ['planner', 'codex'], defaultAgent: 'planner' });
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
      codex: [{ steps: [{ kind: 'update', update: textChunk('OK codex', 'c1') }] }],
    });
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    await broker.send({ assignment: assignment(), text: '@codex hello' });
    await idleTurns(2);
    await broker.stopAll();

    const standingGate = gateDefinitionsLoad(2);
    makeAssignmentBroker(
      {
        planner: [{ steps: [{ kind: 'update', update: textChunk('OK2', 'm2') }] }],
        codex: [{ steps: [{ kind: 'update', update: textChunk('OK codex2', 'c2') }] }],
      },
      { loadDefinitions: standingGate.loadDefinitions },
    );

    const sessionP = broker.getSession(assignment(), 'codex');
    await standingGate.waitEntered();
    await writeParticipantsFile({ agents: ['planner'], defaultAgent: 'planner' });
    await broker.setParticipants(assignment(), { agents: ['planner'], defaultAgent: 'planner' });
    standingGate.release();
    expect(await sessionP).toBeNull();
    expect(fakes.has('codex')).toBe(false);
    expect(spawnHarnesses).not.toContain('codex');
  });

  it('construction race: detach during send records a notice and does not prompt', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ description: 'Plans' }));
    await writeParticipantsFile({ agents: ['planner', 'codex'], defaultAgent: 'planner' });
    const standingGate = gateDefinitionsLoad(2);
    makeAssignmentBroker(
      {
        planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
        codex: [{ steps: [{ kind: 'update', update: textChunk('OK codex', 'c1') }] }],
      },
      { loadDefinitions: standingGate.loadDefinitions },
    );

    const sendP = broker.send({ assignment: assignment(), text: '@codex hi' });
    await standingGate.waitEntered();
    await writeParticipantsFile({ agents: ['planner'], defaultAgent: 'planner' });
    await broker.setParticipants(assignment(), { agents: ['planner'], defaultAgent: 'planner' });
    standingGate.release();
    const { messageId } = await sendP;

    expect(messageId).toBeTruthy();
    expect(items().some((i) => i.type === 'user.message' && (i as { messageId: string }).messageId === messageId)).toBe(
      true,
    );
    expect(
      systemTexts().some((t) => t.includes('@codex was detached while the message was being routed')),
    ).toBe(true);
    expect(fakes.get('codex')?.prompts.length ?? 0).toBe(0);
  });

  it('records only delivered targets on a skipped human message so recovery does not resurrect it', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ description: 'Plans' }));
    await writeParticipantsFile({ agents: ['planner', 'codex'], defaultAgent: 'planner' });
    const standingGate = gateDefinitionsLoad(2);
    makeAssignmentBroker(
      {
        planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
        codex: [{ steps: [{ kind: 'update', update: textChunk('OK codex', 'c1') }] }],
      },
      { loadDefinitions: standingGate.loadDefinitions },
    );

    const sendP = broker.send({ assignment: assignment(), text: '@codex hi' });
    await standingGate.waitEntered();
    await broker.setParticipants(assignment(), { agents: ['planner'], defaultAgent: 'planner' });
    standingGate.release();
    const { messageId } = await sendP;

    const userMessage = items().find(
      (i) => i.type === 'user.message' && (i as { messageId: string }).messageId === messageId,
    ) as { targets?: string[]; mentions?: string[] } | undefined;
    expect(userMessage?.targets ?? []).not.toContain('codex');
    expect(userMessage?.mentions ?? []).toContain('codex');

    await broker.setParticipants(assignment(), {
      agents: ['planner', 'codex'],
      defaultAgent: 'planner',
    });
    await broker.stopAll();
    clients = [];
    fakes = new Map();

    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm2') }] }],
      codex: [
        { steps: [{ kind: 'update', update: textChunk('OK after reattach', 'c1') }] },
        { steps: [{ kind: 'update', update: textChunk('OK new', 'c2') }] },
      ],
    });

    const promptTexts = () =>
      (fakes.get('codex')?.prompts ?? []).map((p) =>
        p.prompt.map((b) => (b as { text?: string }).text ?? '').join('\n'),
      );

    await broker.send({ assignment: assignment(), text: '@codex hello' });
    await waitUntil(() => (fakes.get('codex')?.prompts.length ?? 0) >= 1, 'codex materialized');
    await idleTurns(1);
    expect(promptTexts().join('\n')).not.toContain('@codex hi');
    expect(promptTexts().join('\n')).toContain('@codex hello');

    await broker.send({ assignment: assignment(), text: '@codex follow up' });
    await waitUntil(() => (fakes.get('codex')?.prompts.length ?? 0) >= 2, 'codex follow-up prompt');
    await idleTurns(1);
    expect(promptTexts().join('\n')).toContain('@codex follow up');
  });

  it('construction race: detach during hand-off construction records a notice and does not prompt', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ description: 'Plans' }));
    await writeParticipantsFile({ agents: ['planner', 'codex'], defaultAgent: 'planner' });
    let armCodexBuild = false;
    let buildSessionLoads = 0;
    const standingGate = gateDefinitionsWhen(({ stack }) => {
      if (!armCodexBuild || !stack.includes('buildSession')) return false;
      buildSessionLoads += 1;
      return buildSessionLoads === 4;
    });
    makeAssignmentBroker(
      {
        planner: [worksThenSays('Outlined. Over to @codex', 'p1')],
        codex: [{ steps: [{ kind: 'update', update: textChunk('OK codex', 'c1') }] }],
      },
      { loadDefinitions: standingGate.loadDefinitions },
    );

    armCodexBuild = true;
    const sendP = broker.send({ assignment: assignment(), text: '@planner outline it' });
    await standingGate.waitEntered();
    await broker.setParticipants(assignment(), { agents: ['planner'], defaultAgent: 'planner' });
    standingGate.release();
    await sendP;
    await waitUntil(
      () =>
        handoffs().length === 0 &&
        (fakes.get('codex')?.prompts.length ?? 0) === 0 &&
        systemTexts().some((t) => t.includes('@codex was detached while the hand-off was being routed')),
      'hand-off construction notice',
    );
  });

  it('detach during hand-off re-validation records a notice and does not prompt', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ description: 'Plans' }));
    await writeParticipantsFile({ agents: ['planner', 'codex'], defaultAgent: 'planner' });
    let detachOnHandoffRoute = false;
    const routeDetachGate = gateDefinitionsWhen(
      ({ stack }) =>
        detachOnHandoffRoute && stack.includes('routeReply') && stack.includes('ensureSession'),
    );
    makeAssignmentBroker(
      {
        planner: [
          { steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] },
          worksThenSays('Outlined. Over to @codex', 'p2'),
        ],
        codex: [{ steps: [{ kind: 'update', update: textChunk('OK codex', 'c1') }] }],
      },
      { loadDefinitions: routeDetachGate.loadDefinitions },
    );

    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    await broker.send({ assignment: assignment(), text: '@codex hello' });
    await waitUntil(() => (fakes.get('codex')?.prompts.length ?? 0) >= 1, 'codex materialized');
    const codexPromptsBefore = fakes.get('codex')?.prompts.length ?? 0;

    detachOnHandoffRoute = true;
    const sendP = broker.send({ assignment: assignment(), text: '@planner outline it' });
    await routeDetachGate.waitEntered();
    await broker.setParticipants(assignment(), { agents: ['planner'], defaultAgent: 'planner' });
    routeDetachGate.release();
    await sendP;
    await waitUntil(
      () =>
        handoffs().length === 0 &&
        (fakes.get('codex')?.prompts.length ?? 0) === codexPromptsBefore &&
        systemTexts().some((t) => t.includes('@codex was detached while the hand-off was being routed')),
      'hand-off re-validation notice',
    );
  });

  it('allows re-creating a deleted agent without restarting the broker', async () => {
    await writeParticipantsFile({ agents: ['planner'], defaultAgent: 'planner' });
    makeAssignmentBroker({
      planner: [
        { steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] },
        { steps: [{ kind: 'update', update: textChunk('OK2', 'm2') }] },
      ],
    });

    await broker.saveAgent(plannerInput({ description: 'First version' }));
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    const fake = fakes.get('planner')!;
    const callsBefore = fake.calls.length;

    await broker.deleteAgent('planner');
    await broker.saveAgent(plannerInput({ description: 'Recreated version' }));
    await writeParticipantsFile({ agents: ['planner'], defaultAgent: 'planner' });

    expect(await broker.getSession(assignment(), 'planner')).not.toBeNull();

    await broker.send({ assignment: assignment(), text: '@planner again' });
    await idleTurns(2);

    const tail = fake.calls.slice(callsBefore);
    expect(tail).toContain('initialize');
    expect(tail).toContain('session/new');
    const { definitions } = await broker.listAgents();
    expect(definitions.find((d) => d.id === 'planner')?.description).toBe('Recreated version');
  });

  it('construction race: deleteAgent aborts session construction', async () => {
    await writeAgentDefinition(sandbox, plannerInput());
    let releaseConstructionLoad!: () => void;
    const constructionLoadGate = new Promise<void>((resolve) => {
      releaseConstructionLoad = resolve;
    });
    let gatedOnce = false;
    makeAssignmentBroker(
      { planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }] },
      {
        loadDefinitions: async (root) => {
          // Gate on entry: getSession → ensureSession → loadDefs() runs in the same
          // tick as getSession; save/delete loader calls are later microtasks.
          if (!gatedOnce) {
            gatedOnce = true;
            const result = await loadAgentDefinitions(root);
            await constructionLoadGate;
            return result;
          }
          return loadAgentDefinitions(root);
        },
      },
    );

    const sessionP = broker.getSession(assignment(), 'planner');
    const deleteP = broker.deleteAgent('planner');
    releaseConstructionLoad();
    expect(await sessionP).toBeNull();
    await deleteP;
    expect(await broker.getSession(assignment(), 'planner')).toBeNull();
  });

  it('construction race: saveAgent harness change opens a fresh adapter session', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ harness: 'claude' }));
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
    });
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    await broker.stopAll();

    let releaseConstructionLoad!: () => void;
    const constructionLoadGate = new Promise<void>((resolve) => {
      releaseConstructionLoad = resolve;
    });
    let gatedOnce = false;
    makeAssignmentBroker(
      { planner: [{ steps: [{ kind: 'update', update: textChunk('OK2', 'm2') }] }] },
      {
        loadDefinitions: async (root) => {
          // Gate on entry: getSession → ensureSession → loadDefs() runs in the same
          // tick as getSession; save/delete loader calls are later microtasks.
          if (!gatedOnce) {
            gatedOnce = true;
            const result = await loadAgentDefinitions(root);
            await constructionLoadGate;
            return result;
          }
          return loadAgentDefinitions(root);
        },
      },
    );

    const sessionP = broker.getSession(assignment(), 'planner');
    const saveP = broker.saveAgent(plannerInput({ harness: 'codex', model: 'claude-opus-5' }));
    await saveP;
    releaseConstructionLoad();
    const summary = await sessionP;
    expect(summary?.harness).toBe('codex');

    await broker.send({ assignment: assignment(), text: '@planner on codex' });
    await idleTurns(2);

    const fake = fakes.get('planner')!;
    expect(fake.calls).toContain('initialize');
    expect(fake.calls).toContain('session/new');
    expect(fake.calls).not.toContain('session/resume');
    expect(fake.calls).not.toContain('session/load');
  });

  it('construction race: same-harness save applies new pins after resume', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ model: 'claude-opus-5' }));
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
    });
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    const acpId = getChatSession(ASSIGNMENT_ID, 'planner')!.acp_session_id;
    expect(acpId).toBeTruthy();
    await broker.stopAll();

    let releaseConstructionLoad!: () => void;
    const constructionLoadGate = new Promise<void>((resolve) => {
      releaseConstructionLoad = resolve;
    });
    let gatedOnce = false;
    makeAssignmentBroker(
      { planner: [{ steps: [{ kind: 'update', update: textChunk('OK2', 'm2') }] }] },
      {
        loadDefinitions: async (root) => {
          if (!gatedOnce) {
            gatedOnce = true;
            const result = await loadAgentDefinitions(root);
            await constructionLoadGate;
            return result;
          }
          return loadAgentDefinitions(root);
        },
      },
    );

    const sessionP = broker.getSession(assignment(), 'planner');
    const saveP = broker.saveAgent(plannerInput({ model: 'claude-sonnet-5' }));
    await saveP;
    releaseConstructionLoad();
    await sessionP;

    await broker.send({ assignment: assignment(), text: '@planner after race' });
    await waitUntil(() => fakes.has('planner'), 'planner adapter');
    await idleTurns(2);

    const fake = fakes.get('planner')!;
    const resumeAt = fake.calls.indexOf('session/resume');
    expect(resumeAt).toBeGreaterThanOrEqual(0);
    expect(
      fake.configCalls.some(
        (c) => c.method === 'session/set_config_option' && c.params.value === 'claude-sonnet-5',
      ),
    ).toBe(true);
    expect(fake.calls.indexOf('session/set_config_option')).toBeGreaterThan(resumeAt);
    expect(getChatSession(ASSIGNMENT_ID, 'planner')?.acp_session_id).toBe(acpId);
    expect(systemTexts().some((t) => t.includes("Applied @planner's updated definition"))).toBe(true);
  });

  it('rejects traversal ids on save, delete, and test', async () => {
    const sentinel = join(sandbox, 'sentinel.txt');
    await writeFile(sentinel, 'keep');
    makeAssignmentBroker();

    await expect(
      broker.saveAgent({
        id: '../x',
        name: 'Bad',
        color: 'amber',
        harness: 'claude',
        respondsTo: 'mentions',
        default: false,
        systemPrompt: '',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(broker.deleteAgent('../x')).rejects.toMatchObject({ status: 400 });
    await expect(broker.testAgent('../x')).rejects.toMatchObject({ status: 400 });
    expect(await readFile(sentinel, 'utf-8')).toBe('keep');
  });

  it('applies saved pins to an unmaterialised session after restart', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ model: 'claude-opus-5' }));
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
    });
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    const acpId = getChatSession(ASSIGNMENT_ID, 'planner')!.acp_session_id;
    expect(acpId).toBeTruthy();

    await broker.stopAll();
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm2') }] }],
    });
    await broker.saveAgent(plannerInput({ model: 'claude-sonnet-5' }));

    await broker.send({ assignment: assignment(), text: '@planner after save' });
    await idleTurns(2);

    const fake = fakes.get('planner')!;
    expect(fake.calls).toContain('session/resume');
    expect(fake.calls).not.toContain('session/new');
    expect(
      fake.configCalls.some(
        (c) => c.method === 'session/set_config_option' && c.params.value === 'claude-sonnet-5',
      ),
    ).toBe(true);
    expect(systemTexts().some((t) => t.includes("Applied @planner's updated definition"))).toBe(true);
    expect(getChatSession(ASSIGNMENT_ID, 'planner')?.acp_session_id).toBe(acpId);
  });

  it('rotates an unmaterialised session when the saved harness changes', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ harness: 'claude', model: 'claude-opus-5' }));
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
    });
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    expect(getChatSession(ASSIGNMENT_ID, 'planner')?.harness).toBe('claude');

    await broker.stopAll();
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm2') }] }],
    });
    await broker.saveAgent(plannerInput({ harness: 'codex', model: 'claude-opus-5' }));

    await broker.send({ assignment: assignment(), text: '@planner new harness' });
    await idleTurns(2);

    const fake = fakes.get('planner')!;
    expect(fake.calls).toContain('initialize');
    expect(fake.calls).toContain('session/new');
    expect(fake.calls).not.toContain('session/resume');
    expect(systemTexts().some((t) => t.includes("@planner's harness changed to codex"))).toBe(true);
  });

  it('harness rotation during build leaves a rebuildable chat index', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ harness: 'claude', model: 'claude-opus-5' }));
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
    });
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    await broker.stopAll();
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK2', 'm2') }] }],
    });
    await broker.saveAgent(plannerInput({ harness: 'codex', model: 'claude-opus-5' }));
    await broker.send({ assignment: assignment(), text: '@planner new harness' });
    await idleTurns(2);
    await broker.stopAll();

    const { listChatItems } = await import('../db/chat-db.js');
    const { rebuildChatIndex } = await import('../chat/store.js');
    const live = listChatItems(ASSIGNMENT_ID, { limit: 500 });
    const result = await rebuildChatIndex(assignmentDir, ASSIGNMENT_ID);
    const rebuilt = listChatItems(ASSIGNMENT_ID, { limit: 500 });
    expect(rebuilt.map((i) => i.itemId).sort()).toEqual(live.map((i) => i.itemId).sort());
    expect(result.items).toBe(live.length);
  });

  it('re-sends standing after restart when a roster description changes', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ description: 'Plans v1' }));
    await writeParticipantsFile({ agents: ['planner', 'codex'], defaultAgent: 'planner' });
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
      codex: [{ steps: [{ kind: 'update', update: textChunk('OK codex', 'c1') }] }],
    });
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    await broker.send({ assignment: assignment(), text: '@codex hello' });
    await idleTurns(2);
    expect(getChatSession(ASSIGNMENT_ID, 'codex')?.standing_fingerprint).toBeTruthy();

    await broker.stopAll();
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm2') }] }],
      codex: [{ steps: [{ kind: 'update', update: textChunk('OK codex2', 'c2') }] }],
    });
    await broker.saveAgent(plannerInput({ description: 'Plans v2' }));

    await broker.send({ assignment: assignment(), text: '@codex roster check' });
    await idleTurns(3);

    const fake = fakes.get('codex')!;
    const promptText = fake.prompts[0]!.prompt
      .map((b) => (b as { text?: string }).text ?? '')
      .join('\n');
    expect(promptText).toContain('Plans v2');
    expect(promptText).not.toContain('Plans v1');
  });

  it('does not commit standing until the prompt succeeds', async () => {
    await writeAgentDefinition(sandbox, plannerInput());
    makeAssignmentBroker({
      planner: [
        { steps: [{ kind: 'error', message: 'standing failed' }] },
        { steps: [{ kind: 'update', update: textChunk('OK', 'm2') }] },
      ],
    });

    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    expect(getChatSession(ASSIGNMENT_ID, 'planner')?.standing_fingerprint).toBeNull();

    await broker.send({ assignment: assignment(), text: '@planner retry' });
    await idleTurns(2);

    const fake = fakes.get('planner')!;
    const retryPrompt = fake.prompts[1]!.prompt
      .map((b) => (b as { text?: string }).text ?? '')
      .join('\n');
    expect(retryPrompt).toContain('<context>');
    expect(getChatSession(ASSIGNMENT_ID, 'planner')?.standing_fingerprint).toBeTruthy();
  });

  it('commits standing fingerprint after a successful first prompt', async () => {
    await writeAgentDefinition(sandbox, plannerInput());
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
    });

    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);

    const fake = fakes.get('planner')!;
    const promptText = fake.prompts[0]!.prompt
      .map((b) => (b as { text?: string }).text ?? '')
      .join('\n');
    expect(promptText).toContain('<context>');
    expect(getChatSession(ASSIGNMENT_ID, 'planner')?.standing_fingerprint).toBeTruthy();
  });

const rosterAgentLines = (text: string): string[] =>
  text.split('\n').filter((line) => /^@\S+ —/.test(line));

/** Hold the Nth `loadDefinitions` call — `buildStanding` loads via `routingContext`. */
function gateDefinitionsLoad(
  nth: number,
): {
  loadDefinitions: (root: string) => ReturnType<typeof loadAgentDefinitions>;
  waitEntered: () => Promise<void>;
  release: () => void;
} {
  let invocations = 0;
  let entered = false;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  return {
    loadDefinitions: async (root) => {
      invocations += 1;
      const n = invocations;
      const result = await loadAgentDefinitions(root);
      if (n === nth) {
        entered = true;
        await gate;
      }
      return result;
    },
    waitEntered: () => waitUntil(() => entered, 'standing snapshot gate'),
    release: () => releaseGate(),
  };
}

/** Arm a gate on the next `loadDefinitions` call matching `when`. */
function gateDefinitionsWhen(
  when: (ctx: { n: number; stack: string }) => boolean,
): {
  loadDefinitions: (root: string) => ReturnType<typeof loadAgentDefinitions>;
  waitEntered: () => Promise<void>;
  release: () => void;
} {
  let invocations = 0;
  let entered = false;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  return {
    loadDefinitions: async (root) => {
      invocations += 1;
      const n = invocations;
      const stack = new Error().stack ?? '';
      const result = await loadAgentDefinitions(root);
      if (!entered && when({ n, stack })) {
        entered = true;
        await gate;
      }
      return result;
    },
    waitEntered: () => waitUntil(() => entered, 'standing snapshot gate'),
    release: () => releaseGate(),
  };
}

const plannerSlashCommands = [
    { name: 'plan', description: 'Turn plan mode on.', input: null },
  ] as acp.AvailableCommand[];

  it('does not commit standing when invalidated during an in-flight normal prompt', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ description: 'Plans v1' }));
    await writeParticipantsFile({ agents: ['planner', 'codex'], defaultAgent: 'planner' });
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
      codex: [
        { steps: [{ kind: 'hang' }] },
        { steps: [{ kind: 'update', update: textChunk('OK codex', 'c2') }] },
      ],
    });
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    await broker.send({ assignment: assignment(), text: '@codex hello' });
    await waitUntil(() => (fakes.get('codex')?.prompts.length ?? 0) >= 1, 'codex standing prompt');
    const fingerprintBefore = getChatSession(ASSIGNMENT_ID, 'codex')?.standing_fingerprint ?? null;

    await broker.saveAgent(plannerInput({ description: 'Plans v2' }));
    expect(await broker.cancel(assignment(), 'codex')).toBe(true);
    await idleTurns(2);

    expect(getChatSession(ASSIGNMENT_ID, 'codex')?.standing_fingerprint).toBe(fingerprintBefore);

    const promptsBefore = fakes.get('codex')!.prompts.length;
    await broker.send({ assignment: assignment(), text: '@codex again' });
    await idleTurns(3);
    const promptText = fakes
      .get('codex')!
      .prompts.slice(promptsBefore)
      .map((p) => p.prompt.map((b) => (b as { text?: string }).text ?? '').join('\n'))
      .join('\n');
    expect(promptText).toContain('<context>');
    expect(promptText).toContain('Plans v2');
    expect(promptText).not.toContain('Plans v1');
  });

  it('does not commit standing when invalidated during slash-command standing ack', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ description: 'Plans v1' }));
    await writeParticipantsFile({ agents: ['planner', 'codex'], defaultAgent: 'planner' });
    makeAssignmentBroker(
      {
        planner: [
          { steps: [{ kind: 'hang' }] },
          { steps: [{ kind: 'update', update: textChunk('cmd', 'c1') }] },
          { steps: [{ kind: 'update', update: textChunk('ack2', 'ack2') }] },
        ],
      },
      { availableCommands: { planner: plannerSlashCommands } },
    );

    const sendP = broker.send({ assignment: assignment(), text: '@planner /plan' });
    await waitUntil(() => (fakes.get('planner')?.prompts.length ?? 0) >= 1, 'standing ack prompt');
    const fingerprintBefore = getChatSession(ASSIGNMENT_ID, 'planner')?.standing_fingerprint ?? null;

    await broker.saveAgent(plannerInput({ description: 'Plans v2' }));
    expect(await broker.cancel(assignment(), 'planner')).toBe(true);
    await sendP;
    await idleTurns(2);

    expect(getChatSession(ASSIGNMENT_ID, 'planner')?.standing_fingerprint).toBe(fingerprintBefore);

    const promptsBefore = fakes.get('planner')!.prompts.length;
    await broker.send({ assignment: assignment(), text: '@planner /plan' });
    await waitUntil(() => fakes.get('planner')!.prompts.length > promptsBefore, 'standing ack retry');
    await idleTurns(2);
    const standingPrompt = fakes
      .get('planner')!
      .prompts.slice(promptsBefore)[0]!.prompt.map((b) => (b as { text?: string }).text ?? '')
      .join('\n');
    expect(standingPrompt).toContain('<context>');
    expect(standingPrompt).toContain('Plans v2');
    expect(standingPrompt).not.toContain('Plans v1');
  });

  it('does not commit standing when save lands during the standing snapshot window', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ description: 'Plans v1' }));
    await writeParticipantsFile({ agents: ['planner', 'codex'], defaultAgent: 'planner' });
    let armStandingGate = false;
    const standingGate = gateDefinitionsWhen(
      ({ stack }) => armStandingGate && stack.includes('buildStanding'),
    );
    makeAssignmentBroker(
      {
        planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
        codex: [
          { steps: [{ kind: 'update', update: textChunk('OK', 'c1') }] },
          { steps: [{ kind: 'update', update: textChunk('OK2', 'c2') }] },
        ],
      },
      { loadDefinitions: standingGate.loadDefinitions },
    );
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);

    armStandingGate = true;
    const sendP = broker.send({ assignment: assignment(), text: '@codex hello' });
    await standingGate.waitEntered();
    const fingerprintBefore = getChatSession(ASSIGNMENT_ID, 'codex')?.standing_fingerprint ?? null;

    await broker.saveAgent(plannerInput({ description: 'Plans v2' }));
    standingGate.release();
    await sendP;
    await idleTurns(2);

    expect(getChatSession(ASSIGNMENT_ID, 'codex')?.standing_fingerprint).toBe(fingerprintBefore);

    const promptsBefore = fakes.get('codex')!.prompts.length;
    await broker.send({ assignment: assignment(), text: '@codex again' });
    await waitUntil(() => fakes.get('codex')!.prompts.length > promptsBefore, 'codex standing retry');
    await idleTurns(1);
    const promptText = fakes
      .get('codex')!
      .prompts.slice(promptsBefore)
      .map((p) => p.prompt.map((b) => (b as { text?: string }).text ?? '').join('\n'))
      .join('\n');
    expect(promptText).toContain('<context>');
    expect(promptText).toContain('Plans v2');
    expect(promptText).not.toContain('Plans v1');
  });

  it('does not commit standing when save lands during slash-command snapshot window', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ description: 'Plans v1' }));
    await writeParticipantsFile({ agents: ['planner', 'codex'], defaultAgent: 'planner' });
    const standingGate = gateDefinitionsLoad(8);
    makeAssignmentBroker(
      {
        planner: [
          { steps: [{ kind: 'update', update: textChunk('ack', 'ack') }] },
          { steps: [{ kind: 'update', update: textChunk('cmd', 'c1') }] },
          { steps: [{ kind: 'update', update: textChunk('ack2', 'ack2') }] },
        ],
      },
      {
        availableCommands: { planner: plannerSlashCommands },
        loadDefinitions: standingGate.loadDefinitions,
      },
    );

    const sendP = broker.send({ assignment: assignment(), text: '@planner /plan' });
    await standingGate.waitEntered();
    const fingerprintBefore = getChatSession(ASSIGNMENT_ID, 'planner')?.standing_fingerprint ?? null;

    await broker.saveAgent(plannerInput({ description: 'Plans v2' }));
    standingGate.release();
    await sendP;
    await idleTurns(2);

    expect(getChatSession(ASSIGNMENT_ID, 'planner')?.standing_fingerprint).toBe(fingerprintBefore);

    const promptsBefore = fakes.get('planner')!.prompts.length;
    await broker.send({ assignment: assignment(), text: '@planner /plan' });
    await waitUntil(() => fakes.get('planner')!.prompts.length > promptsBefore, 'standing ack retry');
    await idleTurns(2);
    const standingPrompt = fakes
      .get('planner')!
      .prompts.slice(promptsBefore)[0]!.prompt.map((b) => (b as { text?: string }).text ?? '')
      .join('\n');
    expect(standingPrompt).toContain('<context>');
    expect(standingPrompt).toContain('Plans v2');
    expect(standingPrompt).not.toContain('Plans v1');
  });

  it('re-sends standing when a participant is attached', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ description: 'Plans' }));
    await writeParticipantsFile({ agents: ['planner', 'codex'], defaultAgent: 'planner' });
    makeAssignmentBroker({
      planner: [
        { steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] },
        { steps: [{ kind: 'update', update: textChunk('OK2', 'm2') }] },
      ],
      codex: [
        { steps: [{ kind: 'update', update: textChunk('OK codex', 'c1') }] },
        { steps: [{ kind: 'update', update: textChunk('OK codex2', 'c2') }] },
      ],
    });
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    await broker.send({ assignment: assignment(), text: '@codex hello' });
    await idleTurns(2);
    expect(getChatSession(ASSIGNMENT_ID, 'planner')?.standing_fingerprint).toBeTruthy();
    expect(getChatSession(ASSIGNMENT_ID, 'codex')?.standing_fingerprint).toBeTruthy();

    const plannerPromptsBefore = fakes.get('planner')!.prompts.length;
    const codexPromptsBefore = fakes.get('codex')!.prompts.length;
    await broker.setParticipants(assignment(), {
      agents: ['planner', 'codex', 'claude'],
      defaultAgent: 'planner',
    });

    await broker.send({ assignment: assignment(), text: '@planner after attach' });
    await broker.send({ assignment: assignment(), text: '@codex after attach' });
    await idleTurns(4);

    const plannerStanding = fakes
      .get('planner')!
      .prompts.slice(plannerPromptsBefore)[0]!.prompt.map((b) => (b as { text?: string }).text ?? '')
      .join('\n');
    const codexStanding = fakes
      .get('codex')!
      .prompts.slice(codexPromptsBefore)[0]!.prompt.map((b) => (b as { text?: string }).text ?? '')
      .join('\n');
    expect(rosterAgentLines(plannerStanding)).toHaveLength(3);
    expect(rosterAgentLines(codexStanding)).toHaveLength(3);
    expect(plannerStanding).toContain('@claude');
    expect(codexStanding).toContain('@claude');
  });

  it('re-sends standing when a participant is detached', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ description: 'Plans' }));
    await writeParticipantsFile({ agents: ['planner', 'codex', 'claude'], defaultAgent: 'planner' });
    makeAssignmentBroker({
      planner: [
        { steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] },
        { steps: [{ kind: 'update', update: textChunk('OK2', 'm2') }] },
      ],
      codex: [{ steps: [{ kind: 'update', update: textChunk('OK codex', 'c1') }] }],
      claude: [{ steps: [{ kind: 'update', update: textChunk('OK claude', 'c1') }] }],
    });
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    await broker.send({ assignment: assignment(), text: '@codex hello' });
    await broker.send({ assignment: assignment(), text: '@claude hello' });
    await idleTurns(3);

    const promptsBefore = fakes.get('planner')!.prompts.length;
    await broker.setParticipants(assignment(), { agents: ['planner', 'claude'], defaultAgent: 'planner' });

    await broker.send({ assignment: assignment(), text: '@planner after detach' });
    await waitUntil(() => fakes.get('planner')!.prompts.length > promptsBefore, 'planner standing retry');
    await idleTurns(1);
    const standingPrompt = fakes
      .get('planner')!
      .prompts.slice(promptsBefore)[0]!.prompt.map((b) => (b as { text?: string }).text ?? '')
      .join('\n');
    expect(standingPrompt).toContain('<context>');
    expect(rosterAgentLines(standingPrompt)).toHaveLength(2);
    expect(standingPrompt).not.toContain('@codex');
  });

  it('does not commit standing when setParticipants lands during the standing snapshot window', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ description: 'Plans' }));
    await writeParticipantsFile({ agents: ['planner', 'codex'], defaultAgent: 'planner' });
    let armStandingGate = false;
    const standingGate = gateDefinitionsWhen(
      ({ stack }) => armStandingGate && stack.includes('buildStanding'),
    );
    makeAssignmentBroker(
      {
        planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
        codex: [
          { steps: [{ kind: 'update', update: textChunk('OK', 'c1') }] },
          { steps: [{ kind: 'update', update: textChunk('OK2', 'c2') }] },
        ],
      },
      { loadDefinitions: standingGate.loadDefinitions },
    );
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);

    armStandingGate = true;
    const sendP = broker.send({ assignment: assignment(), text: '@codex hello' });
    await standingGate.waitEntered();
    const fingerprintBefore = getChatSession(ASSIGNMENT_ID, 'codex')?.standing_fingerprint ?? null;

    await broker.setParticipants(assignment(), {
      agents: ['planner', 'codex', 'claude'],
      defaultAgent: 'planner',
    });
    standingGate.release();
    await sendP;
    await idleTurns(2);

    expect(getChatSession(ASSIGNMENT_ID, 'codex')?.standing_fingerprint).toBe(fingerprintBefore);

    const promptsBefore = fakes.get('codex')!.prompts.length;
    await broker.send({ assignment: assignment(), text: '@codex after attach' });
    await waitUntil(() => fakes.get('codex')!.prompts.length > promptsBefore, 'codex standing retry');
    await idleTurns(1);
    const promptText = fakes
      .get('codex')!
      .prompts.slice(promptsBefore)
      .map((p) => p.prompt.map((b) => (b as { text?: string }).text ?? '').join('\n'))
      .join('\n');
    expect(promptText).toContain('<context>');
    expect(rosterAgentLines(promptText)).toHaveLength(3);
    expect(promptText).toContain('@claude');
  });

  it('re-sends standing when a roster model changes', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ model: 'claude-opus-5', description: 'Plans' }));
    await writeParticipantsFile({ agents: ['planner', 'codex'], defaultAgent: 'planner' });
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
      codex: [{ steps: [{ kind: 'update', update: textChunk('OK codex', 'c1') }] }],
    });
    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    await broker.send({ assignment: assignment(), text: '@codex hello' });
    await idleTurns(2);
    const codexFake = fakes.get('codex')!;
    const promptsBefore = codexFake.prompts.length;

    await broker.saveAgent(plannerInput({ model: 'claude-sonnet-5', description: 'Plans' }));

    await broker.send({ assignment: assignment(), text: '@codex roster check' });
    await idleTurns(3);

    const promptText = codexFake.prompts
      .slice(promptsBefore)
      .map((p) => p.prompt.map((b) => (b as { text?: string }).text ?? '').join('\n'))
      .join('\n');
    expect(promptText).toContain('<context>');
    expect(promptText).toContain('@planner — Planner, claude, claude-sonnet-5, Plans');
    expect(promptText).not.toContain('claude-opus-5');
  });

  it('drops orphaned chat_sessions rows when deleting an agent', async () => {
    await writeAgentDefinition(sandbox, plannerInput());
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
    });

    upsertChatSession({
      sessionKey: sessionKey('planner'),
      assignmentId: ASSIGNMENT_ID,
      projectSlug: 'syntaur-meta',
      assignmentSlug: 'chat-demo',
      agentId: 'planner',
      harness: 'claude',
      acpSessionId: 'stale-acp-id',
      state: 'idle',
    });
    expect(getChatSession(ASSIGNMENT_ID, 'planner')).not.toBeNull();

    await broker.deleteAgent('planner');
    expect(getChatSession(ASSIGNMENT_ID, 'planner')).toBeNull();

    await broker.saveAgent(plannerInput({ description: 'Fresh row' }));
    await writeParticipantsFile({ agents: ['planner'], defaultAgent: 'planner' });
    expect(getChatSession(ASSIGNMENT_ID, 'planner')).toBeNull();

    await broker.send({ assignment: assignment(), text: '@planner after stale row' });
    await idleTurns(1);

    const fake = fakes.get('planner')!;
    expect(fake.calls).toContain('session/new');
    expect(fake.calls).not.toContain('session/resume');
    expect(fake.calls).not.toContain('session/load');
  });

  it('construction race: deleteAgent rejects send with 404 and leaves no session', async () => {
    await writeAgentDefinition(sandbox, plannerInput());
    makeAssignmentBroker({
      planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }],
    });

    const sendP = broker.send({ assignment: assignment(), text: '@planner delete race' });
    const deleteP = broker.deleteAgent('planner');
    await expect(sendP).rejects.toBeInstanceOf(ChatSendError);
    await deleteP;
    expect(await broker.getSession(assignment(), 'planner')).toBeNull();
  });

  it('write chain survives a rejected save then valid save and delete', async () => {
    await writeAgentDefinition(sandbox, plannerInput());
    makeAssignmentBroker();

    await expect(broker.saveAgent(plannerInput({ color: 'purple' as never }))).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentWriteError && err.status === 400 && !err.message.includes('/'),
    );
    await broker.saveAgent(plannerInput({ description: 'Recovered' }));
    await broker.deleteAgent('planner');
    const { definitions } = await broker.listAgents();
    expect(definitions.some((d) => d.id === 'planner')).toBe(false);
  });

  it('ensureAdapter picks up a hand-edited permissions change and auto-answers', async () => {
    await writeAgentDefinition(sandbox, plannerInput());
    await writeParticipantsFile({ agents: ['planner'], defaultAgent: 'planner' });
    makeAssignmentBroker(
      {
        planner: [
          { steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] },
          {
            steps: [
              {
                kind: 'permission',
                request: {
                  toolCall: { toolCallId: 't1', title: 'Run cmd', kind: 'execute' },
                  options: [
                    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
                  ],
                },
              },
              { kind: 'update', update: textChunk('done', 'm2') },
            ],
          },
        ],
      },
      { sessionIds: { planner: ['acp-planner'] } },
    );

    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);

    const agentPath = join(sandbox, 'agents', 'planner.md');
    const content = await readFile(agentPath, 'utf-8');
    await writeFile(agentPath, content.replace(/^mode:/m, 'permissions: auto\nmode:'));

    await broker.send({ assignment: assignment(), text: '@planner run' });
    await idleTurns(2);

    const fake = fakes.get('planner')!;
    expect(fake.prompts.length).toBe(2);
    expect(fake.permissionAnswers[0]).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
  });

  it('ensureAdapter respawns when a hand-edited harness change is detected', async () => {
    await writeAgentDefinition(sandbox, plannerInput({ harness: 'claude' }));
    await writeParticipantsFile({ agents: ['planner'], defaultAgent: 'planner' });
    makeAssignmentBroker(
      { planner: [{ steps: [{ kind: 'update', update: textChunk('OK', 'm1') }] }] },
      { sessionIds: { planner: ['acp-planner'] } },
    );

    await broker.send({ assignment: assignment(), text: '@planner hello' });
    await idleTurns(1);
    const fake = fakes.get('planner')!;
    fake.calls.length = 0;

    const agentPath = join(sandbox, 'agents', 'planner.md');
    const content = await readFile(agentPath, 'utf-8');
    await writeFile(agentPath, content.replace(/^harness: claude/m, 'harness: codex'));

    await broker.send({ assignment: assignment(), text: '@planner on codex' });
    await idleTurns(2);

    expect(fake.calls).toContain('initialize');
    expect(fake.calls).toContain('session/new');
    expect(fake.calls).not.toContain('session/resume');
    const summary = await broker.getSession(assignment(), 'planner');
    expect(summary?.harness).toBe('codex');
  });
});
