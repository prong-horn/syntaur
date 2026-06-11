import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { basename } from 'node:path';
import { shellQuote } from '../tui/launch.js';
import { resolveCmuxCli } from '../utils/terminal-probe.js';
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
 *
 * Membership is tested by BASENAME (see `isWrapperCommand`): `osascript`/`open`
 * are spawned by bare name, but cmux launches via an absolute `/bin/sh -c`
 * cold-start wrapper, so a plain set-membership check on the full command
 * (`/bin/sh`) would miss `'sh'` and wrongly classify it as a long-running
 * launcher (skipping exit-code monitoring).
 */
const WRAPPER_COMMANDS = new Set(['osascript', 'open', 'sh']);

/**
 * A command is a wrapper if its basename is in `WRAPPER_COMMANDS`. Using the
 * basename lets cmux's absolute `/bin/sh` interpreter match `'sh'` while leaving
 * the bare `osascript`/`open` names (basename === name) unaffected.
 */
function isWrapperCommand(command: string): boolean {
  return WRAPPER_COMMANDS.has(basename(command));
}

/**
 * How long we wait for a wrapper (osascript/open) to exit before assuming it
 * spawned the target app successfully and detaching. Wrappers that succeed
 * usually exit in tens of milliseconds; wrappers that fail exit even faster.
 * A small window keeps the CLI responsive without missing legitimate failures.
 *
 * Per-invocation override via `TerminalInvocation.wrapperTimeoutMs` — cmux needs
 * a larger window because its cold-start script can poll for socket readiness
 * for several seconds before it exits with the real success/failure code.
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
  const isWrapper = isWrapperCommand(invocation.command);

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
      // is keeping the connection open" case. cmux overrides the window
      // (wrapperTimeoutMs) so it exceeds the cold-start readiness poll —
      // otherwise a slow cold-start FAILURE would be masked as success here.
      setTimeout(
        finishOk,
        invocation.wrapperTimeoutMs ?? WRAPPER_EXIT_TIMEOUT_MS,
      ).unref();
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
  /**
   * Override for the wrapper-exit safety-net window (ms). Set only by terminals
   * whose wrapper legitimately runs longer than `WRAPPER_EXIT_TIMEOUT_MS`
   * before exiting (cmux's cold-start readiness poll). Omitted = default.
   */
  wrapperTimeoutMs?: number;
}

/** cmux app bundle id, used to launch it on a cold start via `open -b`. */
const CMUX_BUNDLE_ID = 'com.cmuxterm.app';

/**
 * Upper bound (ms) on cmux's cold-start readiness poll: CMUX_LAUNCH_SCRIPT tries
 * 20 times at 0.25s = 5s. Keep these two in sync if the script's loop changes.
 */
const CMUX_READINESS_MAX_MS = 20 * 250;

/**
 * Wrapper safety-net window for cmux. Must exceed CMUX_READINESS_MAX_MS (plus
 * app-launch + workspace-create overhead) so that a cold-start failure exits
 * with its real non-zero code and surfaces as a TerminalNotFoundError, rather
 * than the safety net falsely resolving success mid-poll.
 */
const CMUX_LAUNCH_TIMEOUT_MS = CMUX_READINESS_MAX_MS + 3000;

/**
 * POSIX-sh cold-start orchestration for cmux, run as a single monitored
 * `/bin/sh -c` spawn. `workspace create` is a socket-control command that needs
 * the cmux app running, so on a cold start (app closed) it would fail. This
 * script: (1) launches cmux if needed via `open -b` (a no-op when already
 * running; PATH-independent — `open` is at /usr/bin even under the applet's
 * stripped PATH); (2) polls `cmux ping` for socket readiness, bounded so it
 * never hangs; (3) `exec`s `workspace create` so its exit code is the script's
 * exit code (a failure surfaces as TerminalNotFoundError via the wrapper path).
 *
 * Values are passed as positional args ($1=cli, $2=cwd, $3=command) rather than
 * interpolated, so no second layer of shell-quoting is needed and a hostile cwd
 * or command cannot break out of the script.
 */
const CMUX_LAUNCH_SCRIPT = [
  `open -b ${CMUX_BUNDLE_ID} >/dev/null 2>&1 || true`,
  'i=0',
  'while [ "$i" -lt 20 ]; do',
  '  "$1" ping >/dev/null 2>&1 && break',
  '  i=$((i + 1))',
  '  sleep 0.25',
  'done',
  'exec "$1" workspace create --cwd "$2" --command "$3" --focus true',
].join('\n');

/**
 * The agent command line with every token shell-quoted, WITHOUT a `cd` prefix:
 * `'<command>' '<arg>' …`. cmux uses this directly (it sets the workspace cwd
 * via `--cwd`, so it must not prepend `cd`); `buildShellCommandLine` adds the
 * `cd` for the terminals that drop the user into a shell.
 */
