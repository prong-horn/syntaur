import { describe, it, expect, vi } from 'vitest';
import {
  buildDispatchRequest, canInjectClaudeSessionId, injectSessionIdArgs, launchSyntaurd,
  type DispatchRequest,
} from '../launch.js';
import type { AgentConfig } from '../../../utils/config.js';
import type { ControlRequest } from '../../../daemon/types.js';

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
});
