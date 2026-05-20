import { spawnSync } from 'node:child_process';
import type { TerminalChoice } from './terminal-schema.js';

/**
 * macOS bundle identifiers for Apple-Event-driven terminals. Used with
 * `mdfind kMDItemCFBundleIdentifier == '<id>'` to confirm install.
 */
export const APP_BUNDLE_IDS: Partial<Record<TerminalChoice, string>> = {
  'terminal-app': 'com.apple.Terminal',
  iterm: 'com.googlecode.iterm2',
  ghostty: 'com.mitchellh.ghostty',
  warp: 'dev.warp.Warp-Stable',
};

/**
 * CLI names for shell-out-driven terminals. Used with `which <name>` to
 * confirm install on PATH.
 */
export const CLI_NAMES: Partial<Record<TerminalChoice, string>> = {
  alacritty: 'alacritty',
  kitty: 'kitty',
};

export interface ProbeResult {
  ok: boolean;
  /** Absolute path to the .app bundle or CLI binary, when found. */
  foundPath?: string;
  /** Why the probe returned ok:false. */
  reason?: 'not-installed' | 'no-probe-available';
}

/**
 * Probe whether a terminal is installed on this machine, using the same
 * primitives as the doctor `terminal.installed` check:
 *   - `mdfind` for Apple-Event terminals registered with LaunchServices
 *   - `which` for CLI terminals on PATH
 *
 * Returns `{ ok: false, reason: 'no-probe-available' }` when the terminal id
 * has no entry in either map — this should be impossible for known
 * `TerminalChoice` values but lets callers handle a future terminal addition
 * gracefully.
 */
export function probeTerminalInstalled(terminal: TerminalChoice): ProbeResult {
  const bundleId = APP_BUNDLE_IDS[terminal];
  if (bundleId) {
    const result = spawnSync(
      'mdfind',
      [`kMDItemCFBundleIdentifier == '${bundleId}'`],
      { encoding: 'utf-8' },
    );
    if (result.status === 0 && result.stdout.trim().length > 0) {
      return { ok: true, foundPath: result.stdout.trim().split('\n')[0] };
    }
    return { ok: false, reason: 'not-installed' };
  }

  const cliName = CLI_NAMES[terminal];
  if (cliName) {
    const result = spawnSync('which', [cliName], { encoding: 'utf-8' });
    if (result.status === 0 && result.stdout.trim().length > 0) {
      return { ok: true, foundPath: result.stdout.trim() };
    }
    return { ok: false, reason: 'not-installed' };
  }

  return { ok: false, reason: 'no-probe-available' };
}
