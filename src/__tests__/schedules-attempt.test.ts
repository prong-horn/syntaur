import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimJob,
  markDispatching,
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
import { readEvents } from '../schedules/event-log.js';
import { evaluateTrigger } from '../schedules/triggers.js';
import { freshAttempt } from '../schedules/types.js';
import { sampleJob } from './schedules-helpers.js';

const fixedNow = (iso: string): AttemptDeps => ({ now: () => new Date(iso) });

// File-scoped so EVERY describe below writes into a throwaway dir — a describe
// without this override lands its jobs in the real `~/.syntaur/schedules`.
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'syntaur-attempt-'));
  process.env.SYNTAUR_SCHEDULES_DIR = dir;
});
afterEach(async () => {
  delete process.env.SYNTAUR_SCHEDULES_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe('attempt state machine', () => {

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

  it('reaps a dispatching job whose claim lease expired → dispatch_failed', async () => {
    let job = await writeJob(sampleJob());
    const claim = await claimJob(job, { dedupeKey: 'e' }, fixedNow('2026-06-15T03:00:00Z'));
    if (!claim.claimed) throw new Error('expected claim');
    job = await markDispatching(claim.job, 'msg-1', fixedNow('2026-06-15T03:00:00Z'));
    expect(job.attempt.messageId).toBe('msg-1');
    // Well past the claim TTL (default 120s).
    const out = await reapStale([await readJob(job.id) as NonNullable<Awaited<ReturnType<typeof readJob>>>], fixedNow('2026-06-15T03:10:00Z'));
    expect(out.reaped).toContain(job.id);
    expect((await readJob(job.id))?.attempt.state).toBe('dispatch_failed');
  });

  it('flags a running job past max-runtime whose turn has ended as stuck (no remediation)', async () => {
    const base = sampleJob({ limits: { ...sampleJob().limits, maxRuntimeMs: 1000 } });
    const job = await writeJob({
      ...base,
      attempt: { ...base.attempt, state: 'running', runningSince: '2026-06-15T03:00:00Z', messageId: 'msg-1' },
    });
    const out = await reapStale([job], {
      now: () => new Date('2026-06-15T03:30:00Z'),
      probeMessageTurn: async () => 'ended',
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

  it('kill from running cancels the turn through the chat; retry re-arms dispatch_failed', async () => {
    const base = sampleJob();
    const running = await writeJob({
      ...base,
      attempt: { ...base.attempt, state: 'running', messageId: 'msg-1' },
    });
    const withdrawn: string[] = [];
    const cancelled: Array<{ assignmentId: string; agentId: string | null }> = [];
    await killJob(running.id, {
      // Already delivered — a withdraw is refused, so kill must fall through
      // to cancelling the running turn.
      withdrawMessage: async (_a, messageId) => {
        withdrawn.push(messageId);
        return false;
      },
      cancelTurn: async (assignmentId, agentId) => {
        cancelled.push({ assignmentId, agentId });
        return true;
      },
    });
    expect(withdrawn).toEqual(['msg-1']);
    expect(cancelled).toEqual([{ assignmentId: base.assignmentId, agentId: base.agentId }]);
    expect((await readJob(running.id))?.attempt.state).toBe('killed');

    const failed = await writeJob({
      ...sampleJob(),
      attempt: { ...base.attempt, state: 'dispatch_failed', lastError: 'x' },
    });
    await retryJob(failed.id);
    expect((await readJob(failed.id))?.attempt.state).toBe('eligible');
  });

  it('kill withdraws a still-queued message and never cancels', async () => {
    const base = sampleJob();
    const dispatching = await writeJob({
      ...base,
      attempt: {
        ...base.attempt,
        state: 'dispatching',
        messageId: 'msg-queued',
        claim: { token: 't', expiresAt: Date.parse('2026-06-15T04:00:00Z') },
      },
    });
    let cancels = 0;
    await killJob(dispatching.id, {
      withdrawMessage: async () => true,
      cancelTurn: async () => {
        cancels += 1;
        return true;
      },
    });
    expect(cancels).toBe(0);
    // Nothing had started, so the job is cancelled rather than killed.
    expect((await readJob(dispatching.id))?.attempt.state).toBe('cancelled');
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

  // AC3: launchDayStamps are pruned to the current day on each dispatch.
  it('prunes launchDayStamps to today (no unbounded growth)', async () => {
    const job = await writeJob(
      sampleJob({
        attempt: {
          ...freshAttempt(),
          state: 'dispatching',
          messageId: 'msg-1',
          launchDayStamps: ['2026-06-01', '2026-06-14'],
          claim: { token: 't', expiresAt: Date.parse('2026-06-15T04:00:00Z') },
        },
      }),
    );
    const after = await markRunning(job, fixedNow('2026-06-15T03:00:00Z'));
    expect(after.attempt.launchDayStamps).toEqual(['2026-06-15']);
    expect(after.attempt.dispatchCount).toBe(1);
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
  it('markRunning is a no-op when the on-disk state is no longer dispatching', async () => {
    const job = await writeJob(
      sampleJob({ attempt: { ...freshAttempt(), state: 'killed' } }),
    );
    const after = await markRunning(job, fixedNow('2026-06-15T03:00:00Z'));
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
          state: 'dispatching',
          claim: { token: 'NEW', expiresAt: Date.parse('2026-06-15T04:00:00Z') },
        },
      }),
    );
    const stale = {
      ...onDisk,
      attempt: { ...onDisk.attempt, claim: { token: 'OLD', expiresAt: Date.parse('2026-06-15T04:00:00Z') } },
    };
    const after = await markRunning(stale, fixedNow('2026-06-15T03:00:00Z'));
    expect(after.attempt.state).toBe('dispatching'); // not advanced
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
          messageId: 'NEW-msg',
          runningSince: '2026-06-15T03:00:00Z',
        },
      }),
    );
    // Stale snapshot: same id, but an OLD ended message past its grace window.
    const stale = {
      ...onDisk,
      attempt: { ...onDisk.attempt, messageId: 'OLD-msg', runningSince: '2026-06-14T00:00:00Z' },
    };
    const out = await reapStale([stale], {
      now: () => new Date('2026-06-15T05:00:00Z'),
      probeMessageTurn: async () => 'ended',
    });
    expect(out.completed).toEqual([]);
    expect((await readJob(onDisk.id))?.attempt.state).toBe('running'); // not clobbered
  });
});

describe('the state-unknown ceiling (code review finding 5)', () => {
  /**
   * `probeMessageTurn` answers `unknown` when the chat cannot be reached, has
   * been reindexed, or never saw the id. Treating that as "still open" is the
   * right DEFAULT — reaping a live job on a missing signal is the failure mode
   * the conservative ordering exists to prevent — but held forever it strands a
   * job in `running` with no way out. The ceiling bounds it: past
   * `stateUnknownCeilingMs` an unknowable job is terminalized rather than left.
   */
  const runningSince = '2026-06-15T03:00:00Z';
  // The clock the ceiling measures runs from the FIRST unknown probe (review
  // round 2, finding 1), so these seed it directly rather than relying on
  // `runningSince`.
  const runningJob = () => ({
    ...sampleJob({ trigger: { kind: 'at' as const, at: '2026-06-14T00:00:00Z' } }),
    attempt: {
      ...freshAttempt(),
      state: 'running' as const,
      messageId: 'msg-unknowable',
      runningSince,
      stateUnknownSince: runningSince,
    },
  });

  it('keeps an unknown-state job running while it is inside the ceiling', async () => {
    const job = await writeJob(runningJob());
    const out = await reapStale([job], {
      now: () => new Date('2026-06-15T04:00:00Z'), // 1h — inside the 2h default
      probeMessageTurn: async () => 'unknown',
    });
    expect(out.reaped).toEqual([]);
    expect((await readJob(job.id))?.attempt.state).toBe('running');
  });

  it('terminalizes an unknown-state job past the ceiling, with reason state_unknown', async () => {
    const job = await writeJob(runningJob());
    const out = await reapStale([job], {
      now: () => new Date('2026-06-15T06:00:00Z'), // 3h — past the 2h default
      probeMessageTurn: async () => 'unknown',
    });
    expect(out.reaped).toContain(job.id);
    const after = await readJob(job.id);
    expect(after?.attempt.state).toBe('dispatch_failed');
    expect(after?.attempt.lastError).toMatch(/state_unknown/);
    const events = await readEvents(job.id);
    expect(events.some((e) => e.type === 'reaped' && (e.data as { reason?: string })?.reason === 'state_unknown')).toBe(true);
  });

  it('honours a configured ceiling', async () => {
    const job = await writeJob(runningJob());
    const out = await reapStale([job], {
      now: () => new Date('2026-06-15T04:00:00Z'), // 1h
      probeMessageTurn: async () => 'unknown',
      stateUnknownCeilingMs: 30 * 60 * 1000, // …but a 30-minute ceiling
    });
    expect(out.reaped).toContain(job.id);
  });

  it('never applies the ceiling to a turn the chat says is genuinely OPEN', async () => {
    const job = await writeJob(runningJob());
    const out = await reapStale([job], {
      now: () => new Date('2026-06-16T03:00:00Z'), // a full day later
      probeMessageTurn: async () => 'open',
    });
    expect(out.reaped).toEqual([]);
    expect((await readJob(job.id))?.attempt.state).toBe('running');
  });
});

describe('the ceiling is measured from the first unknown probe (review round 2, finding 1)', () => {
  /**
   * The release note promises "two hours of unresolvable-state grace". Measured
   * from `runningSince`, a job that ran healthy for 110 minutes and then lost
   * the dashboard would get ten minutes — not two hours. The clock has to start
   * when the state first becomes unknowable, so the attempt records
   * `stateUnknownSince` and the ceiling is measured from that.
   */
  const runningSince = '2026-06-15T03:00:00Z';
  const runningJob = () => ({
    ...sampleJob({ trigger: { kind: 'at' as const, at: '2026-06-14T00:00:00Z' } }),
    attempt: {
      ...freshAttempt(),
      state: 'running' as const,
      messageId: 'msg-unknowable',
      runningSince,
    },
  });

  it('starts the clock at the first unknown probe, not at runningSince', async () => {
    const job = await writeJob(runningJob());
    // 110 minutes of healthy running, then the first unknown probe.
    const firstUnknown = await reapStale([job], {
      now: () => new Date('2026-06-15T04:50:00Z'),
      probeMessageTurn: async () => 'unknown',
    });
    expect(firstUnknown.reaped).toEqual([]);
    const after = await readJob(job.id);
    expect(after?.attempt.state).toBe('running');
    // The moment it became unknowable is persisted, so a restart cannot lose it.
    expect(after?.attempt.stateUnknownSince).toBe('2026-06-15T04:50:00Z');
  });

  it('does NOT terminalize until the ceiling has elapsed since that first probe', async () => {
    const job = await writeJob(runningJob());
    await reapStale([job], {
      now: () => new Date('2026-06-15T04:50:00Z'), // first unknown, t+110m
      probeMessageTurn: async () => 'unknown',
    });
    // t+3h10m overall, but only 80 minutes unknown — inside the 2h ceiling.
    const stillRunning = await reapStale([(await readJob(job.id))!], {
      now: () => new Date('2026-06-15T06:10:00Z'),
      probeMessageTurn: async () => 'unknown',
    });
    expect(stillRunning.reaped).toEqual([]);
    expect((await readJob(job.id))?.attempt.state).toBe('running');

    // t+3h51m overall, 2h1m unknown — past the ceiling.
    const reaped = await reapStale([(await readJob(job.id))!], {
      now: () => new Date('2026-06-15T06:51:00Z'),
      probeMessageTurn: async () => 'unknown',
    });
    expect(reaped.reaped).toContain(job.id);
    const after = await readJob(job.id);
    expect(after?.attempt.state).toBe('dispatch_failed');
    expect(after?.attempt.lastError).toMatch(/state_unknown/);
  });

  it('clears the marker when the chat can answer again, so a blip does not accumulate', async () => {
    const job = await writeJob(runningJob());
    await reapStale([job], {
      now: () => new Date('2026-06-15T03:30:00Z'),
      probeMessageTurn: async () => 'unknown',
    });
    expect((await readJob(job.id))?.attempt.stateUnknownSince).toBe('2026-06-15T03:30:00Z');

    // The dashboard comes back and reports the turn genuinely open.
    await reapStale([(await readJob(job.id))!], {
      now: () => new Date('2026-06-15T03:40:00Z'),
      probeMessageTurn: async () => 'open',
    });
    expect((await readJob(job.id))?.attempt.stateUnknownSince).toBeNull();

    // A later blip therefore starts a FRESH two hours, not a resumed one.
    await reapStale([(await readJob(job.id))!], {
      now: () => new Date('2026-06-15T09:00:00Z'),
      probeMessageTurn: async () => 'unknown',
    });
    expect((await readJob(job.id))?.attempt.state).toBe('running');
    expect((await readJob(job.id))?.attempt.stateUnknownSince).toBe('2026-06-15T09:00:00Z');
  });
});
