import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  formatUrlCommandError,
  formatPlanForApplet,
  emitPlanWarnings,
  urlCommand,
} from '../commands/url.js';
import { OpenUrlError, LaunchError, TerminalNotFoundError, type LaunchPlan } from '../launch/index.js';

// Spy on resolveLaunchPlan so we can assert urlCommand threads parsed.prompt as
// promptOverride without spawning a terminal (printPlan short-circuits execute).
const { resolveLaunchPlanSpy } = vi.hoisted(() => ({ resolveLaunchPlanSpy: vi.fn() }));
vi.mock('../launch/index.js', async (orig) => {
  const actual = await orig<typeof import('../launch/index.js')>();
  return { ...actual, resolveLaunchPlan: resolveLaunchPlanSpy };
});
vi.mock('../dashboard/session-db.js', async (orig) => {
  const actual = await orig<typeof import('../dashboard/session-db.js')>();
  return { ...actual, initSessionDb: () => {} };
});

function makePlan(overrides: Partial<LaunchPlan> = {}): LaunchPlan {
  return {
    terminal: 'terminal-app',
    cwd: '/Users/dev/work',
    argv: { command: 'claude', args: ['Read the README'] },
    env: {},
    agentId: 'claude',
    fallbackWarning: null,
    shellFallbackWarning: null,
    ...overrides,
  };
}

describe('formatUrlCommandError', () => {
  it('formats OpenUrlError with its code', () => {
    const msg = formatUrlCommandError(new OpenUrlError('bad-host', 'wrong host'));
    expect(msg).toContain('bad-host');
    expect(msg).toContain('wrong host');
  });

  it('formats LaunchError with its code', () => {
    const msg = formatUrlCommandError(
      new LaunchError('assignment-not-found', 'missing'),
    );
    expect(msg).toContain('assignment-not-found');
    expect(msg).toContain('missing');
  });

  it('formats TerminalNotFoundError as-is', () => {
    const err = new TerminalNotFoundError('ghostty', 'install Ghostty');
    const msg = formatUrlCommandError(err);
    expect(msg).toContain('ghostty');
    expect(msg).toContain('install Ghostty');
  });

  it('formats unknown errors with a generic prefix', () => {
    const msg = formatUrlCommandError(new Error('boom'));
    expect(msg).toContain('Unexpected error');
    expect(msg).toContain('boom');
  });

  it('formats non-Error throws by stringifying', () => {
    const msg = formatUrlCommandError('weird');
    expect(msg).toContain('Unexpected error');
    expect(msg).toContain('weird');
  });
});

describe('formatPlanForApplet', () => {
  it('emits exactly two lines: terminal id, then cd+command', () => {
    const out = formatPlanForApplet(makePlan({ terminal: 'ghostty' }));
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('ghostty');
    expect(lines[1]).toBe("cd '/Users/dev/work' && 'claude' 'Read the README'");
  });

  it('shell-quotes every argv element exactly once', () => {
    const out = formatPlanForApplet(
      makePlan({ argv: { command: 'claude', args: ['--resume', 'sess-1'] } }),
    );
    expect(out.split('\n')[1]).toBe(
      "cd '/Users/dev/work' && 'claude' '--resume' 'sess-1'",
    );
  });

  it('escapes single quotes inside the cwd', () => {
    const out = formatPlanForApplet(makePlan({ cwd: "/Users/o'malley/work" }));
    // POSIX single-quote escaping: ' → '\''
    expect(out.split('\n')[1]).toContain("'/Users/o'\\''malley/work'");
  });

  it('has no trailing newline', () => {
    const out = formatPlanForApplet(makePlan());
    expect(out.endsWith('\n')).toBe(false);
  });
});

describe('emitPlanWarnings', () => {
  it('emits cwd, shell, then launch-prompt warnings in order, each exactly once', () => {
    const out: string[] = [];
    emitPlanWarnings(
      makePlan({
        fallbackWarning: 'cwd-warn',
        shellFallbackWarning: 'shell-warn',
        promptWarnings: ['prompt-w1', 'prompt-w2'],
      }),
      (m) => out.push(m),
    );
    expect(out).toEqual(['cwd-warn', 'shell-warn', 'prompt-w1', 'prompt-w2']);
  });

  it('emits each promptWarning exactly once', () => {
    const out: string[] = [];
    emitPlanWarnings(makePlan({ promptWarnings: ['only-one'] }), (m) => out.push(m));
    expect(out.filter((m) => m === 'only-one')).toHaveLength(1);
  });

  it('no-ops when there are no warnings (promptWarnings undefined)', () => {
    const out: string[] = [];
    emitPlanWarnings(makePlan(), (m) => out.push(m));
    expect(out).toEqual([]);
  });
});

describe('urlCommand — prompt override threading', () => {
  beforeEach(() => {
    resolveLaunchPlanSpy.mockReset();
    resolveLaunchPlanSpy.mockResolvedValue(makePlan());
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('threads an assignment prompt= as promptOverride', async () => {
    await urlCommand('syntaur://open?assignment=a1&prompt=hello%20world', { printPlan: true });
    expect(resolveLaunchPlanSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'assignment', promptOverride: 'hello world' }),
    );
  });

  it('passes promptOverride: undefined when no prompt= is present', async () => {
    await urlCommand('syntaur://open?assignment=a1', { printPlan: true });
    expect(resolveLaunchPlanSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'assignment', promptOverride: undefined }),
    );
  });

  it('never passes a promptOverride for sessions', async () => {
    await urlCommand('syntaur://open?session=s1&prompt=ignored', { printPlan: true });
    expect(resolveLaunchPlanSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'session', promptOverride: undefined }),
    );
  });
});
