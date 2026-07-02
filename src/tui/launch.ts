import { spawn } from 'node:child_process';
import type { AgentConfig } from '../utils/config.js';
import type { SpawnFn } from '../launch/execute.js';
import { bareGrabSeed } from '../launch/launch-prompt.js';
import { buildLaunchPlan, type LaunchPlan } from '../launch/build-launch.js';

export type { ResolvedArgv, BuiltArgv } from '../launch/types.js';
// `formatFallbackCwdWarning` now lives in ../launch/cwd.ts (a neutral module so
// plan.ts can import the cwd helpers without a cycle). Re-exported here so the
// existing `import { formatFallbackCwdWarning } from '../tui/launch.js'` sites
// (e.g. launch-argv.test.ts) keep working.
export { formatFallbackCwdWarning } from '../launch/cwd.js';
// `buildAgentArgv`/`shellQuote` now live in ../launch/build-launch.ts, alongside
// `buildLaunchPlan` (which needs to call `buildAgentArgv` to build the final
// argv) — that lets `buildLaunchPlan` be extracted here without an import cycle
// (this module imports `buildLaunchPlan` from build-launch.ts, so build-launch.ts
// cannot import back from here). Re-exported so existing
// `import { buildAgentArgv, shellQuote } from '../tui/launch.js'` call sites
// (e.g. launch-argv.test.ts, launch/argv.ts, launch/execute.ts) keep working.
export { buildAgentArgv, shellQuote } from '../launch/build-launch.js';
export type { LaunchPlan } from '../launch/build-launch.js';

export interface LaunchOptions {
  projectsDir: string;
  projectSlug: string;
  assignmentSlug: string;
  agent: AgentConfig;
  cwdOverride?: string;
  /**
   * Test hook: called with the exit code of the spawned child instead of
   * `process.exit(code)`. Default behavior is `process.exit`. Production
   * callers should leave this unset.
   */
  onExit?: (code: number) => void;
  /**
   * Test hook: replaces `child_process.spawn` so unit tests can assert exactly
   * what (and with which cwd) the launcher invoked without spawning a real
   * process. Default is the real `spawn`. Production callers leave this unset.
   */
  spawnFn?: SpawnFn;
}

/**
 * Initial message sent to the agent the first time it starts up at an
 * assignment. This is the protocol entry point: `/grab-assignment` is the
 * Claude Code skill that loads project/playbook/memory context for the
 * assignment and (per its pre-flight check) prompts the user if a different
 * assignment is already active in this workspace.
 *
 * Argument shapes match the skill's documented input:
 *   - project-nested: `/grab-assignment <project-slug> <assignment-slug>`
 *   - standalone:     `/grab-assignment --id <uuid>`
 *
 * When `playbook` is set (an agent runner profile), the seed switches to an
 * instruction-style message that chains BOTH `/grab-assignment` and
 * `/run-playbook`. This is deliberate: a Claude Code message fires only ONE
 * leading slash-command — everything after it is swallowed as that command's
 * arguments — so two slash-commands cannot be issued from a single seed. A
 * plain-language instruction lets the agent invoke both skills itself
 * (grab-assignment loads playbook *context*; run-playbook *executes* a specific
 * enabled playbook end-to-end — complementary, not redundant). The no-playbook
 * path keeps the exact, well-tested `/grab-assignment` invocation unchanged.
 */
/**
 * @deprecated Both launch call sites now route through `resolveLaunchPrompt`
 * (`../launch/launch-prompt.js`), which supports the editable `launchPrompt`
 * field. `INITIAL_PROMPT` is retained only for its existing tests / transitional
 * reference; its no-playbook branch shares `bareGrabSeed` with the resolver so
 * those bare-seed strings stay byte-identical.
 */
export const INITIAL_PROMPT = (params: {
  projectSlug: string | null;
  assignmentSlug: string;
  id?: string;
  playbook?: string | null;
}): string => {
  const playbook = params.playbook?.trim();

  if (!playbook) {
    return bareGrabSeed({
      projectSlug: params.projectSlug,
      assignmentSlug: params.assignmentSlug,
      id: params.id,
    });
  }

  // Playbook profile: chain grab + run-playbook via a plain-language seed.
  const grabClause = params.projectSlug
    ? `the assignment \`${params.projectSlug}/${params.assignmentSlug}\` using the /grab-assignment skill`
    : params.id
      ? `the assignment id \`${params.id}\` using /grab-assignment --id ${params.id}`
      : `the assignment \`${params.assignmentSlug}\` using the /grab-assignment skill`;
  return (
    `Grab ${grabClause}, then load and run the \`${playbook}\` playbook ` +
    `using the /run-playbook skill and carry it out end-to-end.`
  );
};

/**
 * Spawn the agent for a launch. Delegates ALL of "resolve cwd → write
 * context.json → resolve prompt → build argv" to `buildLaunchPlan`
 * (`../launch/build-launch.ts`) so a detached tmux launch and this in-process
 * hand-off launch share one path — this function only adds the spawn/exit
 * lifecycle around the resulting plan.
 */
export async function launchAgent(options: LaunchOptions): Promise<void> {
  const { agent } = options;
  const exitWith = options.onExit ?? ((code: number) => process.exit(code));

  let plan: LaunchPlan;
  try {
    plan = await buildLaunchPlan({
      projectsDir: options.projectsDir,
      projectSlug: options.projectSlug,
      assignmentSlug: options.assignmentSlug,
      agent: options.agent,
      cwdOverride: options.cwdOverride,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    exitWith(1);
    return;
  }

  const spawnImpl = options.spawnFn ?? spawn;
  return new Promise<void>((resolvePromise) => {
    const child = spawnImpl(plan.command, plan.args, {
      cwd: plan.cwd,
      stdio: 'inherit',
    });

    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        console.error(
          `syntaur: agent "${agent.id}" command "${agent.command}" not found. ` +
            `If "${agent.command}" is a shell alias, set resolveFromShellAliases: true on this agent in ~/.syntaur/config.md.`,
        );
      } else if (code === 'EACCES') {
        console.error(
          `syntaur: agent "${agent.id}" command "${agent.command}" is not executable (EACCES). ` +
            `Check file permissions.`,
        );
      } else {
        console.error(
          `syntaur: failed to launch agent "${agent.id}" (${code ?? 'unknown'}): ${err.message}`,
        );
      }
      resolvePromise();
      exitWith(1);
    });

    child.on('exit', (code) => {
      resolvePromise();
      exitWith(code ?? 0);
    });
  });
}
