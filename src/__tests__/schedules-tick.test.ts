import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTick, type TickDeps } from '../schedules/tick.js';
import { writeJob, readJob } from '../schedules/store.js';
import { markDispatching, claimJob } from '../schedules/attempt.js';
import { readEvents } from '../schedules/event-log.js';
import { freshAttempt, defaultLimits } from '../schedules/types.js';
import { sampleJob, sampleAssignment, statusEntry, fakeDispatcher } from './schedules-helpers.js';

/**
 * Task 1 (phase 4, Decision 3): the tick fires by posting the job's `message`
 * into the assignment's chat, and the accepted `messageId` is the ack. There is
 * no launch plan, no terminal and no pid — a fake `ChatDispatcher` stands in for
 * the broker (in-process) or the dashboard's chat routes (REST).
 */

/** Deps where the dispatch succeeds deterministically with a frozen clock. */
function happyDeps(nowIso: string, overrides: Partial<TickDeps> = {}): TickDeps {
  return {
    now: () => new Date(nowIso),
    dispatcher: fakeDispatcher(),
    killSwitch: () => false,
    ...overrides,
  };
}

/** An attempt already in `running` off a dispatched message. */
const runningAttempt = (messageId: string) => ({
  ...freshAttempt(),
  state: 'running' as const,
  messageId,
  runningSince: '2026-06-15T03:00:00Z',
});

