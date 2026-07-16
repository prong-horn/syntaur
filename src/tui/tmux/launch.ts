import { execFile } from 'node:child_process';

export type ExecFn = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;

const defaultExec: ExecFn = (cmd, args) =>
  new Promise((res, rej) => {
    execFile(cmd, args, { encoding: 'utf8' }, (err, stdout) => {
      if (err) rej(err);
      else res({ code: 0, stdout: stdout ?? '' });
    });
  });

export function tmuxSessionName(projectSlug: string | null, assignmentSlug: string): string {
  const raw = [projectSlug, assignmentSlug].filter(Boolean).join('-');
  return `syntaur-${raw.replace(/[.:]/g, '-').replace(/[^\w-]/g, '-')}`;
}

export interface TmuxLaunchInput {
  sessionName: string;
  cwd: string;
  command: string;
  args: string[];
  exec?: ExecFn;
}

export function buildTmuxLaunchArgv(input: TmuxLaunchInput): string[] {
  return ['new-session', '-d', '-s', input.sessionName, '-c', input.cwd, input.command, ...input.args];
}

export async function launchInTmux(input: TmuxLaunchInput): Promise<void> {
  await (input.exec ?? defaultExec)('tmux', buildTmuxLaunchArgv(input));
}

export interface TmuxLaunchInputWithEnv extends TmuxLaunchInput {
  /**
   * Per-launch env pairs, delivered by prefixing the command with POSIX
   * `env KEY=VALUE …`. This works on EVERY tmux — `new-session -e` needs
   * ≥3.2 and silently strands the correlation markers on older versions.
   * No shell is involved (tmux execs the argv directly), so there is no
   * quoting hazard, and `env` execs into the command so the pane pid IS the
   * agent's pid.
   */
  env?: Record<string, string>;
}

/**
 * Launch + capture the new session's pane pid, for fallback provenance.
 *
 * A sibling rather than a change to `launchInTmux`: `LaunchDeps.launchInTmux`
 * is typed `typeof launchInTmux`, so widening that return type would break
 * every existing typed mock. This keeps the dep contract byte-identical.
 */
export async function launchInTmuxWithPid(input: TmuxLaunchInputWithEnv): Promise<number | null> {
  const exec = input.exec ?? defaultExec;
  const envPrefix = Object.entries(input.env ?? {}).map(([k, v]) => `${k}=${v}`);
  const cmd = envPrefix.length > 0
    ? ['env', ...envPrefix, input.command, ...input.args]
    : [input.command, ...input.args];
  const { stdout } = await exec('tmux', [
    'new-session', '-d', '-P', '-F', '#{pane_pid}', '-s', input.sessionName, '-c', input.cwd, ...cmd,
  ]);
  const pid = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

export async function tmuxSessionExists(sessionName: string, exec: ExecFn = defaultExec): Promise<boolean> {
  try {
    const { code } = await exec('tmux', ['has-session', '-t', sessionName]);
    return code === 0;
  } catch {
    return false;
  }
}
