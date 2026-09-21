import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { closeSessionDb, initSessionDb, resetSessionDb } from '../dashboard/session-db.js';
import { closeEventsDb, initEventsDb, resetEventsDb } from '../db/events-db.js';
import { closeUsageDb, initUsageDb } from '../db/usage-db.js';
import { connectAcpClient, type AcpClient } from '../chat/acp-client.js';
import {
  createFakeAgent,
  textChunk,
  type FakeAgent,
  type FakeTurn,
} from '../chat/fake-agent.js';
import { createChatBroker, type ChatBroker, type ClientFactory } from '../chat/broker.js';
import { readEvents, rebuildChatIndex, replayItems } from '../chat/store.js';
import { ChatNormalizer } from '../chat/normalizer.js';
import {
  findStageDispatchAcceptance,
  policyDigest,
  computePolicyDigest,
  resolveStageDispatchTarget,
  StageDispatchError as StagePolicyError,
} from '../chat/stage-dispatch-broker.js';
import { readStageDispatchReceipt } from '../chat/stage-dispatch-state.js';
import { loadTemplate } from '../ticket-templates/registry.js';
import { resolveStageDispatch } from '../ticket-templates/stage-dispatch.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import {
  buildManualFallbackEntryId,
  recordStageEntryLocked,
} from '../lifecycle/stage-entry.js';
import type { ChatEvent, ChatItem } from '../chat/types.js';
import type { ResolvedTicket } from '../utils/ticket-resolver.js';
import { ticketScopeKey } from '../chat/broker.js';
import { withTicketMutationLock } from '../utils/ticket-mutation-lock.js';
import type { CommandResolution } from '../chat/harnesses.js';
import type { HarnessSpec } from '../chat/types.js';

/** The fakes are in-process; the adapter binary need not be on PATH (CI runners have none). */
const onPath = (spec: HarnessSpec): CommandResolution => ({ path: `/fake/bin/${spec.command}`, installHint: null });

let sandbox: string;
let ticketDir: string;
let worktree: string;
let broker: ChatBroker;
let fake: FakeAgent;
let clients: AcpClient[];
let frames: Array<{ type: string; payload: unknown }>;

const TICKET_ID = 'SD-1';

const ticket = (): ResolvedTicket => ({
  ticketDir,
  projectSlug: 'demo',
  ticketSlug: 'stage-dispatch',
  id: TICKET_ID,
  standalone: false,
});

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function writeTicket(status = 'in_progress'): Promise<void> {
  await mkdir(join(ticketDir, 'chat'), { recursive: true });
  await writeFile(
    join(ticketDir, 'ticket.md'),
    [
      '---',
      `id: ${TICKET_ID}`,
      'slug: stage-dispatch',
      'title: "Stage dispatch"',
      'template: feature',
      `status: ${status}`,
      'project: demo',
      'depends_on: []',
      'links: []',
      'plan:',
      '  file: null',
      '  approvedDigest: null',
      '  approvedAt: null',
      '  approvedBy: null',
      'workspace:',
      `  repository: ${worktree}`,
      `  worktree: ${worktree}`,
      '  branch: feat/stage',
      '  parentBranch: main',
      '---',
      '# Stage dispatch test',
    ].join('\n'),
  );
}

function promptTexts(agent: FakeAgent): string[] {
  return agent.prompts.map((p) =>
    p.prompt.map((b) => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('\n'),
  );
}

async function recordEntryAsync(stage: string) {
  const manifest = await loadTemplate(sandbox, 'feature');
  return recordStageEntryLocked({
    ticketId: TICKET_ID,
    projectSlug: 'demo',
    actor: 'human',
    at: new Date().toISOString(),
    eventType: 'moved',
    stage,
    manifest,
    from: 'backlog',
    verb: 'start',
  });
}

function makeBroker(
  turns: FakeTurn[] = [{ steps: [{ kind: 'update', update: textChunk('done', 'm1') }] }],
  extra: Partial<Parameters<typeof createChatBroker>[0]> = {},
  agentOptions: Parameters<typeof createFakeAgent>[0] = {},
) {
  fake = createFakeAgent({ turns, ...agentOptions });
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
    commandResolver: onPath,
    projectsDir: join(sandbox, 'projects'),
    syntaurHome: sandbox,
    broadcast: (message) => frames.push({ type: message.type, payload: message.payload }),
    clientFactory,
    timeouts: {
      flushMs: 1,
      permissionMs: 200,
      sessionIdleMs: 5000,
      shutdownGraceMs: 200,
      inboxGraceMs: 60_000,
      turnIdleMs: 60_000,
      turnMaxMs: 120_000,
    },
    ...extra,
  });
  return broker;
}

