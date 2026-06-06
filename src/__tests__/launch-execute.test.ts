import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  executeLaunchPlan,
  buildShellCommandLine,
  buildTerminalInvocation,
  TerminalNotFoundError,
  type LaunchPlan,
  type SpawnFn,
} from '../launch/index.js';

function makePlan(overrides: Partial<LaunchPlan> = {}): LaunchPlan {
  return {
    terminal: 'terminal-app',
    cwd: '/tmp/work',
    argv: { command: 'claude', args: [] },
    env: {},
    agentId: 'claude',
    fallbackWarning: null,
    shellFallbackWarning: null,
    ...overrides,
  };
}

/**
 * Minimal fake ChildProcess that emits the events `executeLaunchPlan` listens
 * for. Cast to ChildProcess so the SpawnFn type checks; we only implement the
 * surface area the function actually touches.
 */
function fakeChild(opts: {
  fireOn: 'spawn' | 'error' | 'exit';
  exitCode?: number | null;
  errorMessage?: string;
  stderr?: string;
  delayMs?: number;
}) {
  const emitter = new EventEmitter() as EventEmitter & {
    unref: () => void;
    stderr: Readable | null;
  };
  emitter.unref = () => {};
  const stderrStream = opts.stderr
    ? Readable.from([Buffer.from(opts.stderr)])
    : null;
  emitter.stderr = stderrStream;

  setTimeout(() => {
    if (opts.fireOn === 'error') {
      emitter.emit('error', new Error(opts.errorMessage ?? 'ENOENT'));
    } else if (opts.fireOn === 'exit') {
      // Drain stderr first so the data handler sees the bytes before exit.
      if (stderrStream) stderrStream.resume();
      setTimeout(() => emitter.emit('exit', opts.exitCode ?? 1, null), 1);
    } else if (opts.fireOn === 'spawn') {
      emitter.emit('spawn');
    }
  }, opts.delayMs ?? 0);

  return emitter as unknown as ReturnType<SpawnFn>;
}

describe('executeLaunchPlan', () => {
  it('resolves cleanly when a direct CLI launcher emits spawn (alacritty path)', async () => {
    const spawnFn: SpawnFn = () => fakeChild({ fireOn: 'spawn' });
    await expect(
      executeLaunchPlan(makePlan({ terminal: 'alacritty' }), spawnFn),
    ).resolves.toBeUndefined();
  });

  it('throws TerminalNotFoundError when spawn emits error (binary missing)', async () => {
    const spawnFn: SpawnFn = () =>
      fakeChild({ fireOn: 'error', errorMessage: 'spawn alacritty ENOENT' });
    await expect(
      executeLaunchPlan(makePlan({ terminal: 'alacritty' }), spawnFn),
    ).rejects.toThrow(TerminalNotFoundError);
  });

  it('throws TerminalNotFoundError when a wrapper (osascript) exits non-zero', async () => {
    const spawnFn: SpawnFn = () =>
      fakeChild({
        fireOn: 'exit',
        exitCode: 1,
        stderr: 'execution error: Application is not running.',
      });
    await expect(
      executeLaunchPlan(makePlan({ terminal: 'terminal-app' }), spawnFn),
    ).rejects.toThrowError(/exited with code 1/);
  });

  it('resolves when a wrapper exits 0 (osascript succeeded)', async () => {
    const spawnFn: SpawnFn = () =>
      fakeChild({ fireOn: 'exit', exitCode: 0 });
    await expect(
      executeLaunchPlan(makePlan({ terminal: 'terminal-app' }), spawnFn),
    ).resolves.toBeUndefined();
  });

  it('throws TerminalNotFoundError when spawn() itself throws synchronously', async () => {
    const spawnFn: SpawnFn = () => {
      throw new Error('boom');
    };
    await expect(
      executeLaunchPlan(makePlan(), spawnFn),
    ).rejects.toThrow(TerminalNotFoundError);
  });

  it('captures stderr text in the wrapper-failure error message', async () => {
    const spawnFn: SpawnFn = () =>
      fakeChild({
        fireOn: 'exit',
        exitCode: 1,
        stderr: '   line one\nline two   ',
      });
    try {
      await executeLaunchPlan(makePlan({ terminal: 'terminal-app' }), spawnFn);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TerminalNotFoundError);
      expect((err as Error).message).toContain('line one');
    }
  });
});

describe('buildShellCommandLine', () => {
  it('quotes every token: cd, command, and each arg', () => {
    const cmd = buildShellCommandLine(
      makePlan({
        cwd: '/tmp/work',
        argv: { command: 'claude', args: ['--resume', 'sess-xyz'] },
      }),
    );
    expect(cmd).toBe("cd '/tmp/work' && 'claude' '--resume' 'sess-xyz'");
  });

  it('shell-escapes a cwd containing spaces', () => {
    const cmd = buildShellCommandLine(
      makePlan({
        cwd: '/tmp/a b',
        argv: { command: 'claude', args: ['--resume', 'id'] },
      }),
    );
    expect(cmd.startsWith("cd '/tmp/a b' && 'claude'")).toBe(true);
  });

  it('escapes a single quote inside an argument', () => {
    const cmd = buildShellCommandLine(
      makePlan({ cwd: '/w', argv: { command: 'agent', args: ["a'b"] } }),
    );
    // POSIX single-quote escaping: ' -> '\''
    expect(cmd).toBe("cd '/w' && 'agent' 'a'\\''b'");
  });
});

describe('buildTerminalInvocation (regression guard after buildShellCommandLine extraction)', () => {
  it('embeds the exact cdAndRun string in the Terminal.app osascript args', () => {
    const inv = buildTerminalInvocation(
      makePlan({
        terminal: 'terminal-app',
        cwd: '/tmp/work',
        argv: { command: 'claude', args: ['--resume', 'sess-xyz'] },
      }),
    );
    expect(inv.command).toBe('osascript');
    // The cdAndRun line is wrapped by appleScriptString (double-quoted), so the
    // inner shell command appears verbatim inside one of the -e args.
    const expectedInner = "cd '/tmp/work' && 'claude' '--resume' 'sess-xyz'";
    expect(inv.args.some((a) => a.includes(expectedInner))).toBe(true);
  });
});
