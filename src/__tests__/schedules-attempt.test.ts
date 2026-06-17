import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimJob,
  markLaunching,
  markRunning,
  reapStale,
  holdJob,
  releaseJob,
  cancelJob,
  killJob,
  retryJob,
  rescheduleJob,
  TransitionError,
  type AttemptDeps,
} from '../schedules/attempt.js';
import { writeJob, readJob } from '../schedules/store.js';
import { evaluateTrigger } from '../schedules/triggers.js';
import { freshAttempt } from '../schedules/types.js';
import { sampleJob } from './schedules-helpers.js';

const fixedNow = (iso: string): AttemptDeps => ({ now: () => new Date(iso) });

describe('attempt state machine', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-attempt-'));
    process.env.SYNTAUR_SCHEDULES_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.SYNTAUR_SCHEDULES_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('claimJob persists the cursor + dedupe BEFORE launch', async () => {
    const job = await writeJob(sampleJob({ trigger: { kind: 'when-status', status: 's' } }));
    const res = await claimJob(job, { dedupeKey: 'status:1:t', nextCursor: 2 }, fixedNow('2026-06-15T03:00:00Z'));
    expect(res.claimed).toBe(true);
    // The crash-safe guarantee: read straight back from disk.
    const onDisk = await readJob(job.id);
    expect(onDisk?.attempt.state).toBe('claimed');
    expect(onDisk?.attempt.consumedEdges).toEqual(['status:1:t']);
    expect(onDisk?.attempt.cursor).toBe(2);
    expect(onDisk?.attempt.claim).not.toBeNull();
  });

  it('rejects a second concurrent claim of the same job (race)', async () => {
    const job = await writeJob(sampleJob());
    const deps = fixedNow('2026-06-15T03:00:00Z');
    const [a, b] = await Promise.all([
      claimJob(job, { dedupeKey: 'e1' }, deps),
      claimJob(job, { dedupeKey: 'e1' }, deps),
    ]);
    const claimedCount = [a, b].filter((r) => r.claimed).length;
    expect(claimedCount).toBe(1);
  });

  it('does not re-fire after a simulated crash post-claim (consumedEdges persists)', async () => {
    const job = await writeJob(
      sampleJob({ trigger: { kind: 'at', at: '2026-06-15T12:00:00Z' } }),
    );
    await claimJob(job, { dedupeKey: 'at:2026-06-15T12:00:00Z' }, fixedNow('2026-06-15T12:00:00Z'));
    // "Crash": reload from disk and re-evaluate — the edge must not be due again.
    const reloaded = await readJob(job.id);
    expect(reloaded).not.toBeNull();
    const e = evaluateTrigger(reloaded!, { now: new Date('2026-06-15T13:00:00Z') });
    expect(e.due).toBe(false);
  });

  it('rejects a timing config that violates claimTtl > ackTimeout + slack', async () => {
    const job = await writeJob(
      sampleJob({ timing: { claimTtlMs: 100, ackTimeoutMs: 90, launchSlackMs: 50 } }),
    );
    await expect(claimJob(job, { dedupeKey: 'e' }, fixedNow('2026-06-15T03:00:00Z'))).rejects.toThrow();
  });

  it('reaps a launching job whose claim lease expired → launch_failed', async () => {
    let job = await writeJob(sampleJob());
    const claim = await claimJob(job, { dedupeKey: 'e' }, fixedNow('2026-06-15T03:00:00Z'));
    if (!claim.claimed) throw new Error('expected claim');
    job = await markLaunching(claim.job, 4321, fixedNow('2026-06-15T03:00:00Z'));
    // Well past the claim TTL (default 120s).
    const out = await reapStale([await readJob(job.id) as NonNullable<Awaited<ReturnType<typeof readJob>>>], fixedNow('2026-06-15T03:10:00Z'));
    expect(out.reaped).toContain(job.id);
    expect((await readJob(job.id))?.attempt.state).toBe('launch_failed');
  });

  it('flags a running job past max-runtime with no heartbeat as stuck (no remediation)', async () => {
    const base = sampleJob({ limits: { ...sampleJob().limits, maxRuntimeMs: 1000 } });
    const job = await writeJob({
      ...base,
      attempt: { ...base.attempt, state: 'running', runningSince: '2026-06-15T03:00:00Z', sessionId: 's', launchPid: 9 },
    });
    const out = await reapStale([job], {
      now: () => new Date('2026-06-15T03:30:00Z'),
      isSessionLive: () => false,
    });
    expect(out.stuck).toContain(job.id);
    // Mechanism, not policy: state stays running; stuck is recorded, not remediated.
    expect((await readJob(job.id))?.attempt.state).toBe('running');
    expect((await readJob(job.id))?.attempt.lastError).toBe('stuck:max-runtime');
  });

  it('control verbs: hold → release, cancel, kill, retry', async () => {
    const job = await writeJob(sampleJob());
    await holdJob(job.id);
    expect((await readJob(job.id))?.attempt.state).toBe('held');
    await releaseJob(job.id);
    expect((await readJob(job.id))?.attempt.state).toBe('eligible');
    await cancelJob(job.id);
    expect((await readJob(job.id))?.attempt.state).toBe('cancelled');
    // cancel is terminal → can't hold it now.
    await expect(holdJob(job.id)).rejects.toThrow(TransitionError);
  });

  it('kill from running → killed and signals the pid; retry re-arms launch_failed', async () => {
    const base = sampleJob();
    const running = await writeJob({
      ...base,
      attempt: { ...base.attempt, state: 'running', launchPid: 777, sessionId: 's' },
    });
    let signalled: { sessionId: string | null; launchPid: number | null } | null = null;
    await killJob(running.id, { signalTarget: (t) => { signalled = t; } });
    expect(signalled).toEqual({ sessionId: 's', launchPid: 777 });
    expect((await readJob(running.id))?.attempt.state).toBe('killed');

    const failed = await writeJob({
      ...sampleJob(),
      attempt: { ...base.attempt, state: 'launch_failed', lastError: 'x' },
    });
    await retryJob(failed.id);
    expect((await readJob(failed.id))?.attempt.state).toBe('eligible');
  });

  it('reschedule swaps the trigger and FULLY re-arms (resets cursor + dedupe)', async () => {
    // A stale cursor/dedupe from the old trigger must not strand the new one.
    const job = await writeJob(
      sampleJob({
        trigger: { kind: 'when-status', status: 'old' },
        attempt: { ...sampleJob().attempt, cursor: 99, consumedEdges: ['status:0:t'] },
      }),
    );
    const next = await rescheduleJob(job.id, { kind: 'when-status', status: 'new' });
    expect(next.trigger).toEqual({ kind: 'when-status', status: 'new' });
    expect(next.attempt.cursor).toBe(0);
    expect(next.attempt.consumedEdges).toEqual([]);
    expect(next.attempt.state).toBe('eligible');
    // createdAt was reset so it reacts only to future edges.
    expect(next.createdAt).not.toBe(job.createdAt);
  });

  // AC3: launchDayStamps are pruned to the current day on each launch.
  it('prunes launchDayStamps to today (no unbounded growth)', async () => {
    const job = await writeJob(
      sampleJob({
        attempt: {
          ...freshAttempt(),
          state: 'launching',
          launchDayStamps: ['2026-06-01', '2026-06-14'],
          claim: { token: 't', expiresAt: Date.parse('2026-06-15T04:00:00Z') },
        },
      }),
    );
    const after = await markRunning(job, 'sid', fixedNow('2026-06-15T03:00:00Z'));
    expect(after.attempt.launchDayStamps).toEqual(['2026-06-15']);
  });

  // AC3: consumedEdges is windowed so a long-lived cron job's file can't grow
  // without bound.
  it('windows consumedEdges to the most recent 50 on claim', async () => {
    const old = Array.from({ length: 50 }, (_, i) => `cron:old-${String(i).padStart(3, '0')}`);
    const job = await writeJob(
      sampleJob({ attempt: { ...freshAttempt(), state: 'eligible', consumedEdges: old } }),
    );
    const res = await claimJob(job, { dedupeKey: 'cron:new' }, fixedNow('2026-06-15T03:00:00Z'));
    expect(res.claimed).toBe(true);
    const onDisk = await readJob(job.id);
    expect(onDisk?.attempt.consumedEdges.length).toBe(50);
    expect(onDisk?.attempt.consumedEdges).toContain('cron:new');
    expect(onDisk?.attempt.consumedEdges).not.toContain('cron:old-000'); // oldest dropped
  });

  // AC6: a transition whose precondition no longer holds is a no-op (a stale
  // snapshot can't clobber a concurrently-changed job).
  it('markRunning is a no-op when the on-disk state is no longer launching', async () => {
    const job = await writeJob(
      sampleJob({ attempt: { ...freshAttempt(), state: 'killed' } }),
    );
    const after = await markRunning(job, 'sid', fixedNow('2026-06-15T03:00:00Z'));
    expect(after.attempt.state).toBe('killed');
    expect((await readJob(job.id))?.attempt.state).toBe('killed');
  });

  // AC6: reapStale records no outcome (and doesn't clobber) when the on-disk job
  // changed under the snapshot it was handed.
  it('reapStale does not clobber a job that changed under the snapshot', async () => {
    const snapshot = await writeJob(
      sampleJob({
        attempt: {
          ...freshAttempt(),
          state: 'claimed',
          claim: { token: 't', expiresAt: Date.parse('2026-06-15T03:00:00Z') },
        },
      }),
    );
    // The job is cancelled on disk after the snapshot was taken.
    await cancelJob(snapshot.id);
    const out = await reapStale([snapshot], fixedNow('2026-06-15T04:00:00Z'));
    expect(out.reaped).toEqual([]);
    expect((await readJob(snapshot.id))?.attempt.state).toBe('cancelled');
  });

  // AC6: a stale snapshot whose claim token no longer matches (the job was
  // reaped→retried→reclaimed into a NEW attempt) must not be advanced.
  it('markRunning is a no-op when the on-disk claim token differs (new attempt)', async () => {
    const onDisk = await writeJob(
      sampleJob({
        attempt: {
          ...freshAttempt(),
          state: 'launching',
          claim: { token: 'NEW', expiresAt: Date.parse('2026-06-15T04:00:00Z') },
        },
      }),
    );
    const stale = {
      ...onDisk,
      attempt: { ...onDisk.attempt, claim: { token: 'OLD', expiresAt: Date.parse('2026-06-15T04:00:00Z') } },
    };
    const after = await markRunning(stale, 'sid', fixedNow('2026-06-15T03:00:00Z'));
    expect(after.attempt.state).toBe('launching'); // not advanced
    expect((await readJob(onDisk.id))?.attempt.claim?.token).toBe('NEW'); // not clobbered
  });

  // AC6: reapStale must not complete a DIFFERENT running attempt than the one its
  // snapshot evaluated (a new run started under the same id).
  it('reapStale does not complete a different running attempt than the snapshot', async () => {
    const onDisk = await writeJob(
      sampleJob({
        trigger: { kind: 'at', at: '2026-06-14T00:00:00Z' }, // one-shot
        attempt: {
          ...freshAttempt(),
          state: 'running',
          sessionId: 'NEW-sess',
          runningSince: '2026-06-15T03:00:00Z',
        },
      }),
    );
    // Stale snapshot: same id, but an OLD dead session past its grace window.
    const stale = {
      ...onDisk,
      attempt: { ...onDisk.attempt, sessionId: 'OLD-sess', runningSince: '2026-06-14T00:00:00Z' },
    };
    const out = await reapStale([stale], {
      now: () => new Date('2026-06-15T05:00:00Z'),
      isSessionLive: () => false,
    });
    expect(out.completed).toEqual([]);
    expect((await readJob(onDisk.id))?.attempt.state).toBe('running'); // not clobbered
  });
});
