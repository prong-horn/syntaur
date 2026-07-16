import { spawn } from 'node:child_process';
import { cliEntryPath } from '../../daemon/paths.js';

/**
 * Argv for the attach child: the built CLI entry + `attach <short>`. The
 * entry path is injectable for tests; the default is the same resolution
 * ensureDaemon uses to spawn the daemon, so there is no PATH dependence and
 * this works with no tmux installed at all.
 */
export function buildSyntaurAttachArgv(shortId: string, entryPath: string = cliEntryPath()): string[] {
  return [entryPath, 'attach', shortId];
}

type MinimalChild = { on(evt: string, cb: (arg?: unknown) => void): void };
type SpawnLike = (cmd: string, args: string[], opts: { stdio: 'inherit' }) => MinimalChild;

export interface SyntaurdAttachResult {
  code: number | null;
  error?: Error;
}

/**
 * Runs `syntaur attach <shortId>` (via process.execPath) with inherited
 * stdio and reports how it ended. Mirrors runTmuxAttach/runClaudeAttach's
 * never-reject contract exactly (so the caller's `finally` — re-arming
 * mouse tracking — always runs): on `'exit'` resolves `{ code }` (coercing
 * an undefined exit code to `null`); on `'error'` resolves
 * `{ code: null, error }` instead of throwing. Detach (Ctrl-]) and
 * session-exit both surface as a 0 exit — parity with the existing tiers.
 */
export function runSyntaurdAttach(shortId: string, spawnFn?: SpawnLike): Promise<SyntaurdAttachResult> {
  const spawnImpl: SpawnLike = spawnFn ?? ((c, a, o) => spawn(c, a, o) as unknown as MinimalChild);
  return new Promise<SyntaurdAttachResult>((resolvePromise) => {
    const child = spawnImpl(process.execPath, buildSyntaurAttachArgv(shortId), { stdio: 'inherit' });
    child.on('exit', (code) => resolvePromise({ code: (code as number | null | undefined) ?? null }));
    child.on('error', (err) => resolvePromise({ code: null, error: err as Error }));
  });
}
