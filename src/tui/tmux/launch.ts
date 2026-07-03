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

export async function tmuxSessionExists(sessionName: string, exec: ExecFn = defaultExec): Promise<boolean> {
  try {
    const { code } = await exec('tmux', ['has-session', '-t', sessionName]);
    return code === 0;
  } catch {
    return false;
  }
}
