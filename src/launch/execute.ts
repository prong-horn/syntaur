import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { shellQuote } from '../tui/launch.js';
import type { LaunchPlan } from './plan.js';
import type { TerminalChoice } from '../utils/config.js';

export class TerminalNotFoundError extends Error {
  readonly terminal: TerminalChoice;
  readonly remediation: string;
  constructor(terminal: TerminalChoice, remediation: string) {
    super(
      `Terminal "${terminal}" is not installed or not invokable. ${remediation}`,
    );
    this.terminal = terminal;
    this.remediation = remediation;
    this.name = 'TerminalNotFoundError';
  }
}

/**
 * Test hook: a function that replaces `child_process.spawn` so unit tests can
 * assert exactly what the launcher invoked without spawning real processes.
 * Must return a `ChildProcess`-shaped object — `executeLaunchPlan` listens for
 * `'error'`, `'spawn'`, and `'exit'` events to detect missing terminals.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

const realSpawn: SpawnFn = (command, args, options) =>
  spawn(command, args as string[], options);

/**
 * Commands we treat as "wrappers" that synchronously delegate to the actual
 * terminal app. These fail fast (non-zero exit + stderr) when the target app
 * or URL scheme isn't installed, so we monitor their exit code briefly.
 */
const WRAPPER_COMMANDS = new Set(['osascript', 'open']);

/**
 * How long we wait for a wrapper (osascript/open) to exit before assuming it
 * spawned the target app successfully and detaching. Wrappers that succeed
 * usually exit in tens of milliseconds; wrappers that fail exit even faster.
 * A small window keeps the CLI responsive without missing legitimate failures.
 */
const WRAPPER_EXIT_TIMEOUT_MS = 1500;

/**
 * Run the launch plan: spawn the configured terminal in a new window with the
 * resolved cwd + agent argv. Returns once the spawn has been initiated and
 * confirmed; for wrapper commands (osascript/open) it briefly waits for the
 * wrapper to exit so that missing apps surface as a non-zero CLI exit.
 *
 * Throws `TerminalNotFoundError` when the spawn errors (ENOENT on direct CLI
 * launchers) or when a wrapper exits non-zero (target app missing).
 */
export async function executeLaunchPlan(
  plan: LaunchPlan,
  spawnFn: SpawnFn = realSpawn,
): Promise<void> {
  if (plan.terminal === 'warp') {
    // Warp's URI scheme opens a window at the cwd but does not auto-start a
    // command — there is no documented `command=` parameter. Surface this so
    // the user knows to start the agent themselves once the window opens.
    console.error(
      `syntaur: Warp will open a window at ${plan.cwd} but cannot auto-start ${plan.argv.command} — run it yourself once the window appears`,
    );
  }
  const invocation = buildTerminalInvocation(plan);
  const isWrapper = WRAPPER_COMMANDS.has(invocation.command);

  let child: ChildProcess;
  try {
    child = spawnFn(invocation.command, invocation.args, {
      detached: true,
      // Wrappers: capture stderr so we can surface error text. Direct CLI
      // launchers: ignore all streams so they keep running after we detach.
      stdio: isWrapper ? ['ignore', 'ignore', 'pipe'] : 'ignore',
      env: plan.env,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TerminalNotFoundError(
      plan.terminal,
      `Spawn failed: ${msg}. Verify the terminal is installed and on PATH.`,
    );
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = '';

    const finishOk = () => {
      if (settled) return;
      settled = true;
      try { child.unref(); } catch { /* unref can throw if already exited */ }
      resolve();
    };

    const finishErr = (remediation: string) => {
      if (settled) return;
      settled = true;
      reject(new TerminalNotFoundError(plan.terminal, remediation));
    };

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }

    child.once('error', (err: Error) => {
      finishErr(
        `Spawn failed: ${err.message}. Verify the terminal is installed and on PATH.`,
      );
    });

    if (isWrapper) {
      child.once('exit', (code, signal) => {
        if (code === 0 || code === null) {
          finishOk();
        } else {
          const detail = stderr.trim() || (
            signal
              ? `terminated by signal ${signal}`
              : 'check that the terminal app is installed and the URL scheme handler is registered'
          );
          finishErr(`${invocation.command} exited with code ${code}: ${detail}`);
        }
      });
      // Safety net: if the wrapper hasn't exited within the window, assume
      // success and detach. This is the normal "Terminal.app spawned, wrapper
      // is keeping the connection open" case.
      setTimeout(finishOk, WRAPPER_EXIT_TIMEOUT_MS).unref();
    } else {
      child.once('spawn', () => {
        finishOk();
      });
    }
  });
}

