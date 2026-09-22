import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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
import {
  ChatSendError,
  createChatBroker,
  type ChatBroker,
  type ClientFactory,
} from '../chat/broker.js';
import { waitUntil } from './helpers/wait-until.js';
import { readEvents } from '../chat/store.js';
import { readStageDispatchReceipt } from '../chat/stage-dispatch-state.js';
import { loadTemplate } from '../ticket-templates/registry.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { recordStageEntryLocked } from '../lifecycle/stage-entry.js';
import type { ChatEvent } from '../chat/types.js';
import type { ResolvedTicket } from '../utils/ticket-resolver.js';
import { fakeCommandResolver } from './helpers/fake-command-resolver.js';

let sandbox: string;
let ticketDir: string;
let worktree: string;
let broker: ChatBroker;
let fake: FakeAgent;
let clients: AcpClient[];

const TICKET_ID = 'SD-SHUTDOWN';

const ticket = (): ResolvedTicket => ({
  ticketDir,
  projectSlug: 'demo',
  ticketSlug: 'stage-dispatch',
  id: TICKET_ID,
  standalone: false,
});

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
) {
  fake = createFakeAgent({ turns });
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
    commandResolver: fakeCommandResolver,
    projectsDir: join(sandbox, 'projects'),
    syntaurHome: sandbox,
    broadcast: () => {},
    clientFactory,
    timeouts: {
      flushMs: 1,
      permissionMs: 200,
      sessionIdleMs: 5000,
      shutdownGraceMs: 100,
      inboxGraceMs: 60_000,
      turnIdleMs: 60_000,
      turnMaxMs: 120_000,
    },
    ...extra,
  });
  return broker;
}

function eventsPath(): string {
  return join(ticketDir, 'chat', 'events.jsonl');
}

async function logSize(): Promise<{ bytes: number; lines: number }> {
  const raw = await readFile(eventsPath(), 'utf-8');
  const lines = raw.trim().length === 0 ? 0 : raw.trim().split('\n').length;
  return { bytes: Buffer.byteLength(raw, 'utf-8'), lines };
}

function lastTurnEndForTurn(eventsList: ChatEvent[], turnId: string): ChatEvent | undefined {
  return [...eventsList]
    .reverse()
    .find((e) => e.kind === 'turn.end' && e.turnId === turnId);
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'chat-shutdown-'));
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
  await writeTicket();
});

