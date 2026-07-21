import { describe, it, expect, vi } from 'vitest';
import {
  buildDispatchRequest, canInjectClaudeSessionId, injectSessionIdArgs, launchSyntaurd,
  type DispatchRequest,
} from '../launch.js';
import type { AgentConfig } from '../../../utils/config.js';
import type { ControlRequest, JobState } from '../../../daemon/types.js';

const plan = { command: 'codex', args: ['hi', '--flag'], cwd: '/repo/.worktrees/feat' };
const claudeAgent: AgentConfig = { id: 'claude', label: 'Claude', command: 'claude' };
const codexAgent: AgentConfig = { id: 'codex', label: 'Codex', command: 'codex' };

describe('buildDispatchRequest', () => {
  it('maps {command,args,cwd} onto the flat dispatch payload', () => {
    expect(
      buildDispatchRequest(plan, { name: 'proj/a1', agentId: 'codex', sessionId: 'uuid-1', cols: 120, rows: 40 }),
    ).toEqual({
      op: 'dispatch',
      argv: ['codex', 'hi', '--flag'],
      cwd: '/repo/.worktrees/feat',
      name: 'proj/a1',
      agent: 'codex',
      sessionId: 'uuid-1',
      env: { SYNTAUR_LAUNCH_ID: 'uuid-1', SYNTAUR_HOSTED_BY: 'syntaurd' },
      cols: 120,
      rows: 40,
    });
  });
});

describe('canInjectClaudeSessionId', () => {
  it('true for a plain claude agent', () => {
    expect(canInjectClaudeSessionId(claudeAgent)).toBe(true);
  });
  it('false for a shell-alias claude agent (argv is $SHELL -i -c <quoted>)', () => {
    expect(canInjectClaudeSessionId({ ...claudeAgent, resolveFromShellAliases: true })).toBe(false);
  });
  it('false for a non-claude runner', () => {
    expect(canInjectClaudeSessionId(codexAgent)).toBe(false);
  });
});

describe('injectSessionIdArgs', () => {
  it('prepends --session-id <uuid>, preserving existing args verbatim', () => {
    expect(injectSessionIdArgs(['/grab-assignment p a', '--agent', 'b'], 'uuid-1')).toEqual([
      '--session-id', 'uuid-1', '/grab-assignment p a', '--agent', 'b',
    ]);
  });
});

