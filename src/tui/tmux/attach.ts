import { spawn } from 'node:child_process';

export function buildTmuxAttachArgv(sessionName: string): string[] {
  return ['attach-session', '-t', sessionName];
}

type MinimalChild = { on(evt: string, cb: (arg?: unknown) => void): void };
type SpawnLike = (cmd: string, args: string[], opts: { stdio: 'inherit' }) => MinimalChild;

export interface TmuxAttachResult {
  code: number | null;
  error?: Error;
}

/**
 * Runs `tmux attach-session` with inherited stdio and reports how it ended.
 * NEVER rejects (so a caller's `finally` — e.g. re-arming mouse tracking —
 * always runs): on `'exit'` resolves `{ code }` (coercing an undefined exit
 * code to `null`); on `'error'` (e.g. tmux binary missing) resolves
 * `{ code: null, error }` instead of silently discarding the failure.
 */
export function runTmuxAttach(sessionName: string, spawnFn?: SpawnLike): Promise<TmuxAttachResult> {
  const spawnImpl: SpawnLike = spawnFn ?? ((c, a, o) => spawn(c, a, o) as unknown as MinimalChild);
  return new Promise<TmuxAttachResult>((resolvePromise) => {
    const child = spawnImpl('tmux', buildTmuxAttachArgv(sessionName), { stdio: 'inherit' });
    child.on('exit', (code) => resolvePromise({ code: (code as number | null | undefined) ?? null }));
    child.on('error', (err) => resolvePromise({ code: null, error: err as Error }));
  });
}