afterEach(async () => {
  await broker?.stopAll().catch(() => {});
  for (const client of clients) await client.close().catch(() => {});
  closeUsageDb();
  closeSessionDb();
  resetSessionDb();
  closeEventsDb();
  resetEventsDb();
  delete process.env.SYNTAUR_HOME;
  await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('broker stopAll shutdown', () => {
  it('a turn released after stopAll cannot write', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);

    makeBroker([
      {
        steps: [
          { kind: 'update', update: textChunk('held', 'm1') },
          { kind: 'gate', gate },
          { kind: 'update', update: textChunk('late', 'm2') },
        ],
      },
    ]);

    const entry = await recordEntryAsync('in_progress');
    const requestId = `auto~${entry.entryId}`;
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId,
      source: 'automatic',
    });

    await waitUntil(() => fake.prompts.length === 1, 'stage prompt in flight');

    await broker.stopAll();

    const eventsList = await readEvents(eventsPath());
    const turnStart = eventsList.find((e) => e.kind === 'turn.start' && e.agentId === 'cursor');
    expect(turnStart?.turnId).toBeTruthy();
    const turnId = turnStart!.turnId!;
    const turnEnd = lastTurnEndForTurn(eventsList, turnId);
    expect(turnEnd).toBeDefined();
    expect((turnEnd!.payload as { stopReason?: string }).stopReason).toBe('interrupted');
    const receipt = readStageDispatchReceipt(eventsList, requestId);
    expect(receipt?.state).toBe('interrupted');

    const snap = await logSize();

    releaseGate();
    await new Promise((r) => setTimeout(r, 300));
    const afterRelease = await logSize();
    expect(afterRelease.bytes).toBe(snap.bytes);
    expect(afterRelease.lines).toBe(snap.lines);
    expect(rejections).toEqual([]);

    const chatDir = join(ticketDir, 'chat');
    await rm(chatDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await new Promise((r) => setTimeout(r, 200));
    await expect(stat(chatDir)).rejects.toMatchObject({ code: 'ENOENT' });

    process.off('unhandledRejection', onRejection);
  });

  it('nothing appends after stopAll from armed timers (completed turn idle)', async () => {
    makeBroker([{ steps: [{ kind: 'update', update: textChunk('ok', 'm1') }] }], {
      timeouts: { flushMs: 1, sessionIdleMs: 30_000, shutdownGraceMs: 100 },
    });
    await broker.send({ ticket: ticket(), text: 'hello' });
    await waitUntil(async () => {
      const ev = await readEvents(eventsPath());
      return ev.some((e) => e.kind === 'turn.end');
    }, 'turn to complete');
    await broker.stopAll();
    const snap = await logSize();
    await new Promise((r) => setTimeout(r, 250));
    const later = await logSize();
    expect(later.bytes).toBe(snap.bytes);
    expect(later.lines).toBe(snap.lines);
  });

  it('nothing appends after stopAll from armed timers (unanswered permission)', async () => {
    makeBroker(
      [
        {
          steps: [
            {
              kind: 'permission',
              request: {
                toolCall: { toolCallId: 't1', title: 'Read', kind: 'read' },
                options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
              },
            },
          ],
        },
      ],
      { timeouts: { flushMs: 1, permissionMs: 50, shutdownGraceMs: 100 } },
    );
    await broker.send({ ticket: ticket(), text: 'go' });
    await waitUntil(() => fake.prompts.length === 1, 'permission turn started');
    await broker.stopAll();
    const snap = await logSize();
    await new Promise((r) => setTimeout(r, 250));
    const later = await logSize();
    expect(later.bytes).toBe(snap.bytes);
    expect(later.lines).toBe(snap.lines);
  });

  it('stopAll is bounded when a turn gate is never released', async () => {
    const GRACE = 100;
    const BOUNDED_WAITS = 9;
    // Nine grace-bounded waits in stopAll (broker.ts): constructing join (~4838–4849),
    // cancelTurn (~4875), inFlight (~4876), handlerWork (~4923), driving join (~4927–4941),
    // recordChains (~4958), agentWrites (~4959), handler/recorded tail (~4970), log.close() (~4979).
    const gate = new Promise<void>(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    makeBroker([{ steps: [{ kind: 'gate', gate }] }]);

    const entry = await recordEntryAsync('in_progress');
    await broker.dispatchStage({
      ticket: ticket(),
      entryId: entry.entryId,
      requestId: `auto~${entry.entryId}`,
      source: 'automatic',
    });
    await waitUntil(() => fake.prompts.length === 1, 'gate held turn');

    const t0 = performance.now();
    await broker.stopAll();
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(GRACE * BOUNDED_WAITS + 500);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('shutdown grace')).length).toBe(1);
    warn.mockRestore();
  });

  it('stopAll is idempotent and rejects new work with 503', async () => {
    makeBroker();
    await broker.stopAll();
    await broker.stopAll();
    await expect(
      broker.dispatchStage({
        ticket: ticket(),
        entryId: 'e1',
        requestId: 'r1',
        source: 'manual',
        agentId: 'cursor',
      }),
    ).rejects.toMatchObject({ message: 'chat broker stopped', status: 503 });
    await expect(broker.send({ ticket: ticket(), text: 'hi' })).rejects.toMatchObject({
      message: 'chat broker stopped',
      status: 503,
    });
    const ev = await readEvents(eventsPath());
    expect(ev).toHaveLength(0);
  });
});
