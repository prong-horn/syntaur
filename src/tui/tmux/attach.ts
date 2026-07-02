import { spawn } from 'node:child_process';

export function buildTmuxAttachArgv(sessionName: string): string[] {
  return ['attach-session', '-t', sessionName];
}

type MinimalChild = { on(evt: string, cb: (arg?: unknown) => void): void };
type SpawnLike = (cmd: string, args: string[], opts: { stdio: 'inherit' }) => MinimalChild;

export function runTmuxAttach(sessionName: string, spawnFn?: SpawnLike): Promise<void> {
  const spawnImpl: SpawnLike = spawnFn ?? ((c, a, o) => spawn(c, a, o) as unknown as MinimalChild);
  return new Promise<void>((resolvePromise) => {
    const child = spawnImpl('tmux', buildTmuxAttachArgv(sessionName), { stdio: 'inherit' });
    const done = () => resolvePromise();
    child.on('exit', done);
    child.on('error', done);
  });
}
