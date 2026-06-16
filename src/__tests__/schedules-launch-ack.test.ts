import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitLaunchAck, defaultAckProbe } from '../schedules/launch-ack.js';
import { writeRuntimeMarker } from '../utils/session-id.js';
import type { LaunchHandle } from '../launch/execute.js';

function handle(cwd = '/work/repo'): LaunchHandle {
  return {
    pid: 1234,
    startedAt: '2026-06-15T03:00:00Z',
    // Only `cwd` is read by the probe; the rest of the plan is irrelevant here.
    plan: { cwd } as LaunchHandle['plan'],
  };
}

/** Fake clock whose `sleep` advances time, so the poll loop is deterministic. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('awaitLaunchAck', () => {
  it('acks immediately when the probe sees a session', async () => {
    const clock = fakeClock();
    const res = await awaitLaunchAck(handle(), 90_000, { ...clock, probe: () => 's-1' });
    expect(res).toEqual({ acked: true, sessionId: 's-1' });
  });

  it('acks once the probe flips to a session mid-poll', async () => {
    const clock = fakeClock();
    let calls = 0;
    const res = await awaitLaunchAck(handle(), 90_000, {
      ...clock,
      pollIntervalMs: 1000,
      probe: () => (++calls >= 3 ? 's-2' : null),
    });
    expect(res.acked).toBe(true);
    expect(res.sessionId).toBe('s-2');
  });

  it('times out → launch_failed signal (no ack)', async () => {
    const clock = fakeClock();
    const res = await awaitLaunchAck(handle(), 5_000, {
      ...clock,
      pollIntervalMs: 1000,
      probe: () => null, // never comes up
    });
    expect(res.acked).toBe(false);
    expect(res.sessionId).toBeUndefined();
  });
});

describe('defaultAckProbe', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-ack-'));
    process.env.SYNTAUR_RUNTIME_SESSIONS_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.SYNTAUR_RUNTIME_SESSIONS_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('ignores a pending marker (no sessionId) and acks a real one', async () => {
    // Pending marker — no sessionId; must NOT ack.
    writeRuntimeMarker(4321, { agent: 'claude', cwd: '/work/repo', writtenAt: Date.parse('2026-06-15T03:00:05Z') }, dir);
    expect(defaultAckProbe(handle())).toBeNull();

    // Real marker for the agent's own pid in the same cwd, written after launch.
    writeRuntimeMarker(4322, { sessionId: 'real-1', agent: 'claude', cwd: '/work/repo', writtenAt: Date.parse('2026-06-15T03:00:06Z') }, dir);
    expect(defaultAckProbe(handle())).toBe('real-1');
  });

  it('does not match a marker from a different cwd', async () => {
    writeRuntimeMarker(5555, { sessionId: 'other', cwd: '/elsewhere', writtenAt: Date.parse('2026-06-15T03:00:06Z') }, dir);
    expect(defaultAckProbe(handle('/work/repo'))).toBeNull();
  });
});