describe('launchSyntaurd', () => {
  // overrides typed like actions.test.ts's deps() factory (Partial of the
  // real input) so the type gate stays green; tests that need to INSPECT a
  // mock create it locally and pass it in.
  function harness(overrides: Partial<Parameters<typeof launchSyntaurd>[0]> = {}) {
    return {
      plan,
      name: 'proj/a1',
      agent: codexAgent,
      projectSlug: 'proj',
      assignmentSlug: 'a1',
      cols: 100,
      rows: 30,
      request: vi.fn(async () => ({ ok: true as const, short: 'ab12cd34', pid: 4242 })),
      registerRow: vi.fn(async () => {}),
      generateSessionId: () => 'uuid-fixed',
      now: () => '2026-07-16T00:00:00.000Z',
      // Default: the disambiguation probe finds nothing (it is only consulted
      // when the dispatch request itself rejects).
      findSession: vi.fn(async () => null),
      pidStartedAt: () => 'Thu Jul 16 00:00:00 2026',
      // Reservation + durable-jobs-dir seams (Task 16). Defaults: reserve
      // succeeds (today's dispatch-first behavior stays reachable via
      // overrides), the jobs dir is empty, host identity reads 'alive'
      // (irrelevant when nothing is found), and the poll's sleep is instant.
      reservation: {
        reserve: vi.fn(() => true),
        markDispatched: vi.fn(() => {}),
        cancel: vi.fn(() => {}),
      },
      readJobStates: vi.fn((): JobState[] => []),
      processIdentity: vi.fn(() => 'alive' as const),
      sleep: vi.fn(async () => {}),
      ...overrides,
    };
  }

  /** A durable jobs-dir record for the ambiguous-recovery poll. */
  function jobStateFixture(overrides: Partial<JobState> = {}): JobState {
    return {
      short: 'jj11kk22',
      agent: 'codex',
      argv: ['codex', 'hi', '--flag'],
      cwd: '/repo/.worktrees/feat',
      state: 'working',
      pid: 999,
      pidStartedAt: null,
      sessionId: 'uuid-fixed',
      cols: 100,
      rows: 30,
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      daemonId: 'd1',
      ptySock: '/tmp/jj11kk22.pty.sock',
      rvSock: '/tmp/jj11kk22.rv.sock',
      hostPid: 888,
      hostPidStartedAt: 'START',
      ...overrides,
    };
  }

  it('dispatches the mapped payload with the generated sessionId (seam — no spawn)', async () => {
    const h = harness();
    const result = await launchSyntaurd(h);
    expect(h.request).toHaveBeenCalledWith({
      op: 'dispatch',
      argv: ['codex', 'hi', '--flag'],
      cwd: '/repo/.worktrees/feat',
      name: 'proj/a1',
      agent: 'codex',
      sessionId: 'uuid-fixed',
      env: { SYNTAUR_LAUNCH_ID: 'uuid-fixed', SYNTAUR_HOSTED_BY: 'syntaurd' },
      cols: 100,
      rows: 30,
    });
    expect(result).toEqual({ short: 'ab12cd34', sessionId: 'uuid-fixed', registered: true });
  });

  it('pre-inserts the session-db row keyed by the SAME sessionId, hostedBy syntaurd, pid = host pid', async () => {
    const h = harness();
    await launchSyntaurd(h);
    expect(h.registerRow).toHaveBeenCalledWith('', {
      sessionId: 'uuid-fixed',
      agent: 'codex',
      started: '2026-07-16T00:00:00.000Z',
      status: 'active',
      path: '/repo/.worktrees/feat',
      pid: 4242,
      pidStartedAt: 'Thu Jul 16 00:00:00 2026',
      projectSlug: 'proj',
      assignmentSlug: 'a1',
      hostedBy: 'syntaurd',
    });
  });

  it('captures pid_started_at so a recycled pid cannot keep a dead row alive', async () => {
    // The scanner's recycle guard short-circuits on a NULL baseline
    // (`!row.pid_started_at || …`), so a null here would make a reused pid
    // read as live forever.
    const h = harness();
    await launchSyntaurd(h);
    const row = (h.registerRow as unknown as { mock: { calls: Array<[string, { pidStartedAt: string | null }]> } }).mock.calls[0][1];
    expect(row.pidStartedAt).toBe('Thu Jul 16 00:00:00 2026');
    expect(row.pidStartedAt).not.toBeNull();
  });

  it('throws on an ErrorReply and does NOT insert a row', async () => {
    const h = harness({ request: vi.fn(async () => ({ ok: false as const, code: 'EEMPTYARGV', error: 'boom' })) });
    await expect(launchSyntaurd(h)).rejects.toThrow(/daemon dispatch failed/);
    expect(h.registerRow).not.toHaveBeenCalled();
  });

  it('an ErrorReply does NOT consult the probe — the daemon already said nothing spawned', async () => {
    const findSession = vi.fn(async () => null);
    const h = harness({
      request: vi.fn(async () => ({ ok: false as const, code: 'EEMPTYARGV', error: 'boom' })),
      findSession,
    });
    await expect(launchSyntaurd(h)).rejects.toThrow(/daemon dispatch failed/);
    expect(findSession).not.toHaveBeenCalled();
  });

  it('a LOST REPLY whose session actually landed resolves instead of degrading (no double launch)', async () => {
    // sendRequest is one-shot and can reject after the supervisor already
    // spawned the session. Throwing here would degrade down the ladder and
    // start a SECOND agent in the same worktree.
    const h = harness({
      request: vi.fn(async () => { throw new Error('socket hang up'); }),
      findSession: vi.fn(async () => ({ short: 'landed99', pid: 777, pidStartedAt: 'Thu Jul 16 01:00:00 2026' })),
    });
    await expect(launchSyntaurd(h)).resolves.toEqual({
      short: 'landed99', // adopted from the probe, not the (lost) reply
      sessionId: 'uuid-fixed',
      registered: true,
    });
    expect(h.registerRow).toHaveBeenCalledWith('', expect.objectContaining({
      pid: 777,
      pidStartedAt: 'Thu Jul 16 01:00:00 2026', // the daemon's own spawn capture
      hostedBy: 'syntaurd',
    }));
  });

  it('a lost reply whose session did NOT land still degrades to the next tier', async () => {
    const err = new Error('daemon start timeout');
    const h = harness({
      request: vi.fn(async () => { throw err; }),
      findSession: vi.fn(async () => null),
    });
    await expect(launchSyntaurd(h)).rejects.toThrow(err);
    expect(h.registerRow).not.toHaveBeenCalled();
  });

  it('an unusable probe degrades rather than assuming success, surfacing the ORIGINAL error', async () => {
    const h = harness({
      request: vi.fn(async () => { throw new Error('socket hang up'); }),
      findSession: vi.fn(async () => { throw new Error('probe exploded'); }),
    });
    await expect(launchSyntaurd(h)).rejects.toThrow(/socket hang up/);
    expect(h.registerRow).not.toHaveBeenCalled();
  });

  it('retries registration once, then resolves registered:false (never double-launch, never silent)', async () => {
    const registerRow = vi.fn(async () => { throw new Error('db locked'); });
    const h = harness({ registerRow });
    await expect(launchSyntaurd(h)).resolves.toEqual({ short: 'ab12cd34', sessionId: 'uuid-fixed', registered: false });
    expect(registerRow).toHaveBeenCalledTimes(2); // initial + one bounded retry
  });

  it('a transient registration failure recovers on the retry (registered:true)', async () => {
    const registerRow = vi.fn()
      .mockRejectedValueOnce(new Error('db locked'))
      .mockResolvedValueOnce(undefined);
    const h = harness({ registerRow });
    await expect(launchSyntaurd(h)).resolves.toEqual({ short: 'ab12cd34', sessionId: 'uuid-fixed', registered: true });
    expect(registerRow).toHaveBeenCalledTimes(2);
  });

  it('injects --session-id into a plain claude plan argv', async () => {
    // Typed param so `request.mock.calls[0][0]` is inspectable (an untyped
    // `vi.fn(async () => …)` infers a zero-length tuple for its call args).
    const request = vi.fn(async (_req: ControlRequest) => ({ ok: true as const, short: 'ab12cd34', pid: 4242 }));
    await launchSyntaurd(harness({ request, agent: claudeAgent, plan: { command: 'claude', args: ['hi'], cwd: '/x' } }));
    const req = request.mock.calls[0][0] as unknown as DispatchRequest;
    expect(req.argv).toEqual(['claude', '--session-id', 'uuid-fixed', 'hi']);
  });

  it('leaves a shell-alias claude plan argv untouched', async () => {
    const aliasAgent: AgentConfig = { ...claudeAgent, resolveFromShellAliases: true };
    // Typed param so `request.mock.calls[0][0]` is inspectable (an untyped
    // `vi.fn(async () => …)` infers a zero-length tuple for its call args).
    const request = vi.fn(async (_req: ControlRequest) => ({ ok: true as const, short: 'ab12cd34', pid: 4242 }));
    await launchSyntaurd(harness({ request, agent: aliasAgent, plan: { command: '/bin/zsh', args: ['-i', '-c', "claude 'hi'"], cwd: '/x' } }));
    const req = request.mock.calls[0][0] as unknown as DispatchRequest;
    expect(req.argv).toEqual(['/bin/zsh', '-i', '-c', "claude 'hi'"]);
  });

  describe('pending-launch reservation (Phase C Task 16)', () => {
    it('(a) reserves BEFORE dispatching, binding expectedSessionId when --session-id is injectable', async () => {
      const reserve = vi.fn(() => true);
      const registerRow = vi.fn(async () => {});
      let registerRowCallsAtRequestTime = -1;
      const request = vi.fn(async (_req: ControlRequest) => {
        registerRowCallsAtRequestTime = registerRow.mock.calls.length;
        return { ok: true as const, short: 'ab12cd34', pid: 4242 };
      });
      const h = harness({
        agent: claudeAgent,
        plan: { command: 'claude', args: ['hi'], cwd: '/x' },
        request,
        registerRow,
        reservation: { reserve, markDispatched: vi.fn(), cancel: vi.fn() },
      });
      await launchSyntaurd(h);
      expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]);
      expect(reserve).toHaveBeenCalledWith({
        launchId: 'uuid-fixed',
        hostedBy: 'syntaurd',
        agent: 'claude',
        cwd: '/x',
        expectedSessionId: 'uuid-fixed',
      });
      // No sessions write of any kind before the dispatch reply/recovery
      // resolves — registerRow must still be at zero calls when `request` fires.
      expect(registerRowCallsAtRequestTime).toBe(0);
    });

    it('(a) binds expectedSessionId to null when --session-id is NOT injectable', async () => {
      const reserve = vi.fn(() => true);
      const h = harness({
        agent: codexAgent, // non-claude runner — not injectable
        reservation: { reserve, markDispatched: vi.fn(), cancel: vi.fn() },
      });
      await launchSyntaurd(h);
      expect(reserve).toHaveBeenCalledWith({
        launchId: 'uuid-fixed',
        hostedBy: 'syntaurd',
        agent: 'codex',
        cwd: '/repo/.worktrees/feat',
        expectedSessionId: null,
      });
    });

    it('(b) marks the reservation dispatched immediately before the request is sent', async () => {
      const markDispatched = vi.fn();
      const request = vi.fn(async (_req: ControlRequest) => ({ ok: true as const, short: 'ab12cd34', pid: 4242 }));
      const h = harness({
        request,
        reservation: { reserve: vi.fn(() => true), markDispatched, cancel: vi.fn() },
      });
      await launchSyntaurd(h);
      expect(markDispatched).toHaveBeenCalledWith('uuid-fixed');
      expect(markDispatched.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]);
    });

    it('(c) an ErrorReply cancels the reservation, throws, and registers no row', async () => {
      const cancel = vi.fn();
      const h = harness({
        request: vi.fn(async () => ({ ok: false as const, code: 'EEMPTYARGV', error: 'boom' })),
        reservation: { reserve: vi.fn(() => true), markDispatched: vi.fn(), cancel },
      });
      await expect(launchSyntaurd(h)).rejects.toThrow(/daemon dispatch failed/);
      expect(cancel).toHaveBeenCalledWith('uuid-fixed');
      expect(h.registerRow).not.toHaveBeenCalled();
    });

    it('(d) ambiguous rejection + null probe + a live host in the jobs-dir scan adopts (no double launch)', async () => {
      const cancel = vi.fn();
      const processIdentitySpy = vi.fn(() => 'alive' as const);
      const readJobStates = vi.fn(() => [jobStateFixture({ state: 'working', hostPid: 888, hostPidStartedAt: 'START' })]);
      const h = harness({
        request: vi.fn(async () => { throw new Error('socket hang up'); }),
        findSession: vi.fn(async () => null),
        readJobStates,
        processIdentity: processIdentitySpy,
        reservation: { reserve: vi.fn(() => true), markDispatched: vi.fn(), cancel },
      });
      await expect(launchSyntaurd(h)).resolves.toEqual({
        short: 'jj11kk22',
        sessionId: 'uuid-fixed',
        registered: true,
      });
      expect(processIdentitySpy).toHaveBeenCalledWith(888, 'START');
      expect(h.registerRow).toHaveBeenCalledWith('', expect.objectContaining({ pid: 888, pidStartedAt: 'START' }));
      expect(cancel).not.toHaveBeenCalled();
    });

    it.each(['dead', 'unknown'] as const)(
      '(d2) a jobs-dir hit with host identity %s is NOT adopted (TRUST gate) — cancels + degrades with the original error',
      async (identity) => {
        const cancel = vi.fn();
        const err = new Error('socket hang up');
        const readJobStates = vi.fn(() => [jobStateFixture()]);
        const h = harness({
          request: vi.fn(async () => { throw err; }),
          findSession: vi.fn(async () => null),
          readJobStates,
          processIdentity: vi.fn(() => identity),
          reservation: { reserve: vi.fn(() => true), markDispatched: vi.fn(), cancel },
        });
        await expect(launchSyntaurd(h)).rejects.toThrow(err);
        expect(cancel).toHaveBeenCalledWith('uuid-fixed');
        expect(h.registerRow).not.toHaveBeenCalled();
      },
    );

    it('(d3) a delayed job-state write inside the poll window still adopts (review r3 F1)', async () => {
      // readJobStates misses on the first two scans (the host's spawn->first-
      // write startup gap) and only lands on the third — a single scan would
      // have missed this and double-launched.
      const cancel = vi.fn();
      const readJobStates = vi
        .fn<() => JobState[]>()
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValue([jobStateFixture()]);
      const sleep = vi.fn(async () => {});
      const h = harness({
        request: vi.fn(async () => { throw new Error('socket hang up'); }),
        findSession: vi.fn(async () => null),
        readJobStates,
        processIdentity: vi.fn(() => 'alive' as const),
        sleep,
        reservation: { reserve: vi.fn(() => true), markDispatched: vi.fn(), cancel },
      });
      await expect(launchSyntaurd(h)).resolves.toEqual({
        short: 'jj11kk22',
        sessionId: 'uuid-fixed',
        registered: true,
      });
      expect(cancel).not.toHaveBeenCalled();
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(100); // JOBS_SCAN_INTERVAL_MS
    });

    it('(e) a jobs-dir hit with only a TERMINAL state polls the full window then degrades', async () => {
      const cancel = vi.fn();
      const err = new Error('socket hang up');
      const readJobStates = vi.fn(() => [jobStateFixture({ state: 'failed' })]);
      const processIdentitySpy = vi.fn(() => 'alive' as const);
      const h = harness({
        request: vi.fn(async () => { throw err; }),
        findSession: vi.fn(async () => null),
        readJobStates,
        processIdentity: processIdentitySpy,
        reservation: { reserve: vi.fn(() => true), markDispatched: vi.fn(), cancel },
      });
      await expect(launchSyntaurd(h)).rejects.toThrow(err);
      expect(readJobStates).toHaveBeenCalledTimes(20); // JOBS_SCAN_ATTEMPTS — full window
      // The terminal-state row never matches the scan predicate, so the
      // liveness gate is never consulted for it.
      expect(processIdentitySpy).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledWith('uuid-fixed');
      expect(h.registerRow).not.toHaveBeenCalled();
    });

    it('(h) a failed reserve (returns false) proceeds with legacy dispatch-first semantics', async () => {
      const h = harness({
        reservation: { reserve: vi.fn(() => false), markDispatched: vi.fn(), cancel: vi.fn() },
      });
      await expect(launchSyntaurd(h)).resolves.toEqual({
        short: 'ab12cd34',
        sessionId: 'uuid-fixed',
        registered: true,
      });
      expect(h.registerRow).toHaveBeenCalledWith(
        '',
        expect.objectContaining({ sessionId: 'uuid-fixed', hostedBy: 'syntaurd' }),
      );
    });
  });
});