export function buildAgentCommandLine(plan: LaunchPlan): string {
  return [plan.argv.command, ...plan.argv.args].map(shellQuote).join(' ');
}

/**
 * Build the plain POSIX shell command line that actually runs inside the
 * terminal: `cd '<cwd>' && '<command>' '<arg>' …` with every token
 * shell-quoted. This is the single source of truth for "the command the launch
 * button runs" — consumed by `buildTerminalInvocation` (which wraps it per
 * terminal app) and by the dashboard's copy-launch-command endpoint. Exported
 * for reuse + unit testing.
 */
export function buildShellCommandLine(plan: LaunchPlan): string {
  return `cd ${shellQuote(plan.cwd)} && ${buildAgentCommandLine(plan)}`;
}

/**
 * Build the argv that will be handed to `spawn` to open `plan.argv` in a new
 * window of `plan.terminal` at `plan.cwd`. Exported for unit testing.
 */
export function buildTerminalInvocation(plan: LaunchPlan): TerminalInvocation {
  const cdAndRun = buildShellCommandLine(plan);

  switch (plan.terminal) {
    case 'terminal-app':
      // Terminal.app cold-start quirk: launching it auto-opens a blank window,
      // and `do script` opens ANOTHER — two windows, one blank. Capture the
      // running state BEFORE the `tell` block (addressing Terminal would launch
      // it), then on a cold start run the command in the blank launch window
      // instead of opening a second one. Warm starts still get a fresh window.
      return {
        command: 'osascript',
        args: [
          '-e',
          'set wasRunning to application "Terminal" is running',
          '-e',
          'tell application "Terminal"',
          '-e',
          'activate',
          '-e',
          'if wasRunning then',
          '-e',
          `do script ${appleScriptString(cdAndRun)}`,
          '-e',
          'else',
          '-e',
          'repeat until (count of windows) > 0',
          '-e',
          'delay 0.1',
          '-e',
          'end repeat',
          '-e',
          `do script ${appleScriptString(cdAndRun)} in window 1`,
          '-e',
          'end if',
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
      // Ghostty's AppleScript dictionary doesn't actually expose
      // `new window` / `terminal` / `input text` / `send key` as usable
      // verbs at runtime — calls fail with "Can't make new window into
      // integer" / "can't get terminal 1". Drive Ghostty via synthesized
      // key events instead: activate the app, press Cmd-N for a new
      // window, type the command, then press Return.
      //
      // Requires Accessibility permission for the process that emits the
      // Apple Events (here: `osascript` itself). macOS will prompt the
      // first time this code path fires.
      return {
        command: 'osascript',
        args: [
          '-e',
          'tell application "Ghostty" to activate',
          '-e',
          'delay 0.3',
          '-e',
          'tell application "System Events"',
          '-e',
          'keystroke "n" using command down',
          '-e',
          'delay 0.4',
          '-e',
          `keystroke ${appleScriptString(cdAndRun)}`,
          '-e',
          'key code 36',
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

    case 'cmux':
      // cmux is a socket-controlled workspace multiplexer driven by its
      // first-party CLI, which lives INSIDE the app bundle and is not on a
      // standard PATH dir. The macOS URL-handler applet launches with a
      // stripped LaunchServices PATH, so we resolve the CLI to an absolute path
      // (resolveCmuxCli: bundle → canonical dir → running-app via lsappinfo →
      // `which` off-darwin) rather than relying on a bare `cmux` (which would
      // ENOENT there). Canonical hits keep priority over the running-app lookup:
      // when a canonical copy exists but a different copy is running (e.g. off a
      // DMG), the canonical CLI still drives the running app over the shared
      // socket — fine while versions match, could skew after an update. Because
      // `workspace create` is
      // a socket command that needs the app running, we wrap it in a cold-start
      // `/bin/sh -c` script (CMUX_LAUNCH_SCRIPT): launch-if-needed via `open
      // -b`, await socket readiness, then `workspace create --cwd <cwd>
      // --command <cmd> --focus true` (which makes a workspace at --cwd and
      // sends the agent command text+Enter to it). The command is the bare
      // shell-quoted agent command (NO `cd` prefix — cmux sets the cwd via
      // --cwd) because cmux types it into the new workspace's shell. The /bin/sh
      // interpreter is registered in WRAPPER_COMMANDS (matched by basename
      // 'sh'), so a missing binary or dead socket surfaces as a
      // TerminalNotFoundError.
      return {
        command: '/bin/sh',
        args: [
          '-c',
          CMUX_LAUNCH_SCRIPT,
          'syntaur-cmux-launch', // $0 (label in ps / error messages)
          resolveCmuxCli() ?? 'cmux', // $1
          plan.cwd, // $2
          buildAgentCommandLine(plan), // $3
        ],
        // Exceed the cold-start readiness poll so a failed cold launch surfaces
        // as an error instead of being masked by the wrapper safety net.
        wrapperTimeoutMs: CMUX_LAUNCH_TIMEOUT_MS,
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
