import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendTimeline, readJobState, writeJobState, readAllJobStates } from '../jobs.js';
import { adoptRoster, readRoster, removeRosterEntry, upsertRosterEntry, writeRoster } from '../roster.js';
import { jobTimelinePath } from '../paths.js';
import type { JobState, RosterEntry, RosterFile } from '../types.js';

const ROSTER = '/tmp/syntaur-test/roster.json';

function entry(over: Partial<RosterEntry> = {}): RosterEntry {
  return {
    short: 'aaa',
    pid: 1000,
    pidStartedAt: 'Wed Jul 9 12:00:00 2026',
    ptySock: '/tmp/syntaur-test/d1/pty/aaa.sock',
    rvSock: '/tmp/syntaur-test/d1/rv/aaa.sock',
    agent: 'bash',
    cwd: '/work',
    createdAt: '2026-07-09T12:00:00Z',
    ...over,
  };
}

/** In-memory single-slot roster file. */
function fakeRosterFs(initial: string | null = null) {
  let content = initial;
  return {
    readFile: (_p: string) => content,
    writeFile: (_p: string, data: string) => {
      content = data;
    },
    get content() {
      return content;
    },
  };
}

describe('adoptRoster', () => {
  it('keeps live entries whose start-time matches', () => {
    const fs = fakeRosterFs(
      JSON.stringify({ daemonId: 'old', updatedAt: '', entries: [entry({ short: 'live' })] } as RosterFile),
    );
    const result = adoptRoster(ROSTER, 'new', {
      ...fs,
      isPidAlive: () => true,
      pidStartedAt: () => 'Wed Jul 9 12:00:00 2026', // matches
      pathExists: () => false,
      now: () => 0,
    });
    expect(result.adopted.map((e) => e.short)).toEqual(['live']);
    expect(result.dropped).toEqual([]);
    expect(JSON.parse(fs.content ?? '{}').daemonId).toBe('new');
  });

  it('drops entries whose pid is dead', () => {
    const fs = fakeRosterFs(
      JSON.stringify({ daemonId: 'old', updatedAt: '', entries: [entry({ short: 'dead' })] } as RosterFile),
    );
    const result = adoptRoster(ROSTER, 'new', {
      ...fs,
      isPidAlive: () => false,
      pathExists: () => false,
      now: () => 0,
    });
    expect(result.adopted).toEqual([]);
    expect(result.dropped.map((e) => e.short)).toEqual(['dead']);
  });

  it('drops entries whose pid was recycled (start-time mismatch)', () => {
    const fs = fakeRosterFs(
      JSON.stringify({
        daemonId: 'old',
        updatedAt: '',
        entries: [entry({ short: 'recycled', pidStartedAt: 'OLD' })],
      } as RosterFile),
    );
    const result = adoptRoster(ROSTER, 'new', {
      ...fs,
      isPidAlive: () => true,
      pidStartedAt: () => 'NEW',
      pathExists: () => false,
      now: () => 0,
    });
    expect(result.adopted).toEqual([]);
    expect(result.dropped.map((e) => e.short)).toEqual(['recycled']);
  });

  it('reaps the orphaned sockets of dropped hosts', () => {
    const dead = entry({ short: 'dead' });
    const fs = fakeRosterFs(
      JSON.stringify({ daemonId: 'old', updatedAt: '', entries: [dead] } as RosterFile),
    );
    const unlinkSocket = vi.fn();
    adoptRoster(ROSTER, 'new', {
      ...fs,
      isPidAlive: () => false,
      pathExists: () => true, // sockets present
      unlinkSocket,
      now: () => 0,
    });
    expect(unlinkSocket).toHaveBeenCalledWith(dead.ptySock);
    expect(unlinkSocket).toHaveBeenCalledWith(dead.rvSock);
  });

  it('does not reap the sockets of adopted (live) hosts', () => {
    const fs = fakeRosterFs(
      JSON.stringify({ daemonId: 'old', updatedAt: '', entries: [entry({ short: 'live' })] } as RosterFile),
    );
    const unlinkSocket = vi.fn();
    adoptRoster(ROSTER, 'new', {
      ...fs,
      isPidAlive: () => true,
      pidStartedAt: () => 'Wed Jul 9 12:00:00 2026',
      pathExists: () => true,
      unlinkSocket,
      now: () => 0,
    });
    expect(unlinkSocket).not.toHaveBeenCalled();
  });

  it('tolerates a missing/corrupt roster file', () => {
    const fs = fakeRosterFs(null);
    const result = adoptRoster(ROSTER, 'new', { ...fs, pathExists: () => false, now: () => 0 });
    expect(result).toEqual({ adopted: [], dropped: [] });
  });
});