interface TerminalInvocation {
  command: string;
  args: string[];
}

/**
 * Build the argv that will be handed to `spawn` to open `plan.argv` in a new
 * window of `plan.terminal` at `plan.cwd`. Exported for unit testing.
 */
export function buildTerminalInvocation(plan: LaunchPlan): TerminalInvocation {
  const commandLine = [plan.argv.command, ...plan.argv.args]
    .map(shellQuote)
    .join(' ');
  const cdAndRun = `cd ${shellQuote(plan.cwd)} && ${commandLine}`;

  switch (plan.terminal) {
    case 'terminal-app':
      return {
        command: 'osascript',
        args: [
          '-e',
          'tell application "Terminal"',
          '-e',
          'activate',
          '-e',
          `do script ${appleScriptString(cdAndRun)}`,
          '-e',
          'end tell',
        ],
      };

    case 'iterm':
      // iTerm2's AppleScript dictionary uses the application name `iTerm` in
      // tell blocks (per https://iterm2.com/documentation-scripting.html),
      // even though the bundle id is `com.googlecode.iterm2`. If a future
      // iTerm release switches to "iTerm2", the doctor check's bundle-id
      // lookup will still succeed; only this script would need updating.
      return {
        command: 'osascript',
        args: [
          '-e',
          'tell application "iTerm"',
          '-e',
          'activate',
          '-e',
          'set newWindow to (create window with default profile)',
          '-e',
          `tell current session of newWindow to write text ${appleScriptString(cdAndRun)}`,
          '-e',
          'end tell',
        ],
      };

    case 'ghostty':
      // Ghostty's AppleScript dictionary (https://ghostty.org/docs/features/applescript)
      // exposes `new window`, `new tab`, `split`, `input text`, and
      // `send key`. The `input text` / `send key` verbs require a terminal
      // target (not application scope) — calling them on the app produces a
      // no-op or an error depending on the Ghostty version. Strategy: open
      // a new window, resolve the terminal of its selected tab, send the
      // `cd && <command>` line to that terminal, then send the Enter key.
      // `delay 0.2` gives the new window's pty time to attach before we
      // type into it.
      return {
        command: 'osascript',
        args: [
          '-e',
          'tell application "Ghostty"',
          '-e',
          'activate',
          '-e',
          'set newWin to (new window)',
          '-e',
          'delay 0.2',
          '-e',
          'set t to terminal 1 of selected tab of newWin',
          '-e',
          `input text ${appleScriptString(cdAndRun)} to t`,
          '-e',
          'send key "enter" to t',
          '-e',
          'end tell',
        ],
      };

    case 'alacritty':
      return {
        command: 'alacritty',
        args: [
          '--working-directory',
          plan.cwd,
          '-e',
          plan.argv.command,
          ...plan.argv.args,
        ],
      };

    case 'warp': {
      // Warp's URI scheme (https://docs.warp.dev/terminal/more-features/uri-scheme)
      // supports `warp://action/new_window?path=...` but does NOT accept a
      // `command=` param — the agent is not auto-started. `executeLaunchPlan`
      // emits a console.error warning above so the user knows to start the
      // agent manually once the Warp window appears. If a future Warp version
      // adds `command=` (or a documented alternative), update this branch
      // and drop the warning.
      const params = new URLSearchParams({ path: plan.cwd });
      return {
        command: 'open',
        args: [`warp://action/new_window?${params.toString()}`],
      };
    }

    case 'kitty':
      // Two-path strategy from the plan: prefer `kitty @ launch` when remote
      // control is enabled (gated by the doctor `terminal.kitty-remote-control`
      // check; if disabled the agent still gets launched, just via the
      // simpler path here). The `--` separator is required so `-`-prefixed
      // args like `--resume` reach the agent rather than kitty itself.
      return {
        command: 'kitty',
        args: [
          '--directory',
          plan.cwd,
          '--',
          plan.argv.command,
          ...plan.argv.args,
        ],
      };
  }
}

/**
 * Quote a string for embedding inside an AppleScript double-quoted literal.
 * AppleScript interprets a literal backslash and a literal double-quote inside
 * "..." strings; everything else passes through.
 */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