describe('runTick', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-tick-'));
    process.env.SYNTAUR_SCHEDULES_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.SYNTAUR_SCHEDULES_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('fires a due clock job exactly once, posting its message into the chat', async () => {
    const job = await writeJob(sampleJob({ trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' } }));
    const chat = fakeDispatcher();
    const first = await runTick(happyDeps('2026-06-15T04:00:00Z', { dispatcher: chat }));
    expect(first.fired).toContain(job.id);
    expect(chat.sent).toEqual([
      { assignmentId: 'scheduled-agents', agentId: 'claude', text: job.message },
    ]);
    const after = await readJob(job.id);
    expect(after?.attempt.state).toBe('running');
    // The messageId the chat handed back is the whole handle on the attempt.
    expect(after?.attempt.messageId).toBe('msg-1');
    expect(after?.attempt.dispatchCount).toBe(1);

    // Second tick: the one-shot job is now 'running' → not eligible → no refire.
    const second = await runTick(happyDeps('2026-06-15T05:00:00Z'));
    expect(second.evaluated).toBe(0);
    expect(second.fired).toEqual([]);
  });

  it('records the accepted messageId on the ack and running events', async () => {
    const job = await writeJob(sampleJob({ trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' } }));
    await runTick(happyDeps('2026-06-15T04:00:00Z'));
    const events = await readEvents(job.id);
    const ack = events.find((e) => e.type === 'ack');
    const running = events.find((e) => e.type === 'running');
    expect(ack?.data).toEqual({ messageId: 'msg-1' });
    expect(running?.data).toEqual({ messageId: 'msg-1' });
    expect(events.some((e) => e.type === 'dispatching')).toBe(true);
  });

  it('sends with agentId null when the job names no agent (the default answers)', async () => {
    await writeJob(
      sampleJob({ agentId: null, trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' } }),
    );
    const chat = fakeDispatcher({ attached: ['planner'] });
    await runTick(happyDeps('2026-06-15T04:00:00Z', { dispatcher: chat }));
    expect(chat.sent[0].agentId).toBeNull();
  });

  // Bug #2: a one-shot `at` whose fire time predates the schedule's creation is
  // skipped (not fired) on the next tick — buildTrigger does not reject a past
  // `--at`, so evaluateTrigger's creation baseline is the runtime guard.
  it('does not fire an `at` one-shot whose fire time predates creation (#2)', async () => {
    const job = await writeJob(
      sampleJob({ trigger: { kind: 'at', at: '2026-06-14T12:00:00Z' }, createdAt: '2026-06-15T00:00:00Z' }),
    );
    const res = await runTick(happyDeps('2026-06-15T04:00:00Z'));
    expect(res.fired).toEqual([]);
    expect(res.skipped).toBe(1);
    expect((await readJob(job.id))?.attempt.state).toBe('eligible');
  });

  it('does not double-fire the same cron occurrence after re-arm', async () => {
    const job = await writeJob(sampleJob({ trigger: { kind: 'cron', expr: '0 3 * * *', tz: 'UTC' } }));
    const first = await runTick(happyDeps('2026-06-15T03:00:00Z'));
    expect(first.fired).toContain(job.id);
    // Re-armed to eligible for the NEXT occurrence...
    expect((await readJob(job.id))?.attempt.state).toBe('eligible');
    // ...but the SAME occurrence must not refire at the same now.
    const second = await runTick(happyDeps('2026-06-15T03:00:00Z'));
    expect(second.fired).toEqual([]);
    expect(second.skipped).toBe(1);
    // A later occurrence fires again.
    const third = await runTick(happyDeps('2026-06-16T03:00:00Z'));
    expect(third.fired).toContain(job.id);
  });

  it('fires a state trigger off the statusHistory cursor', async () => {
    const job = await writeJob(sampleJob({ trigger: { kind: 'when-status', status: 'ready_to_implement' } }));
    const assignment = sampleAssignment({
      statusHistory: [statusEntry('ready_for_planning', '2026-06-15T01:00:00Z'), statusEntry('ready_to_implement', '2026-06-15T02:00:00Z')],
    });
    const res = await runTick(happyDeps('2026-06-15T03:00:00Z', { readAssignment: async () => assignment }));
    expect(res.fired).toContain(job.id);
    expect((await readJob(job.id))?.attempt.cursor).toBe(2);
  });

  it('after-reset reschedules (does not fire) before the predicted reset', async () => {
    const job = await writeJob(
      sampleJob({ trigger: { kind: 'after-reset', provider: 'claude', anchor: { windowStartIso: '2026-06-15T09:00:00Z', windowKind: 'rolling-5h' } } }),
    );
    const res = await runTick(happyDeps('2026-06-15T13:00:00Z'));
    expect(res.fired).toEqual([]);
    expect(res.skipped).toBe(1);
    expect((await readJob(job.id))?.attempt.state).toBe('eligible');
  });

  it('an assignment with no attached agent → dispatch_failed, and nothing is sent', async () => {
    const job = await writeJob(sampleJob({ trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' } }));
    const chat = fakeDispatcher({ attached: [] });
    const res = await runTick(happyDeps('2026-06-15T04:00:00Z', { dispatcher: chat }));
    expect(res.failed).toContain(job.id);
    expect(chat.sent).toEqual([]);
    const after = await readJob(job.id);
    expect(after?.attempt.state).toBe('dispatch_failed');
    expect(after?.attempt.lastError).toMatch(/not attached/);
  });

  it('an agent that is not attached → dispatch_failed naming it', async () => {
    const job = await writeJob(
      sampleJob({ agentId: 'reviewer', trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' } }),
    );
    const chat = fakeDispatcher({ attached: ['planner'] });
    const res = await runTick(happyDeps('2026-06-15T04:00:00Z', { dispatcher: chat }));
    expect(res.failed).toContain(job.id);
    expect(chat.sent).toEqual([]);
    expect((await readJob(job.id))?.attempt.lastError).toMatch(/"reviewer"/);
  });

  it('no dashboard and no broker → dispatch_failed, not a terminal fallback', async () => {
    const job = await writeJob(sampleJob({ trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' } }));
    const res = await runTick({
      now: () => new Date('2026-06-15T04:00:00Z'),
      killSwitch: () => false,
      dashboardPort: null,
    });
    expect(res.failed).toContain(job.id);
    const after = await readJob(job.id);
    expect(after?.attempt.state).toBe('dispatch_failed');
    expect(after?.attempt.lastError).toMatch(/dashboard is not running/);
  });

  it('a refused send → dispatch_failed with the chat’s reason', async () => {
    const job = await writeJob(sampleJob({ trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' } }));
    const res = await runTick(
      happyDeps('2026-06-15T04:00:00Z', {
        dispatcher: fakeDispatcher({ sendError: 'workspace path invalid' }),
      }),
    );
    expect(res.failed).toContain(job.id);
    expect((await readJob(job.id))?.attempt.lastError).toMatch(/workspace path invalid/);
  });

  it('the kill switch fires nothing', async () => {
    const job = await writeJob(sampleJob({ trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' } }));
    const res = await runTick(happyDeps('2026-06-15T04:00:00Z', { killSwitch: () => true }));
    expect(res.fired).toEqual([]);
    expect((await readJob(job.id))?.attempt.state).toBe('eligible');
  });

  it('records stuck:max-runtime for an overrun running job whose turn has ended (B8)', async () => {
    // A recurring (cron) job stuck in `running` whose maxRuntime has elapsed and
    // whose turn has ended. Recurring jobs have no completion path (B7), so the
    // stuck recording applies and the state is LEFT running by design.
    const job = await writeJob(
      sampleJob({
        trigger: { kind: 'cron', expr: '0 3 * * *', tz: 'UTC' },
        limits: { ...defaultLimits(), maxRuntimeMs: 60_000 },
        attempt: runningAttempt('msg-dead'),
      }),
    );
    // 1h later — well past the 60s maxRuntime — and the turn has ended.
    const res = await runTick(
      happyDeps('2026-06-15T04:00:00Z', { isMessageTurnOpen: async () => false }),
    );
    expect(res.stuck).toContain(job.id);
    const after = await readJob(job.id);
    expect(after?.attempt.lastError).toBe('stuck:max-runtime');
    // Mechanism, not policy: the job is LEFT in 'running' (no terminal state).
    expect(after?.attempt.state).toBe('running');
  });

  it('does NOT flag a still-running overrun job (B8)', async () => {
    const job = await writeJob(
      sampleJob({
        trigger: { kind: 'cron', expr: '0 3 * * *', tz: 'UTC' },
        limits: { ...defaultLimits(), maxRuntimeMs: 60_000 },
        attempt: runningAttempt('msg-live'),
      }),
    );
    const res = await runTick(
      happyDeps('2026-06-15T04:00:00Z', { isMessageTurnOpen: async () => true }),
    );
    expect(res.stuck).not.toContain(job.id);
    const after = await readJob(job.id);
    expect(after?.attempt.lastError).toBeNull();
    expect(after?.attempt.state).toBe('running');
  });

  it('reconciles a one-shot past grace whose turn ended to completed (B7)', async () => {
    const job = await writeJob(
      sampleJob({
        trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' },
        limits: { ...defaultLimits(), maxRuntimeMs: 60_000 },
        attempt: runningAttempt('msg-ended'),
      }),
    );
    // 1h later (well past the 60s grace) and the turn has ended.
    const res = await runTick(
      happyDeps('2026-06-15T04:00:00Z', { isMessageTurnOpen: async () => false }),
    );
    expect(res.completed).toContain(job.id);
    expect((await readJob(job.id))?.attempt.state).toBe('completed');
    const events = await readEvents(job.id);
    expect(events.some((e) => e.type === 'completed')).toBe(true);
  });

  it('does NOT complete a one-shot still within the grace window (B7)', async () => {
    const job = await writeJob(
      sampleJob({
        trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' },
        limits: { ...defaultLimits(), maxRuntimeMs: 60_000 },
        attempt: runningAttempt('msg-fresh'),
      }),
    );
    // Only 30s elapsed — within the 60s grace — even with an ended turn.
    const res = await runTick(
      happyDeps('2026-06-15T03:00:30Z', { isMessageTurnOpen: async () => false }),
    );
    expect(res.completed).toEqual([]);
    expect((await readJob(job.id))?.attempt.state).toBe('running');
  });

  it('does NOT complete a one-shot the chat has never heard of (B7)', async () => {
    const job = await writeJob(
      sampleJob({
        trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' },
        limits: { ...defaultLimits(), maxRuntimeMs: 60_000 },
        attempt: runningAttempt('msg-unknown'),
      }),
    );
    // Past grace, but the chat returns no state for the id → unknown → open.
    const res = await runTick(
      happyDeps('2026-06-15T04:00:00Z', { dispatcher: fakeDispatcher({ state: null }) }),
    );
    expect(res.completed).toEqual([]);
    expect((await readJob(job.id))?.attempt.state).toBe('running');
  });

  it('does NOT complete a recurring job stuck in running (B7)', async () => {
    const job = await writeJob(
      sampleJob({
        trigger: { kind: 'cron', expr: '0 3 * * *', tz: 'UTC' },
        limits: { ...defaultLimits(), maxRuntimeMs: 60_000 },
        attempt: runningAttempt('msg-recurring'),
      }),
    );
    const res = await runTick(
      happyDeps('2026-06-15T04:00:00Z', { isMessageTurnOpen: async () => false }),
    );
    expect(res.completed).toEqual([]);
    // Recurring jobs get the stuck recording (B8), not completion (B7).
    expect((await readJob(job.id))?.attempt.state).toBe('running');
  });

  it('reaps a dispatching job whose claim expired', async () => {
    const job = await writeJob(sampleJob({ trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' } }));
    const claim = await claimJob(job, { dedupeKey: 'e' }, { now: () => new Date('2026-06-15T03:00:00Z') });
    if (!claim.claimed) throw new Error('expected claim');
    await markDispatching(claim.job, 'msg-stuck', { now: () => new Date('2026-06-15T03:00:00Z') });
    // Tick far past the claim TTL → reaped to dispatch_failed.
    const res = await runTick(happyDeps('2026-06-15T03:30:00Z'));
    expect(res.reaped).toContain(job.id);
    expect((await readJob(job.id))?.attempt.state).toBe('dispatch_failed');
  });

  // AC1: a single job with an invalid timezone must NOT abort the whole tick —
  // every other due job must still fire. On `main`, evaluateTrigger throws out
  // of the per-job loop and runTick rejects, so the good job never fires.
  it('does not abort the tick when one job has an invalid timezone (AC1)', async () => {
    await writeJob(sampleJob({ trigger: { kind: 'cron', expr: '0 3 * * *', tz: 'Not/AZone' } }));
    const good = await writeJob(sampleJob({ trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' } }));
    const res = await runTick(happyDeps('2026-06-15T04:00:00Z'));
    expect(res.fired).toContain(good.id);
  });
});
