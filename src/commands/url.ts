import { readConfig } from '../utils/config.js';
import { assignmentsDir, defaultProjectDir } from '../utils/paths.js';
import {
  parseOpenUrl,
  resolveLaunchPlan,
  executeLaunchPlan,
  OpenUrlError,
  LaunchError,
  TerminalNotFoundError,
  type LaunchPlan,
} from '../launch/index.js';
import { initSessionDb } from '../dashboard/session-db.js';
import { shellQuote } from '../tui/launch.js';

export interface UrlCommandOptions {
  /**
   * When set, do NOT execute the plan. Print it to stdout in a format the
   * macOS URL handler applet can consume, then exit 0. Used to keep the
   * AppleScript that controls Terminal/iTerm/Ghostty running inside the
   * applet's own process — macOS TCC will not reliably attribute Apple
   * Events sent from osascript-as-a-subprocess back to the applet.
   *
   * Output format (two lines, no trailing newline):
   *   <terminal-id>
   *   <cd-and-command-line>
   *
   * The applet parses these and dispatches to a per-terminal `tell
   * application` block in its own AppleScript scope.
   */
  printPlan?: boolean;
}

/**
 * Entry point for `syntaur url <url>`. Parses a `syntaur://open?...` URL,
 * resolves a launch plan from the active config + assignment/session lookup,
 * and either spawns the terminal directly (default) or prints the plan in a
 * format the macOS URL handler applet consumes (--print-plan).
 *
 * Throws on bad input; the caller (`src/index.ts`) translates errors to a
 * non-zero process exit.
 */
export async function urlCommand(
  input: string,
  options: UrlCommandOptions = {},
): Promise<void> {
  const parsed = parseOpenUrl(input);
  const config = await readConfig();

  if (parsed.kind === 'session') {
    initSessionDb();
  }

  const projectsDir = config.defaultProjectDir || defaultProjectDir();
  const plan = await resolveLaunchPlan({
    kind: parsed.kind,
    id: parsed.id,
    mode: parsed.kind === 'session' ? parsed.mode : undefined,
    config,
    projectsDir,
    assignmentsDir: assignmentsDir(),
    terminalOverride: parsed.terminal,
  });

  if (plan.fallbackWarning) {
    console.error(plan.fallbackWarning);
  }
  if (plan.shellFallbackWarning) {
    console.error(plan.shellFallbackWarning);
  }

  if (options.printPlan) {
    process.stdout.write(formatPlanForApplet(plan));
    return;
  }

  await executeLaunchPlan(plan);
}

/**
 * Serialize a launch plan for consumption by the macOS URL handler applet.
 *
 * Output is two lines:
 *   line 1: the terminal id (one of TERMINAL_CHOICES)
 *   line 2: the full shell command, already shell-quoted, that the terminal
 *           should run — `cd '<cwd>' && '<agent>' '<arg1>' '<arg2>' ...`
 *
 * The applet treats line 2 as an opaque shell command and passes it directly
 * to the terminal's "run this script" verb (Terminal.app `do script`, iTerm
 * `write text`, Ghostty `input text` to the new terminal, etc.) so the
 * applet's own bundle identity is the one macOS TCC sees on the outgoing
 * Apple Event.
 */
export function formatPlanForApplet(plan: LaunchPlan): string {
  const commandLine = [plan.argv.command, ...plan.argv.args]
    .map(shellQuote)
    .join(' ');
  const cdAndRun = `cd ${shellQuote(plan.cwd)} && ${commandLine}`;
  // Two lines, NO trailing newline — keeps it easy to read with AppleScript's
  // `paragraphs of` which splits on either CR or LF.
  return `${plan.terminal}\n${cdAndRun}`;
}

/**
 * Format a known error for the CLI. Returns a structured message; the caller
 * is responsible for printing it and exiting non-zero.
 */
export function formatUrlCommandError(err: unknown): string {
  if (err instanceof OpenUrlError) {
    return `Invalid syntaur:// URL (${err.code}): ${err.message}`;
  }
  if (err instanceof LaunchError) {
    return `Could not launch (${err.code}): ${err.message}`;
  }
  if (err instanceof TerminalNotFoundError) {
    return err.message;
  }
  return `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
}
