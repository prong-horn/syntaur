import { execFile } from 'node:child_process';
import type { AgentConfig } from '../../utils/config.js';
import type { AgentLaunchPlan } from '../../launch/build-launch.js';

export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
) => Promise<{ code: number; stdout: string }>;

// `env: undefined` keeps Node's inherit-parent default, so call sites that pass
// no env behave exactly as before.
const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolvePromise({ code: 0, stdout: stdout ?? '' });
    });
  });

/**
 * Whether an agent + its already-built launch argv are eligible for the
 * native `claude --bg` path. Both guards are decidable purely from static
 * `AgentConfig`/argv — no spawning — and either failing means the caller
 * should fall through to the tmux (or hand-off) path instead:
 *
 *  - `resolveFromShellAliases` plans wrap the invocation as
 *    `$SHELL -i -c '<quoted claude ...>'` (`build-launch.ts`'s
 *    `buildAgentArgv`) — prepending `--bg`/`--name` would hand those flags to
 *    the SHELL, not claude, and there is no safe way to inject into the
 *    already-quoted string. These agents simply keep the tmux path.
 *  - `-p`/`--print` mode cannot combine with `--bg` (print mode exits after
 *    one response; there is nothing to background).
 */
export function isNativeLaunchEligible(agent: AgentConfig, args: string[]): boolean {
  if (agent.resolveFromShellAliases) return false;
  if (args.includes('-p') || args.includes('--print')) return false;
  return true;
}

/**
 * Prepends `--bg --name <name>` to an already-built claude argv. Pure argv
 * injection, not a second launch-plan builder: `buildLaunchPlan`'s output
 * already carries model flags, custom agent args, and the embedded prompt in
 * the right position, so prepending preserves all of that by construction —
 * no reverse-parsing of the existing args.
 */
export function injectBgArgs(args: string[], name: string): string[] {
  return ['--bg', '--name', name, ...args];
}

export interface LaunchClaudeBgInput {
  plan: AgentLaunchPlan;
  name: string;
  exec?: ExecFn;
}

/**
 * Launches a Claude agent via the native `--bg` path in `plan.cwd`.
 *
 * Plants `SYNTAUR_HOSTED_BY` so the session-registration hook can stamp the
 * backend on the row Claude creates for itself. No `SYNTAUR_LAUNCH_ID`: this
 * tier deliberately creates NO placeholder row (`claude --bg` yields no
 * pid/short to seed one with, and a hookless placeholder would be an
 * unsweepable active row). Best-effort — if Claude's own daemon does not
 * forward the dispatcher's env to the worker, rows keep `hosted_by` NULL,
 * exactly as before.
 */
export async function launchClaudeBg(input: LaunchClaudeBgInput): Promise<void> {
  const exec = input.exec ?? defaultExec;
  await exec(input.plan.command, injectBgArgs(input.plan.args, input.name), {
    cwd: input.plan.cwd,
    env: { ...process.env, SYNTAUR_HOSTED_BY: 'claude-bg' } as Record<string, string>,
  });
}
