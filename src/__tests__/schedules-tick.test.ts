import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTick, type TickDeps } from '../schedules/tick.js';
import { writeJob, readJob } from '../schedules/store.js';
import { markLaunching, claimJob } from '../schedules/attempt.js';
import { readEvents } from '../schedules/event-log.js';
import type { LaunchPlan } from '../launch/plan.js';
import type { LaunchHandle } from '../launch/execute.js';
import { freshAttempt, defaultLimits } from '../schedules/types.js';
import { sampleJob, sampleAssignment, statusEntry } from './schedules-helpers.js';

const fakePlan = (terminal = 'terminal-app'): LaunchPlan =>
  ({ terminal, cwd: '/work/repo', agentId: 'claude' } as unknown as LaunchPlan);
const fakeHandle = (): LaunchHandle => ({ pid: 4242, plan: fakePlan(), startedAt: '2026-06-15T03:00:00Z' });

/** Deps where launch + ack succeed deterministically with a frozen clock. */
function happyDeps(nowIso: string, overrides: Partial<TickDeps> = {}): TickDeps {
  return {
    now: () => new Date(nowIso),
    resolvePlan: async () => fakePlan(),
    launch: async () => fakeHandle(),
    ack: async () => ({ acked: true, sessionId: 'sess-1' }),
    killSwitch: () => false,
    ...overrides,
  };
}

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

  it('fires a due clock job exactly once', async () => {
    const job = await writeJob(sampleJob({ trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' } }));
    const first = await runTick(happyDeps('2026-06-15T04:00:00Z'));
    expect(first.fired).toContain(job.id);
    expect((await readJob(job.id))?.attempt.state).toBe('running');

    // Second tick: the one-shot job is now 'running' → not eligible → no refire.
    const second = await runTick(happyDeps('2026-06-15T05:00:00Z'));
    expect(second.evaluated).toBe(0);
    expect(second.fired).toEqual([]);
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

  it('launch-ack timeout → launch_failed', async () => {
    const job = await writeJob(sampleJob({ trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' } }));
    const res = await runTick(happyDeps('2026-06-15T04:00:00Z', { ack: async () => ({ acked: false }) }));
    expect(res.failed).toContain(job.id);
    expect((await readJob(job.id))?.attempt.state).toBe('launch_failed');
  });

  it('a launch error → launch_failed', async () => {
    const job = await writeJob(sampleJob({ trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' } }));
    const res = await runTick(
      happyDeps('2026-06-15T04:00:00Z', { launch: async () => { throw new Error('terminal not found'); } }),
    );
    expect(res.failed).toContain(job.id);
    expect((await readJob(job.id))?.attempt.lastError).toMatch(/terminal not found/);
  });

  it('refuses to fire an unattended Warp job at fire time', async () => {
    const job = await writeJob(sampleJob({ unattended: true, trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' } }));
    const res = await runTick(happyDeps('2026-06-15T04:00:00Z', { resolvePlan: async () => fakePlan('warp') }));
    expect(res.failed).toContain(job.id);
    expect((await readJob(job.id))?.attempt.lastError).toMatch(/warp/i);
  });

  it('the kill switch fires nothing', async () => {
    const job = await writeJob(sampleJob({ trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' } }));
    const res = await runTick(happyDeps('2026-06-15T04:00:00Z', { killSwitch: () => true }));
    expect(res.fired).toEqual([]);
    expect((await readJob(job.id))?.attempt.state).toBe('eligible');
  });

  it('records stuck:max-runtime for an overrun running job with a dead session (B8)', async () => {
    // A recurring (cron) job stuck in `running` whose maxRuntime has elapsed and
    // whose session is dead. Recurring jobs have no completion path (B7), so the
    // stuck recording applies and the state is LEFT running by design.
    const job = await writeJob(
      sampleJob({
        trigger: { kind: 'cron', expr: '0 3 * * *', tz: 'UTC' },
        limits: { ...defaultLimits(), maxRuntimeMs: 60_000 },
        attempt: {
          ...freshAttempt(),
          state: 'running',
          sessionId: 'sess-dead',
          launchPid: 4242,
          runningSince: '2026-06-15T03:00:00Z',
        },
      }),
    );
    // 1h later — well past the 60s maxRuntime — and the session is dead.
    const res = await runTick(happyDeps('2026-06-15T04:00:00Z', { isSessionLive: () => false }));
    expect(res.stuck).toContain(job.id);
    const after = await readJob(job.id);
    expect(after?.attempt.lastError).toBe('stuck:max-runtime');
    // Mechanism, not policy: the job is LEFT in 'running' (no terminal state).
    expect(after?.attempt.state).toBe('running');
  });

  it('does NOT flag a still-live overrun running job (B8)', async () => {
    const job = await writeJob(
      sampleJob({
        trigger: { kind: 'cron', expr: '0 3 * * *', tz: 'UTC' },
        limits: { ...defaultLimits(), maxRuntimeMs: 60_000 },
        attempt: {
          ...freshAttempt(),
          state: 'running',
          sessionId: 'sess-live',
          launchPid: 4242,
          runningSince: '2026-06-15T03:00:00Z',
        },
      }),
    );
    const res = await runTick(happyDeps('2026-06-15T04:00:00Z', { isSessionLive: () => true }));
    expect(res.stuck).not.toContain(job.id);
    const after = await readJob(job.id);
    expect(after?.attempt.lastError).toBeNull();
    expect(after?.attempt.state).toBe('running');
  });

  it('reconciles a one-shot past grace with a dead session to completed (B7)', async () => {
    const job = await writeJob(
      sampleJob({
        trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' },
        limits: { ...defaultLimits(), maxRuntimeMs: 60_000 },
        attempt: {
          ...freshAttempt(),
          state: 'running',
          sessionId: 'sess-ended',
          launchPid: 4242,
          runningSince: '2026-06-15T03:00:00Z',
        },
      }),
    );
    // 1h later (well past the 60s grace) and the session is dead.
    const res = await runTick(happyDeps('2026-06-15T04:00:00Z', { isSessionLive: () => false }));
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
        attempt: {
          ...freshAttempt(),
          state: 'running',
          sessionId: 'sess-fresh',
          launchPid: 4242,
          runningSince: '2026-06-15T03:00:00Z',
        },
      }),
    );
    // Only 30s elapsed — within the 60s grace — even with a dead session.
    const res = await runTick(happyDeps('2026-06-15T03:00:30Z', { isSessionLive: () => false }));
    expect(res.completed).toEqual([]);
    expect((await readJob(job.id))?.attempt.state).toBe('running');
  });

  it('does NOT complete a just-acked one-shot whose session row is not written yet (B7)', async () => {
    const job = await writeJob(
      sampleJob({
        trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' },
        limits: { ...defaultLimits(), maxRuntimeMs: 60_000 },
        attempt: {
          ...freshAttempt(),
          state: 'running',
          sessionId: 'sess-no-row',
          launchPid: 4242,
          runningSince: '2026-06-15T03:00:00Z',
        },
      }),
    );
    // Past grace, but the session id has no registry row yet → treated as live.
    const res = await runTick(happyDeps('2026-06-15T04:00:00Z', { isSessionLive: () => true }));
    expect(res.completed).toEqual([]);
    expect((await readJob(job.id))?.attempt.state).toBe('running');
  });

  it('does NOT complete a recurring job stuck in running (B7)', async () => {
    const job = await writeJob(
      sampleJob({
        trigger: { kind: 'cron', expr: '0 3 * * *', tz: 'UTC' },
        limits: { ...defaultLimits(), maxRuntimeMs: 60_000 },
        attempt: {
          ...freshAttempt(),
          state: 'running',
          sessionId: 'sess-recurring',
          launchPid: 4242,
          runningSince: '2026-06-15T03:00:00Z',
        },
      }),
    );
    const res = await runTick(happyDeps('2026-06-15T04:00:00Z', { isSessionLive: () => false }));
    expect(res.completed).toEqual([]);
    // Recurring jobs get the stuck recording (B8), not completion (B7).
    expect((await readJob(job.id))?.attempt.state).toBe('running');
  });

  it('reaps a launching job whose claim expired', async () => {
    let job = await writeJob(sampleJob({ trigger: { kind: 'at', at: '2026-06-15T03:00:00Z' } }));
    const claim = await claimJob(job, { dedupeKey: 'e' }, { now: () => new Date('2026-06-15T03:00:00Z') });
    if (!claim.claimed) throw new Error('expected claim');
    await markLaunching(claim.job, 99, { now: () => new Date('2026-06-15T03:00:00Z') });
    // Tick far past the claim TTL → reaped to launch_failed.
    const res = await runTick(happyDeps('2026-06-15T03:30:00Z'));
    expect(res.reaped).toContain(job.id);
    expect((await readJob(job.id))?.attempt.state).toBe('launch_failed');
  });
});
