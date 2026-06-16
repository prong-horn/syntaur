import { spawn } from 'node:child_process';
import { getTerminal, type SyntaurConfig } from './config.js';
import type { TerminalChoice } from './terminal-schema.js';

/**
 * Spawn a detached process, swallowing both synchronous throws AND the async
 * `error` event (e.g. ENOENT for a missing binary) so a best-effort launch can
 * never crash the CLI. Returns whether the spawn was attempted without a
 * synchronous failure.
 */
function spawnDetached(command: string, args: string[]): boolean {
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // missing binary etc. -> async error, swallow it
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Open `path` in the user's editor. Prefers `$VISUAL`/`$EDITOR`; falls back to
 * `code` (VS Code) elsewhere or macOS `open` on darwin. Best-effort: spawns
 * detached, swallows failures, and returns whether a launch was attempted.
 */
export function openInEditor(path: string): boolean {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (editor) return spawnDetached(editor, [path]);
  return spawnDetached(process.platform === 'darwin' ? 'open' : 'code', [path]);
}

// macOS application names for `open -a <app> <path>` (opens a new window rooted
// at the directory). Used best-effort for `--terminal`.
const TERMINAL_APP: Record<TerminalChoice, string> = {
  'terminal-app': 'Terminal',
  iterm: 'iTerm',
  ghostty: 'Ghostty',
  alacritty: 'Alacritty',
  warp: 'Warp',
  kitty: 'kitty',
  cmux: 'cmux',
};

/**
 * Open a terminal at `path` using the configured terminal app. Best-effort and
 * darwin-only (uses `open -a <App> <dir>`); returns `false` elsewhere or on
 * failure. Not a generic agent launcher — for that use the launch plumbing.
 */
export function openInTerminal(path: string, config: SyntaurConfig): boolean {
  if (process.platform !== 'darwin') return false;
  const app = TERMINAL_APP[getTerminal(config)] ?? 'Terminal';
  return spawnDetached('open', ['-a', app, path]);
}
