import { readConfig } from '../utils/config.js';
import { assignmentsDir, defaultProjectDir } from '../utils/paths.js';
import {
  parseOpenUrl,
  resolveLaunchPlan,
  executeLaunchPlan,
  OpenUrlError,
  LaunchError,
  TerminalNotFoundError,
} from '../launch/index.js';
import { initSessionDb } from '../dashboard/session-db.js';

/**
 * Entry point for `syntaur url <url>`. Parses a `syntaur://open?...` URL,
 * resolves a launch plan from the active config + assignment/session lookup,
 * and spawns the configured terminal at the resolved cwd.
 *
 * Throws on bad input; the caller (`src/index.ts`) translates errors to a
 * non-zero process exit.
 */
export async function urlCommand(input: string): Promise<void> {
  const parsed = parseOpenUrl(input);
  const config = await readConfig();

  if (parsed.kind === 'session') {
    initSessionDb();
  }

  const projectsDir = config.defaultProjectDir || defaultProjectDir();
  const plan = await resolveLaunchPlan({
    kind: parsed.kind,
    id: parsed.id,
    config,
    projectsDir,
    assignmentsDir: assignmentsDir(),
  });

  if (plan.fallbackWarning) {
    console.error(plan.fallbackWarning);
  }
  if (plan.shellFallbackWarning) {
    console.error(plan.shellFallbackWarning);
  }

  await executeLaunchPlan(plan);
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
