import { spawn } from 'node:child_process';

export function buildClaudeAttachArgv(shortId: string): string[] {
  return ['attach', shortId];
}

type MinimalChild = { on(evt: string, cb: (arg?: unknown) => void): void };
type SpawnLike = (cmd: string, args: string[], opts: { stdio: 'inherit' }) => MinimalChild;

export interface ClaudeAttachResult {
  code: number | null;
  error?: Error;
}

/**
 * Runs `claude attach <shortId>` with inherited stdio and reports how it
 * ended. Never rejects (so a caller's `finally` — e.g. re-arming mouse
 * tracking — always runs): on
 * `'exit'` resolves `{ code }` (coercing an undefined exit code to `null`);
 * on `'error'` (e.g. the claude binary missing) resolves `{ code: null,
 * error }` instead of throwing.
 */
export function runClaudeAttach(shortId: string, spawnFn?: SpawnLike): Promise<ClaudeAttachResult> {
  const spawnImpl: SpawnLike = spawnFn ?? ((c, a, o) => spawn(c, a, o) as unknown as MinimalChild);
  return new Promise<ClaudeAttachResult>((resolvePromise) => {
    const child = spawnImpl('claude', buildClaudeAttachArgv(shortId), { stdio: 'inherit' });
    child.on('exit', (code) => resolvePromise({ code: (code as number | null | undefined) ?? null }));
    child.on('error', (err) => resolvePromise({ code: null, error: err as Error }));
  });
}
