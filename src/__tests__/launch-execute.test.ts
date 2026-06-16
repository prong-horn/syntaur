import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeLaunchPlan,
  buildShellCommandLine,
  buildTerminalInvocation,
  TerminalNotFoundError,
  type LaunchPlan,
  type SpawnFn,
} from '../launch/index.js';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import {
  appendSession,
  getSessionById,
  updateSessionStatus,
} from '../dashboard/agent-sessions.js';

// Pin resolveCmuxCli so the cmux invocation is deterministic and does not hit
// the real filesystem / spawn `which` during these unit tests. The cmux command
// is `/bin/sh` regardless, so wrapper classification is host-independent.
vi.mock('../utils/terminal-probe.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/terminal-probe.js')>();
  return {
    ...actual,
    resolveCmuxCli: () => '/Applications/cmux.app/Contents/Resources/bin/cmux',
  };
});

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
  pid?: number;
}) {
  const emitter = new EventEmitter() as EventEmitter & {
    unref: () => void;
    stderr: Readable | null;
    pid?: number;
  };
  emitter.unref = () => {};
  if (opts.pid !== undefined) emitter.pid = opts.pid;
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
    ).resolves.toMatchObject({ startedAt: expect.any(String) });
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
    ).resolves.toMatchObject({ startedAt: expect.any(String) });
  });

  it('throws TerminalNotFoundError when spawn() itself throws synchronously', async () => {
    const spawnFn: SpawnFn = () => {
      throw new Error('boom');
    };
    await expect(
      executeLaunchPlan(makePlan(), spawnFn),
    ).rejects.toThrow(TerminalNotFoundError);
  });

  it('treats cmux as a wrapper: non-zero exit → TerminalNotFoundError', async () => {
    // cmux resolves to an absolute bundle path where installed; the wrapper
    // check matches by basename, so exit-code monitoring still applies.
    const spawnFn: SpawnFn = () =>
      fakeChild({
        fireOn: 'exit',
        exitCode: 1,
        stderr: 'cmux: socket not reachable',
      });
    await expect(
      executeLaunchPlan(makePlan({ terminal: 'cmux' }), spawnFn),
    ).rejects.toThrowError(/exited with code 1/);
  });

  it('treats cmux as a wrapper: exit 0 resolves', async () => {
    const spawnFn: SpawnFn = () => fakeChild({ fireOn: 'exit', exitCode: 0 });
    await expect(
      executeLaunchPlan(makePlan({ terminal: 'cmux' }), spawnFn),
    ).resolves.toMatchObject({ startedAt: expect.any(String) });
  });

  it('cmux spawn error (ENOENT) → TerminalNotFoundError', async () => {
    const spawnFn: SpawnFn = () =>
      fakeChild({ fireOn: 'error', errorMessage: 'spawn cmux ENOENT' });
    await expect(
      executeLaunchPlan(makePlan({ terminal: 'cmux' }), spawnFn),
    ).rejects.toThrow(TerminalNotFoundError);
  });

  it('cmux surfaces a SLOW cold-start failure (exit after the default 1.5s net)', async () => {
    // The cold-start poll can run several seconds; cmux raises its wrapper
    // safety-net window past that. A non-zero exit at ~1.6s (which the default
    // 1500ms net would have masked as success) must still throw.
    const spawnFn: SpawnFn = () =>
      fakeChild({
        fireOn: 'exit',
        exitCode: 1,
        stderr: 'cmux: socket not reachable after readiness wait',
        delayMs: 1600,
      });
    await expect(
      executeLaunchPlan(makePlan({ terminal: 'cmux' }), spawnFn),
    ).rejects.toThrowError(/exited with code 1/);
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

describe('executeLaunchPlan register-at-birth', () => {
  let markerDir: string;
  let dbDir: string;

  let savedSyntaurHome: string | undefined;

  beforeEach(async () => {
    markerDir = await mkdtemp(join(tmpdir(), 'syntaur-launch-markers-'));
    dbDir = await mkdtemp(join(tmpdir(), 'syntaur-launch-db-'));
    process.env.SYNTAUR_RUNTIME_SESSIONS_DIR = markerDir;
    // Hermetic config: no real ~/.syntaur/config.md → defaults (autoTrack 'all').
    savedSyntaurHome = process.env.SYNTAUR_HOME;
    process.env.SYNTAUR_HOME = dbDir;
    resetSessionDb();
    initSessionDb(join(dbDir, 'test.db'));
  });

  afterEach(async () => {
    delete process.env.SYNTAUR_RUNTIME_SESSIONS_DIR;
    if (savedSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = savedSyntaurHome;
    closeSessionDb();
    await rm(markerDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('writes a pending runtime marker (no sessionId) for a fresh/fork launch', async () => {
    const spawnFn: SpawnFn = () => fakeChild({ fireOn: 'spawn', pid: 55001 });
    await executeLaunchPlan(
      makePlan({ terminal: 'alacritty', session: { sessionId: null } }),
      spawnFn,
    );

    const marker = JSON.parse(await readFile(join(markerDir, '55001.json'), 'utf-8'));
    expect(marker.sessionId).toBeUndefined(); // pending — never synthesized
    expect(marker.agent).toBe('claude');
    expect(marker.cwd).toBe('/tmp/work');
    expect(getSessionById('55001')).toBeNull(); // no row without a real id
  });

  it('writes the marker AND an active DB row for a resume-mode launch with a known id', async () => {
    const spawnFn: SpawnFn = () => fakeChild({ fireOn: 'spawn', pid: 55002 });
    await executeLaunchPlan(
      makePlan({ terminal: 'alacritty', session: { sessionId: 'resumed-sess-1' } }),
      spawnFn,
    );

    const marker = JSON.parse(await readFile(join(markerDir, '55002.json'), 'utf-8'));
    expect(marker.sessionId).toBe('resumed-sess-1');

    const row = getSessionById('resumed-sess-1');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('active');
    expect(row!.pid).toBe(55002);
    expect(row!.agent).toBe('claude');
  });

  it('revives a stopped row when resuming it (live-process evidence)', async () => {
    await appendSession('', {
      sessionId: 'stopped-resume-1',
      projectSlug: null,
      assignmentSlug: null,
      agent: 'claude',
      started: '2026-06-11T08:00:00Z',
      status: 'active',
      path: '/tmp/work',
    });
    await updateSessionStatus('', 'stopped-resume-1', 'stopped');

    const spawnFn: SpawnFn = () => fakeChild({ fireOn: 'spawn', pid: 55003 });
    await executeLaunchPlan(
      makePlan({ terminal: 'alacritty', session: { sessionId: 'stopped-resume-1' } }),
      spawnFn,
    );

    expect(getSessionById('stopped-resume-1')!.status).toBe('active');
  });

  it('skips registration entirely when the spawned child has no pid', async () => {
    const spawnFn: SpawnFn = () => fakeChild({ fireOn: 'spawn' });
    await executeLaunchPlan(
      makePlan({ terminal: 'alacritty', session: { sessionId: 'no-pid-sess' } }),
      spawnFn,
    );
    expect(getSessionById('no-pid-sess')).toBeNull();
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
