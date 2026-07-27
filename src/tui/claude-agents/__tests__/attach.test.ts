import { describe, it, expect, vi } from 'vitest';
import { buildClaudeAgentViewArgv, runClaudeAgentView } from '../attach.js';

function fakeChild(exitCode = 0) {
  const h: Record<string, (a?: unknown) => void> = {};
  queueMicrotask(() => h['exit']?.(exitCode));
  return { on: (evt: string, cb: (a?: unknown) => void) => { h[evt] = cb; } };
}

function fakeErrorChild(err: Error) {
  const h: Record<string, (a?: unknown) => void> = {};
  queueMicrotask(() => h['error']?.(err));
  return { on: (evt: string, cb: (a?: unknown) => void) => { h[evt] = cb; } };
}

function fakeChildExitWithNoArg() {
  const h: Record<string, (a?: unknown) => void> = {};
  queueMicrotask(() => h['exit']?.());
  return { on: (evt: string, cb: (a?: unknown) => void) => { h[evt] = cb; } };
}

// `claude --help` is `claude [options] [command] [prompt]`: any leading word
// that is NOT a registered subcommand is consumed as the PROMPT. So passing a
// made-up verb does not fail loudly — it silently launches a NEW Claude session
// prompted with that verb. These are the subcommands claude actually registers
// (2.1.205); note the absence of `attach`.
const REAL_CLAUDE_SUBCOMMANDS = [
  'agents', 'auth', 'auto-mode', 'doctor', 'gateway', 'install',
  'mcp', 'plugin', 'plugins', 'project', 'setup-token', 'ultrareview',
  'update', 'upgrade',
];

describe('claude Agent View', () => {
  // REGRESSION (user-reported, 0.78.0): the cockpit spawned `claude attach
  // <short>`, but claude has no `attach` subcommand — so instead of attaching,
  // it launched a brand-new session prompted "attach <short>". The old tests
  // asserted `['attach', id]` against a mocked spawn, which only re-stated the
  // bug's own assumption and so could never catch it. Assert against the set of
  // subcommands claude really has instead.
  it('spawns a REAL claude subcommand — never a made-up verb that claude would treat as a prompt', async () => {
    const spawnFn = vi.fn(() => fakeChild(0));
    await runClaudeAgentView(spawnFn as never);

    const [cmd, argv] = spawnFn.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('claude');
    expect(argv[0]).not.toBe('attach'); // the exact bug
    expect(REAL_CLAUDE_SUBCOMMANDS).toContain(argv[0]);
  });

  it('opens the Agent View picker with no positional session id (claude agents takes none)', () => {
    // `claude agents [options]` — there is no positional <short>, so appending
    // one would again fall through to claude's [prompt] argument.
    expect(buildClaudeAgentViewArgv()).toEqual(['agents']);
  });

  it('spawns claude agents with inherited stdio', async () => {
    const spawnFn = vi.fn(() => fakeChild(0));
    await runClaudeAgentView(spawnFn as never);
    expect(spawnFn).toHaveBeenCalledWith('claude', ['agents'], { stdio: 'inherit' });
  });

  it('resolves { code } on a clean exit', async () => {
    const spawnFn = vi.fn(() => fakeChild(0));
    expect(await runClaudeAgentView(spawnFn as never)).toEqual({ code: 0 });
  });

  it('resolves { code } propagating a non-zero exit code', async () => {
    const spawnFn = vi.fn(() => fakeChild(1));
    expect(await runClaudeAgentView(spawnFn as never)).toEqual({ code: 1 });
  });

  it('coerces an undefined exit code to null', async () => {
    const spawnFn = vi.fn(() => fakeChildExitWithNoArg());
    expect(await runClaudeAgentView(spawnFn as never)).toEqual({ code: null });
  });

  it('resolves { code: null, error } on a spawn error, and never rejects', async () => {
    const err = new Error('spawn claude ENOENT');
    const spawnFn = vi.fn(() => fakeErrorChild(err));
    const result = await runClaudeAgentView(spawnFn as never);
    expect(result.code).toBe(null);
    expect(result.error).toBe(err);
  });
});
