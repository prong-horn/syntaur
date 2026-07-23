import { describe, expect, it } from 'vitest';
import { resolveShortForSession } from '../daemon-join.js';
import type { JobState, ListReply, Session, SessionState } from '../../daemon/types.js';

function session(over: Partial<Session> & { short: string; sessionId: string | null; state: SessionState }): Session {
  return {
    agent: 'codex',
    argv: ['codex'],
    cwd: '/tmp',
    pid: 111,
    pidStartedAt: null,
    cols: 80,
    rows: 24,
    createdAt: '2026-07-22T00:00:00Z',
    ...over,
  };
}

function jobState(over: Partial<JobState> & { short: string; sessionId: string | null; state: SessionState }): JobState {
  return {
    ...session(over),
    updatedAt: '2026-07-22T00:00:00Z',
    daemonId: 'd1',
    ptySock: `/tmp/${over.short}.pty.sock`,
    rvSock: `/tmp/${over.short}.rv.sock`,
    hostPid: 222,
    hostPidStartedAt: null,
    ...over,
  };
}

const list = (sessions: Session[]): ListReply => ({ ok: true, sessions });

describe('resolveShortForSession', () => {
  it('returns live:true with daemon state/needs/cols/rows for a non-terminal list match', async () => {
    const r = await resolveShortForSession('sess-A', {
      query: async () => list([session({ short: 'ab12', sessionId: 'sess-A', state: 'blocked', needs: 'approve?', cols: 120, rows: 40 })]),
      readAllJobStates: () => [],
      readJobState: () => null,
    });
    expect(r).toEqual({ short: 'ab12', state: 'blocked', needs: 'approve?', cols: 120, rows: 40, live: true });
  });

  it('classifies a terminal list match as not-live and reads its jobState (not attachable)', async () => {
    const js = jobState({ short: 'cd34', sessionId: 'sess-B', state: 'done', lastScreen: 'bye' });
    const r = await resolveShortForSession('sess-B', {
      query: async () => list([session({ short: 'cd34', sessionId: 'sess-B', state: 'done' })]),
      readAllJobStates: () => [],
      readJobState: (short) => (short === 'cd34' ? js : null),
    });
    expect(r).toEqual({ short: 'cd34', state: 'done', live: false, jobState: js });
  });

  it('falls back to disk when queryDaemon returns null (daemon down)', async () => {
    const js = jobState({ short: 'ef56', sessionId: 'sess-C', state: 'failed', lastScreen: 'boom' });
    const r = await resolveShortForSession('sess-C', {
      query: async () => null,
      readAllJobStates: () => [js],
      readJobState: () => null,
    });
    expect(r).toEqual({ short: 'ef56', state: 'failed', live: false, jobState: js });
  });

  it('falls back to disk when queryDaemon REJECTS (does not throw out)', async () => {
    const js = jobState({ short: 'gh78', sessionId: 'sess-D', state: 'working' });
    const r = await resolveShortForSession('sess-D', {
      query: async () => {
        throw new Error('ECONNREFUSED');
      },
      readAllJobStates: () => [js],
      readJobState: () => null,
    });
    expect(r).toEqual({ short: 'gh78', state: 'working', live: false, jobState: js });
  });

  it('uses disk when the list has no matching live session but disk holds a terminal state', async () => {
    const js = jobState({ short: 'ij90', sessionId: 'sess-E', state: 'stopped' });
    const r = await resolveShortForSession('sess-E', {
      query: async () => list([session({ short: 'zz00', sessionId: 'other', state: 'working' })]),
      readAllJobStates: () => [js],
      readJobState: () => null,
    });
    expect(r).toEqual({ short: 'ij90', state: 'stopped', live: false, jobState: js });
  });

  it('returns null when neither source knows the sessionId', async () => {
    const r = await resolveShortForSession('nope', {
      query: async () => list([]),
      readAllJobStates: () => [],
      readJobState: () => null,
    });
    expect(r).toBeNull();
  });

  it('skips null/empty-sessionId entries in both list and disk scans', async () => {
    const r = await resolveShortForSession('sess-F', {
      query: async () => list([session({ short: 'nul1', sessionId: null, state: 'working' })]),
      readAllJobStates: () => [jobState({ short: 'nul2', sessionId: null, state: 'working' })],
      readJobState: () => null,
    });
    expect(r).toBeNull();
  });
});
