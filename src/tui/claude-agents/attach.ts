import { spawn } from 'node:child_process';

/**
 * Argv for reaching a session hosted by Claude Code's OWN background daemon:
 * its Agent View picker.
 *
 * DELIBERATELY `['agents']`, never `['attach', shortId]`. **Claude Code has no
 * `attach` subcommand.** Its CLI is `claude [options] [command] [prompt]`, so an
 * unrecognized leading word is consumed as the PROMPT — `claude attach ab12cd34`
 * did not attach to anything, it launched a brand-new interactive Claude session
 * prompted `"attach ab12cd34"` (user-reported against 0.78.0, 2026-07-27; the
 * bogus argv traces back to the cockpit-v2 design doc, which asserted the
 * subcommand existed without ever running it).
 *
 * `claude agents` takes no positional session id (`claude agents [options]` —
 * verified against 2.1.205), so the interactive picker is the only affordance
 * Claude exposes for reaching one of its own background sessions. The caller
 * surfaces the short id so the user knows which row to select.
 *
 * Syntaur-hosted sessions do NOT come through here — they use the real
 * `syntaur attach <short>` (see ../syntaurd/attach.ts).
 */
export function buildClaudeAgentViewArgv(): string[] {
  return ['agents'];
}

type MinimalChild = { on(evt: string, cb: (arg?: unknown) => void): void };
type SpawnLike = (cmd: string, args: string[], opts: { stdio: 'inherit' }) => MinimalChild;

export interface ClaudeAttachResult {
  code: number | null;
  error?: Error;
}

/**
 * Opens Claude Code's Agent View (`claude agents`) with inherited stdio and
 * reports how it ended. Never rejects (so a caller's `finally` — e.g. re-arming
 * mouse tracking — always runs): on `'exit'` resolves `{ code }` (coercing an
 * undefined exit code to `null`); on `'error'` (e.g. the claude binary missing)
 * resolves `{ code: null, error }` instead of throwing.
 */
export function runClaudeAgentView(spawnFn?: SpawnLike): Promise<ClaudeAttachResult> {
  const spawnImpl: SpawnLike = spawnFn ?? ((c, a, o) => spawn(c, a, o) as unknown as MinimalChild);
  return new Promise<ClaudeAttachResult>((resolvePromise) => {
    const child = spawnImpl('claude', buildClaudeAgentViewArgv(), { stdio: 'inherit' });
    child.on('exit', (code) => resolvePromise({ code: (code as number | null | undefined) ?? null }));
    child.on('error', (err) => resolvePromise({ code: null, error: err as Error }));
  });
}