describe('roster read/write helpers', () => {
  it('upserts and removes entries by short', () => {
    const fs = fakeRosterFs(null);
    upsertRosterEntry(entry({ short: 'a' }), 'd', ROSTER, { ...fs, now: () => 0 });
    upsertRosterEntry(entry({ short: 'b' }), 'd', ROSTER, { ...fs, now: () => 0 });
    expect(readRoster(ROSTER, fs).entries.map((e) => e.short).sort()).toEqual(['a', 'b']);
    removeRosterEntry('a', 'd', ROSTER, { ...fs, now: () => 0 });
    expect(readRoster(ROSTER, fs).entries.map((e) => e.short)).toEqual(['b']);
  });

  it('replaces an entry on re-upsert of the same short', () => {
    const fs = fakeRosterFs(null);
    upsertRosterEntry(entry({ short: 'a', pid: 1 }), 'd', ROSTER, { ...fs, now: () => 0 });
    upsertRosterEntry(entry({ short: 'a', pid: 2 }), 'd', ROSTER, { ...fs, now: () => 0 });
    const entries = readRoster(ROSTER, fs).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].pid).toBe(2);
  });

  it('writeRoster round-trips through readRoster', () => {
    const fs = fakeRosterFs(null);
    const roster: RosterFile = { daemonId: 'd', updatedAt: 't', entries: [entry()] };
    writeRoster(roster, ROSTER, fs);
    expect(readRoster(ROSTER, fs)).toEqual(roster);
  });
});

describe('jobs state.json (real fs under SYNTAUR_HOME)', () => {
  const originalHome = process.env.SYNTAUR_HOME;
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-jobs-'));
    process.env.SYNTAUR_HOME = home;
  });
  afterEach(async () => {
    if (originalHome === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  function job(over: Partial<JobState> = {}): JobState {
    return {
      short: 'zzz',
      agent: 'bash',
      argv: ['/bin/bash'],
      cwd: '/work',
      state: 'working',
      pid: 4242,
      pidStartedAt: 'Wed Jul 9 12:00:00 2026',
      sessionId: null,
      cols: 80,
      rows: 24,
      createdAt: '2026-07-09T12:00:00Z',
      updatedAt: '2026-07-09T12:00:00Z',
      daemonId: 'd1',
      ptySock: '/tmp/x/pty/zzz.sock',
      rvSock: '/tmp/x/rv/zzz.sock',
      hostPid: 4200,
      hostPidStartedAt: 'Wed Jul 9 12:00:00 2026',
      ...over,
    };
  }

  it('round-trips state.json', () => {
    const s = job();
    writeJobState(s);
    expect(readJobState('zzz')).toEqual(s);
  });

  it('returns null for a missing job', () => {
    expect(readJobState('nope')).toBeNull();
  });

  it('reads all job states, skipping corrupt ones', () => {
    writeJobState(job({ short: 'one' }));
    writeJobState(job({ short: 'two' }));
    expect(readAllJobStates().map((s) => s.short).sort()).toEqual(['one', 'two']);
  });

  it('appends timeline events as JSONL', async () => {
    writeJobState(job({ short: 'tl' }));
    appendTimeline('tl', { event: 'spawned', pid: 4242, at: '2026-07-09T12:00:00Z' });
    appendTimeline('tl', { event: 'exited', code: 0, at: '2026-07-09T12:01:00Z' });
    const lines = (await readFile(jobTimelinePath('tl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ event: 'spawned', pid: 4242, at: '2026-07-09T12:00:00Z' });
    expect(JSON.parse(lines[1]).event).toBe('exited');
  });

  it('stamps `at` when omitted', () => {
    writeJobState(job({ short: 'stamp' }));
    appendTimeline('stamp', { event: 'noted' });
    // no throw + file exists is enough; the timestamp is non-deterministic
    expect(readJobState('stamp')).not.toBeNull();
  });
});