async function events(): Promise<ChatEvent[]> {
  return readEvents(join(ticketDir, 'chat', 'events.jsonl'));
}

function normalizeLive(eventsList: ChatEvent[]): ChatItem[] {
  const normalizer = new ChatNormalizer({
    ticketId: TICKET_ID,
    agentId: 'system',
    sessionKey: ticketScopeKey(TICKET_ID),
  });
  const items = new Map<string, ChatItem>();
  for (const event of eventsList) {
    if (event.sessionKey !== ticketScopeKey(TICKET_ID)) continue;
    for (const patch of normalizer.ingest(event)) {
      if (patch.op === 'retract') items.delete(patch.itemId);
      else items.set(patch.item.itemId, patch.item);
    }
  }
  return [...items.values()];
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'chat-stage-'));
  worktree = join(sandbox, 'worktree');
  ticketDir = join(sandbox, 'projects', 'demo', 'stage-dispatch');
  await mkdir(worktree, { recursive: true });
  await mkdir(ticketDir, { recursive: true });
  process.env.SYNTAUR_HOME = sandbox;
  await writeFile(
    resolve(sandbox, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${join(sandbox, 'projects')}\n---\n`,
  );
  await seedMissingBuiltins(sandbox);
  resetEventsDb();
  initEventsDb(join(sandbox, 'events.db'));
  resetSessionDb();
  initSessionDb(join(sandbox, 'syntaur.db'));
  initUsageDb(join(sandbox, 'syntaur.db'));
  clients = [];
  frames = [];
  await writeTicket();
});

afterEach(async () => {
  await broker?.stopAll().catch(() => {});
  closeUsageDb();
  closeSessionDb();
  resetSessionDb();
  closeEventsDb();
  resetEventsDb();
  delete process.env.SYNTAUR_HOME;
  await rm(sandbox, { recursive: true, force: true });
});

describe('stage dispatch receipt reader', () => {
  it('derives queued then completed from events', () => {
    const eventsList: ChatEvent[] = [
      {
        seq: 1,
        ts: 't1',
        ticketId: TICKET_ID,
        agentId: 'system',
        sessionKey: ticketScopeKey(TICKET_ID),
        turnId: null,
        kind: 'stage.dispatch',
        payload: {
          requestId: 'auto~entry-1',
          entryId: 'entry-1',
          agentId: 'cursor',
          stage: 'in_progress',
          role: 'agent',
          source: 'automatic',
          policyDigest: 'abc',
          state: 'queued',
        },
      },
      {
        seq: 2,
        ts: 't2',
        ticketId: TICKET_ID,
        agentId: 'cursor',
        sessionKey: `${TICKET_ID}~cursor`,
        turnId: 'turn-1',
        kind: 'turn.start',
        payload: { trigger: { kind: 'stage', requestId: 'auto~entry-1' }, startedAt: 't2' },
      },
      {
        seq: 3,
        ts: 't3',
        ticketId: TICKET_ID,
        agentId: 'cursor',
        sessionKey: `${TICKET_ID}~cursor`,
        turnId: 'turn-1',
        kind: 'turn.end',
        payload: { stopReason: 'end_turn', endedAt: 't3', durationMs: 1 },
      },
    ];
    const receipt = readStageDispatchReceipt(eventsList, 'auto~entry-1');
    expect(receipt?.state).toBe('completed');
  });
});

describe('stage dispatch broker integration', () => {
  it('accepts dispatch durably and dedups identical requestId', async () => {
    const entry = await recordEntryAsync('in_progress');
    makeBroker();
    const requestId = `auto~${entry.entryId}`;
    const first = await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId,
      source: 'automatic',
    });
    const second = await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId,
      source: 'automatic',
    });
    expect(first).toEqual(second);
    const log = await events();
    expect(log.filter((e) => e.kind === 'stage.dispatch')).toHaveLength(1);
    expect(findStageDispatchAcceptance(log, requestId)?.agentId).toBe('cursor');
  });

  it('rejects conflicting requestId reuse with 409', async () => {
    const entry = await recordEntryAsync('in_progress');
    makeBroker();
    const requestId = randomUUID();
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId,
      source: 'manual',
      agentId: 'cursor',
    });
    await expect(
      broker.dispatchStage({
        ticket: ticket(),
        entryId: entry.entryId,
        requestId,
        source: 'manual',
        agentId: 'codex',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses dispatch when runtimeIdentity reports unavailable', async () => {
    const entry = await recordEntryAsync('in_progress');
    makeBroker(undefined, { runtimeIdentity: () => null });
    await expect(
      broker.dispatchStage({
        ticket: ticket(),
        entryId: entry.entryId,
        requestId: `auto~${entry.entryId}`,
        source: 'automatic',
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('auto-attaches exact target participant', async () => {
    const entry = await recordEntryAsync('in_progress');
    makeBroker();
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId: `auto~${entry.entryId}`,
      source: 'automatic',
    });
    const { participants } = await broker.getParticipants(ticket());
    expect(participants.agents).toContain('cursor');
  });

  it('supersedes queued work for stale entry via notifyStageEntry', async () => {
    const oldEntry = await recordEntryAsync('in_progress');
    makeBroker([{ steps: [{ kind: 'hang' }] }]);
    const oldRequest = `auto~${oldEntry.entryId}`;
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: oldEntry.entryId,
      requestId: oldRequest,
      source: 'automatic',
    });

    const manifest = await loadTemplate(sandbox, 'feature');
    const newEntry = recordStageEntryLocked({
      ticketId: TICKET_ID,
      projectSlug: 'demo',
      actor: 'human',
      at: new Date().toISOString(),
      eventType: 'moved',
      stage: 'in_progress',
      manifest,
      from: 'in_progress',
      verb: 'reopen',
    });

    await broker.notifyStageEntry(ticket());
    const receipt = await broker.getStageDispatch(ticket(), oldRequest);
    expect(receipt?.state).toBe('superseded');
    expect(newEntry.entryId).not.toBe(oldEntry.entryId);
  });

  it('runs one stage turn through fake ACP with fresh show in prompt', async () => {
    const entry = await recordEntryAsync('in_progress');
    makeBroker([
      {
        steps: [{ kind: 'update', update: textChunk('stage ok', 'm1') }],
      },
    ]);
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId: `auto~${entry.entryId}`,
      source: 'automatic',
    });
    await waitUntil(async () => {
      const receipt = await broker.getStageDispatch(ticket(), `auto~${entry.entryId}`);
      return receipt?.state === 'completed';
    }, 'stage turn completion');
    expect(promptTexts(fake).length).toBeGreaterThan(0);
    const promptText = promptTexts(fake)[0];
    expect(promptText).toContain('Stage dispatch');
    expect(promptText.toLowerCase()).toMatch(/in_progress|@cursor/);
  });

  it('does not route reply hops after a stage turn', async () => {
    const entry = await recordEntryAsync('in_progress');
    makeBroker([
      {
        steps: [{ kind: 'update', update: textChunk('@codex please take over', 'm1') }],
      },
    ]);
    await writeFile(
      join(ticketDir, 'chat', 'participants.json'),
      JSON.stringify({ agents: ['cursor', 'codex'], defaultAgent: 'cursor' }, null, 2),
    );
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId: `auto~${entry.entryId}`,
      source: 'automatic',
    });
    await waitUntil(async () => {
      const receipt = await broker.getStageDispatch(ticket(), `auto~${entry.entryId}`);
      return receipt?.state === 'completed';
    }, 'stage completion');
    const log = await events();
    expect(log.some((e) => e.kind === 'handoff')).toBe(false);
  });

  it('queues stage work FIFO behind an in-flight ordinary turn', async () => {
    const entry = await recordEntryAsync('in_progress');
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    makeBroker([
      {
        steps: [
          { kind: 'gate', gate },
          { kind: 'update', update: textChunk('first done', 'm1') },
        ],
      },
      { steps: [{ kind: 'update', update: textChunk('stage second', 'm2') }] },
    ]);
    void broker.send({ ticket: ticket(), text: 'hold the session', agentId: 'cursor' });
    await waitUntil(() => clients.length > 0, 'session created', 5000);
    await waitUntil(async () => (await broker.getSession(ticket(), 'cursor'))?.state === 'running', 'running turn', 5000);
    await waitUntil(() => promptTexts(fake).length >= 1, 'first prompt started', 5000);
    const promptsBeforeStage = promptTexts(fake).length;
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId: `auto~${entry.entryId}`,
      source: 'automatic',
    });
    expect(promptTexts(fake).length).toBe(promptsBeforeStage);
    releaseFirst();
    await waitUntil(async () => {
      const receipt = await broker.getStageDispatch(ticket(), `auto~${entry.entryId}`);
      return receipt?.state === 'completed';
    }, 'stage after busy');
    expect(promptTexts(fake).length).toBeGreaterThanOrEqual(2);
  });

  it('cancels queued then running stage dispatch', async () => {
    const entry = await recordEntryAsync('in_progress');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    makeBroker([
      {
        steps: [{ kind: 'gate', gate }, { kind: 'update', update: textChunk('late', 'm1') }],
      },
    ]);
    const requestId = `auto~${entry.entryId}`;
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId,
      source: 'automatic',
    });
    expect(await broker.cancelStageDispatch(ticket(), requestId)).toBe(true);
    let receipt = await broker.getStageDispatch(ticket(), requestId);
    expect(receipt?.state).toBe('cancelled');

    const entry2 = await recordEntryAsync('in_progress');
    const requestId2 = `auto~${entry2.entryId}`;
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry2.entryId,
      requestId: requestId2,
      source: 'automatic',
    });
    await waitUntil(() => promptTexts(fake).length > 0, 'running stage');
    expect(await broker.cancelStageDispatch(ticket(), requestId2)).toBe(true);
    receipt = await broker.getStageDispatch(ticket(), requestId2);
    expect(receipt?.state).toBe('cancelled');
    release();
  });

  it('fails stage dispatch permanently when pinned model cannot apply', async () => {
    const agentsDir = join(sandbox, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'pin-test.md'),
      [
        '---',
        'id: pin-test',
        'harness: cursor',
        'model: definitely-not-a-real-model-id',
        '---',
        'Pinned model agent',
      ].join('\n'),
    );
    const manifest = await loadTemplate(sandbox, 'feature');
    const entry = recordStageEntryLocked({
      ticketId: TICKET_ID,
      projectSlug: 'demo',
      actor: 'human',
      at: new Date().toISOString(),
      eventType: 'moved',
      stage: 'in_progress',
      manifest,
      from: 'backlog',
      verb: 'start',
      dispatchAgent: 'pin-test',
    });
    makeBroker(
      [{ steps: [{ kind: 'update', update: textChunk('never', 'm1') }] }],
      {},
      { setConfigOptionError: 'invalid model' },
    );
    const requestId = `auto~${entry.entryId}`;
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId,
      source: 'automatic',
    });
    await waitUntil(async () => {
      const receipt = await broker.getStageDispatch(ticket(), requestId);
      return receipt?.state === 'failed';
    }, 'pin failure');
    const session = await broker.getSession(ticket(), 'cursor');
    expect(session?.queued ?? []).toHaveLength(0);
  });

  it('replays queued unstarted stage request after broker restart', async () => {
    const entry = await recordEntryAsync('in_progress');
    makeBroker(
      [{ steps: [{ kind: 'update', update: textChunk('after restart', 'm1') }] }],
      { suppressStageDrive: true },
    );
    const requestId = `auto~${entry.entryId}`;
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId,
      source: 'automatic',
    });
    const queued = await broker.getStageDispatch(ticket(), requestId);
    expect(queued?.state).toBe('queued');
    await broker.stopAll();
    makeBroker([{ steps: [{ kind: 'update', update: textChunk('after restart', 'm1') }] }]);
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId,
      source: 'automatic',
    });
    await waitUntil(async () => {
      const receipt = await broker.getStageDispatch(ticket(), requestId);
      return receipt?.state === 'completed';
    }, 'replay after restart');
    expect(promptTexts(fake).length).toBeGreaterThan(0);
  });

  it('marks orphan started stage request interrupted on repair', async () => {
    const entry = await recordEntryAsync('in_progress');
    makeBroker([{ steps: [{ kind: 'hang' }] }]);
    const requestId = `auto~${entry.entryId}`;
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId,
      source: 'automatic',
    });
    await waitUntil(() => promptTexts(fake).length > 0, 'stage started', 5000);
    await broker.stopAll();
    const log = await events();
    const receipt = readStageDispatchReceipt(log, requestId);
    expect(receipt?.state).toBe('interrupted');
  });

  it('normalizer live item matches rebuild for stage.dispatch', async () => {
    const entry = await recordEntryAsync('in_progress');
    makeBroker([{ steps: [{ kind: 'update', update: textChunk('x', 'm1') }] }]);
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId: `auto~${entry.entryId}`,
      source: 'automatic',
    });
    const log = await events();
    const live = normalizeLive(log);
    await rebuildChatIndex(ticketDir, TICKET_ID);
    const rebuilt = replayItems(log, TICKET_ID).filter((i) => i.itemId.startsWith('stage~auto~'));
    expect(live.find((i) => i.itemId.endsWith('~0'))?.itemId).toBe(
      rebuilt.find((i) => i.itemId.endsWith('~0'))?.itemId,
    );
  });

  it('policyDigest uses template default not override recipient', async () => {
    const manifest = await loadTemplate(sandbox, 'feature');
    const templateDefault = resolveStageDispatch(manifest, 'review');
    expect(templateDefault?.agentId).toBe('cursor');
    const overrideTarget = resolveStageDispatch(manifest, 'review', 'codex')!;
    const digest = computePolicyDigest(
      manifest,
      'review',
      overrideTarget.instructions,
      templateDefault,
    );
    const defaultDigest = policyDigest({
      templateId: manifest.id,
      stage: 'review',
      role: templateDefault!.role,
      agentId: templateDefault!.agentId,
      auto: templateDefault!.auto,
      instructions: templateDefault!.instructions,
    });
    expect(digest).toBe(defaultDigest);
    expect(overrideTarget.agentId).not.toBe(templateDefault!.agentId);
  });

  it('rejects stale entry id that is not current', async () => {
    const first = await recordEntryAsync('in_progress');
    await recordEntryAsync('in_progress');
    await expect(
      resolveStageDispatchTarget(ticket(), first.entryId, 'automatic', undefined, sandbox),
    ).rejects.toBeInstanceOf(StagePolicyError);
  });

  it('does not supersede a running stage turn on notifyStageEntry', async () => {
    const entry = await recordEntryAsync('in_progress');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    makeBroker([{ steps: [{ kind: 'gate', gate }, { kind: 'update', update: textChunk('ok', 'm1') }] }]);
    const requestId = `auto~${entry.entryId}`;
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId,
      source: 'automatic',
    });
    await waitUntil(() => promptTexts(fake).length > 0, 'stage running', 5000);
    const manifest = await loadTemplate(sandbox, 'feature');
    recordStageEntryLocked({
      ticketId: TICKET_ID,
      projectSlug: 'demo',
      actor: 'human',
      at: new Date().toISOString(),
      eventType: 'moved',
      stage: 'in_progress',
      manifest,
      from: 'in_progress',
      verb: 'reopen',
    });
    await broker.notifyStageEntry(ticket());
    const receipt = await broker.getStageDispatch(ticket(), requestId);
    expect(receipt?.state).toBe('running');
    release();
    await waitUntil(async () => {
      const done = await broker.getStageDispatch(ticket(), requestId);
      return done?.state === 'completed';
    }, 'stage completes');
  });

  it('ignores unrelated broken agent files when dispatching', async () => {
    await mkdir(join(sandbox, 'agents'), { recursive: true });
    await writeFile(join(sandbox, 'agents', 'broken.md'), 'not valid frontmatter', 'utf-8');
    const entry = await recordEntryAsync('in_progress');
    makeBroker([{ steps: [{ kind: 'update', update: textChunk('ok', 'm1') }] }]);
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId: `auto~${entry.entryId}`,
      source: 'automatic',
    });
    await waitUntil(async () => {
      const receipt = await broker.getStageDispatch(ticket(), `auto~${entry.entryId}`);
      return receipt?.state === 'completed';
    }, 'dispatch with broken extra agent file');
  });

  it('supersedes queued stage dispatch when target agent is detached', async () => {
    const entry = await recordEntryAsync('in_progress');
    makeBroker([{ steps: [{ kind: 'hang' }] }]);
    const requestId = `auto~${entry.entryId}`;
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId,
      source: 'automatic',
    });
    await broker.setParticipants(ticket(), { agents: [], defaultAgent: null });
    const receipt = await broker.getStageDispatch(ticket(), requestId);
    expect(receipt?.state).toBe('superseded');
  });

  it('accepts manual dispatch with unrecorded fallback entry token', async () => {
    const manifest = await loadTemplate(sandbox, 'feature');
    const latest = await recordEntryAsync('backlog');
    const entryId = buildManualFallbackEntryId('in_progress', manifest.id, latest.entryId);
    const resolved = await resolveStageDispatchTarget(ticket(), entryId, 'manual', undefined, sandbox);
    expect(resolved.target.agentId).toBe('cursor');
    await expect(
      resolveStageDispatchTarget(ticket(), entryId, 'automatic', undefined, sandbox),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('releases ticket mutation lock while client.cancel is pending', async () => {
    const entry = await recordEntryAsync('in_progress');
    const requestId = `auto~${entry.entryId}`;
    let releaseCancel!: () => void;
    const cancelBarrier = new Promise<void>((r) => {
      releaseCancel = r;
    });
    const clientFactory: ClientFactory = (input) => {
      const inner = connectAcpClient(fake.app, {
        onUpdate: input.onUpdate,
        onPermissionRequest: input.onPermissionRequest,
        onExtRequest: input.onExtRequest,
        onExtNotification: input.onExtNotification,
      });
      return {
        ...inner,
        cancel: async (sessionId: string) => {
          void inner.cancel(sessionId);
          await cancelBarrier;
        },
      };
    };
    makeBroker([{ steps: [{ kind: 'hang' }] }], { clientFactory });
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId,
      source: 'automatic',
    });
    await waitUntil(() => fake.prompts.length > 0, 'stage prompt hanging');
    const cancelPromise = broker.cancelStageDispatch(ticket(), requestId);
    let lockAcquired = false;
    const lockPromise = withTicketMutationLock(
      resolve(ticketDir, 'ticket.md'),
      async () => {
        lockAcquired = true;
      },
      sandbox,
    );
    await Promise.race([
      lockPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('lock timeout')), 3000)),
    ]);
    expect(lockAcquired).toBe(true);
    await lockPromise;
    releaseCancel();
    await cancelPromise;
    const receipt = await broker.getStageDispatch(ticket(), requestId);
    expect(receipt?.state).toBe('cancelled');
  });

  it('does not invoke ACP when cancelled after the final receipt read', async () => {
    const entry = await recordEntryAsync('in_progress');
    const requestId = `auto~${entry.entryId}`;
    makeBroker([{ steps: [{ kind: 'update', update: textChunk('done', 'm1') }] }], {
      stageDriveHooks: {
        afterStageReceiptBeforePrompt: async () => {
          await broker.cancelStageDispatch(ticket(), requestId);
        },
      },
    });
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId,
      source: 'automatic',
    });
    await waitUntil(async () => {
      const receipt = await broker.getStageDispatch(ticket(), requestId);
      return receipt?.state === 'cancelled';
    }, 'cancelled after receipt read');
    expect(promptTexts(fake)).toHaveLength(0);
  });

  it('does not invoke ACP when cancelled at the start boundary hook', async () => {
    const entry = await recordEntryAsync('in_progress');
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const requestId = `auto~${entry.entryId}`;
    makeBroker(
      [{ steps: [{ kind: 'gate', gate }, { kind: 'update', update: textChunk('late', 'm1') }] }],
      {
        stageDriveHooks: {
          afterEngagementBeforePrompt: async () => {
            await broker.cancelStageDispatch(ticket(), requestId);
          },
        },
      },
    );
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId,
      source: 'automatic',
    });
    await waitUntil(async () => {
      const receipt = await broker.getStageDispatch(ticket(), requestId);
      return receipt?.state === 'cancelled';
    }, 'cancelled before prompt');
    expect(promptTexts(fake)).toHaveLength(0);
    releaseGate();
  });

  it('completed receipt is not overwritten by later cancelled state', () => {
    const requestId = 'auto~entry-1';
    const eventsList: ChatEvent[] = [
      {
        seq: 1,
        ticketId: TICKET_ID,
        kind: 'stage.dispatch',
        sessionKey: ticketScopeKey(TICKET_ID),
        agentId: 'system',
        turnId: null,
        ts: '2026-01-01T00:00:00.000Z',
        payload: {
          requestId,
          entryId: 'entry-1',
          agentId: 'cursor',
          stage: 'in_progress',
          role: 'agent',
          source: 'automatic',
          policyDigest: 'abc',
          state: 'queued',
        },
      },
      {
        seq: 2,
        ticketId: TICKET_ID,
        kind: 'stage.dispatch.state',
        sessionKey: ticketScopeKey(TICKET_ID),
        agentId: 'system',
        turnId: null,
        ts: '2026-01-01T00:00:01.000Z',
        payload: { requestId, state: 'completed' },
      },
      {
        seq: 3,
        ticketId: TICKET_ID,
        kind: 'stage.dispatch.state',
        sessionKey: ticketScopeKey(TICKET_ID),
        agentId: 'system',
        turnId: null,
        ts: '2026-01-01T00:00:02.000Z',
        payload: { requestId, state: 'cancelled' },
      },
    ];
    const receipt = readStageDispatchReceipt(eventsList, requestId);
    expect(receipt?.state).toBe('completed');
  });

  it('late stage cancel does not invoke ACP cancel on the next queued turn', async () => {
    const entry = await recordEntryAsync('in_progress');
    let releaseCancel!: () => void;
    const cancelBarrier = new Promise<void>((r) => {
      releaseCancel = r;
    });
    const clientFactory: ClientFactory = (input) => {
      const inner = connectAcpClient(fake.app, {
        onUpdate: input.onUpdate,
        onPermissionRequest: input.onPermissionRequest,
        onExtRequest: input.onExtRequest,
        onExtNotification: input.onExtNotification,
      });
      return {
        ...inner,
        cancel: async (sessionId: string) => {
          void inner.cancel(sessionId);
          await cancelBarrier;
        },
      };
    };
    makeBroker(
      [
        {
          steps: [
            {
              kind: 'permission',
              request: {
                toolCall: { toolCallId: 't1', title: 'Run test' },
                options: [
                  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
                ],
              },
            },
          ],
        },
        { steps: [{ kind: 'update', update: textChunk('second turn', 'm2') }] },
      ],
      { clientFactory },
    );
    const requestId1 = `auto~${entry.entryId}`;
    const requestId2 = randomUUID();
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId: requestId1,
      source: 'automatic',
    });
    await waitUntil(() => fake.prompts.length === 1, 'first turn permission pending');
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId: requestId2,
      source: 'manual',
    });
    const cancelPromise = broker.cancelStageDispatch(ticket(), requestId1);
    await waitUntil(() => fake.prompts.length >= 2, 'second turn started');
    expect(fake.calls.filter((c) => c === 'session/cancel')).toHaveLength(0);
    releaseCancel();
    await cancelPromise;
    await waitUntil(async () => {
      const receipt = await broker.getStageDispatch(ticket(), requestId2);
      return receipt?.state === 'completed';
    }, 'second turn completed');
    expect(fake.calls.filter((c) => c === 'session/cancel')).toHaveLength(0);
    const second = await broker.getStageDispatch(ticket(), requestId2);
    expect(second?.state).toBe('completed');
  });

  it('reviewer stage dispatch includes fresh show and syntaur log verdict command', async () => {
    await writeTicket('review');
    const entry = await recordEntryAsync('review');
    const requestId = randomUUID();
    makeBroker([{ steps: [{ kind: 'update', update: textChunk('reviewed', 'm1') }] }]);
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId,
      source: 'manual',
    });
    await waitUntil(async () => {
      const receipt = await broker.getStageDispatch(ticket(), requestId);
      return receipt?.state === 'completed';
    }, 'reviewer turn');
    expect(promptTexts(fake).length).toBe(1);
    const prompt = promptTexts(fake)[0];
    expect(prompt).toContain('Stage dispatch');
    expect(prompt).toContain(`syntaur log ${TICKET_ID} -t review`);
    expect(prompt).toContain('--verdict approve|changes');
    expect(prompt).toContain('reviewing work');
  });

  it('reviewer stage dispatch explains missing review log role in prompt', async () => {
    const templatesDir = join(sandbox, 'templates', 'no-review-log');
    await mkdir(templatesDir, { recursive: true });
    await writeFile(
      join(templatesDir, 'template.md'),
      [
        '---',
        'id: no-review-log',
        'version: 1',
        'description: Test template without review log role.',
        'whenToUse: Tests only.',
        'workspace: none',
        'stages:',
        '  - id: backlog',
        '    instructions: backlog',
        '  - id: review',
        '    instructions: Inspect carefully.',
        '    reviewer: cursor',
        '    auto: false',
        '  - id: done',
        '    instructions: done',
        'files:',
        '  - path: journal.md',
        '    role: log',
        '    writer: cli',
        '    createOn: ticket-creation',
        '    description: log',
        '    entryTypes: [progress, note]',
        '---',
        'test',
      ].join('\n'),
    );
    await writeFile(
      join(ticketDir, 'ticket.md'),
      [
        '---',
        `id: ${TICKET_ID}`,
        'slug: stage-dispatch',
        'title: "Stage dispatch"',
        'template: no-review-log',
        'status: review',
        'project: demo',
        'depends_on: []',
        'links: []',
        'plan:',
        '  file: null',
        '  approvedDigest: null',
        '  approvedAt: null',
        '  approvedBy: null',
        'workspace:',
        '  repository: null',
        '  branch: null',
        '  worktree: null',
        '---',
        '# Stage dispatch test',
      ].join('\n'),
    );
    const manifest = await loadTemplate(sandbox, 'no-review-log');
    const entry = recordStageEntryLocked({
      ticketId: TICKET_ID,
      projectSlug: 'demo',
      actor: 'human',
      at: new Date().toISOString(),
      eventType: 'moved',
      stage: 'review',
      manifest,
      from: 'in_progress',
      verb: 'review',
    });
    const requestId = randomUUID();
    makeBroker([{ steps: [{ kind: 'update', update: textChunk('findings', 'm1') }] }]);
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId,
      source: 'manual',
    });
    await waitUntil(async () => {
      const receipt = await broker.getStageDispatch(ticket(), requestId);
      return receipt?.state === 'completed';
    }, 'reviewer without log role');
    const prompt = promptTexts(fake)[0];
    expect(prompt).toContain('no review-capable log role');
    expect(prompt).not.toContain(`syntaur log ${TICKET_ID} -t review`);
  });

  it('getStageDispatch reconciles without starting work', async () => {
    const old = await recordEntryAsync('in_progress');
    makeBroker([{ steps: [{ kind: 'hang' }] }]);
    const requestId = `auto~${old.entryId}`;
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: old.entryId,
      requestId,
      source: 'automatic',
    });
    await recordEntryAsync('in_progress');
    const beforePrompts = promptTexts(fake).length;
    const receipt = await broker.getStageDispatch(ticket(), requestId);
    expect(receipt?.state).toBe('superseded');
    expect(promptTexts(fake).length).toBe(beforePrompts);
  });
});
