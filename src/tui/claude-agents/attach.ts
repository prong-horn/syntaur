import { spawn } from 'node:child_process';

/**
 * Argv for directly attaching to a session hosted by Claude Code's own
 * background daemon: `claude attach <shortId>`.
 *
 * `attach` is a HIDDEN commander command — absent from `claude --help`, but
 * real (2.1.218+: "Open the background session in this terminal"). Because
 * hidden ≠ universal, callers MUST gate this argv behind
 * `checkClaudeAttachCommand()` (capability.ts): on an older claude the CLI is
 * `claude [options] [command] [prompt]` and the unrecognized word `attach` is
 * consumed as the PROMPT — spawning this blindly launched a brand-new session
 * prompted "attach <short>" instead of attaching (user-reported against
 * 0.78.0 on a machine with an older claude). With the command present, an
 * unknown/stale id fails cleanly: `No job matching '<id>'` (exit 1).
 *
 * Only `kind: "background"` rows carry a short id in `claude agents --json`;
 * interactive sessions have no daemon job to attach to (the reachability
 * guard in actions.ts already excludes them). Syntaur-hosted sessions do NOT
 * come through here — they use `syntaur attach <short>` (../syntaurd/attach.ts).
 */
export function buildClaudeAttachArgv(shortId: string): string[] {
  return ['attach', shortId];
}

/**
 * Fallback affordance when the installed claude lacks the hidden `attach`
 * command: its Agent View picker. `claude agents` takes no positional session
 * id, so the caller surfaces the short id in the status line and the user
 * selects the row inside the picker.
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

function runClaude(argv: string[], spawnFn?: SpawnLike): Promise<ClaudeAttachResult> {
  const spawnImpl: SpawnLike = spawnFn ?? ((c, a, o) => spawn(c, a, o) as unknown as MinimalChild);
  return new Promise<ClaudeAttachResult>((resolvePromise) => {
    const child = spawnImpl('claude', argv, { stdio: 'inherit' });
    child.on('exit', (code) => resolvePromise({ code: (code as number | null | undefined) ?? null }));
    child.on('error', (err) => resolvePromise({ code: null, error: err as Error }));
  });
}

/**
 * Runs `claude attach <shortId>` with inherited stdio and reports how it
 * ended. GATE BEHIND `checkClaudeAttachCommand()` — see buildClaudeAttachArgv.
 * Never rejects (so a caller's `finally` — e.g. re-arming mouse tracking —
 * always runs): on `'exit'` resolves `{ code }` (coercing an undefined exit
 * code to `null`); on `'error'` (e.g. the claude binary missing) resolves
 * `{ code: null, error }` instead of throwing.
 */
export function runClaudeAttach(shortId: string, spawnFn?: SpawnLike): Promise<ClaudeAttachResult> {
  return runClaude(buildClaudeAttachArgv(shortId), spawnFn);
}

/**
 * Opens Claude Code's Agent View (`claude agents`) with inherited stdio —
 * the fallback when the hidden `attach` command is unavailable. Same
 * never-reject contract as runClaudeAttach.
 */
export function runClaudeAgentView(spawnFn?: SpawnLike): Promise<ClaudeAttachResult> {
  return runClaude(buildClaudeAgentViewArgv(), spawnFn);
}
