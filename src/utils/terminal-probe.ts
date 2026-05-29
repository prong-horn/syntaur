import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
 * Standard `.app` bundle locations, used as a fallback when `mdfind` returns
 * nothing — `mdfind` exits 0 with empty stdout in non-indexed / launchd /
 * background contexts, falsely reporting an installed app as missing. For
 * non-system terminals these are bundle *names* resolved against the
 * applications directories; Terminal.app ships at a fixed system path.
 *
 * Keep in sync with `detectInstalledTerminals()` in
 * scripts/install-macos-url-handler.mjs.
 */
export const APP_BUNDLE_NAMES: Partial<Record<TerminalChoice, string>> = {
  iterm: 'iTerm.app',
  ghostty: 'Ghostty.app',
  warp: 'Warp.app',
};

/** Fixed absolute paths for apps not found under the applications dirs. */
const APP_FIXED_PATHS: Partial<Record<TerminalChoice, string>> = {
  'terminal-app': '/System/Applications/Utilities/Terminal.app',
};

/** Default macOS application directories searched for `.app` bundles. */
function defaultApplicationsDirs(): string[] {
  return ['/Applications', join(homedir(), 'Applications')];
}

/**
 * Find an installed `.app` bundle for a terminal by checking standard
 * locations on disk. Returns the absolute path to the bundle, or null. The
 * `dirs` parameter is injectable so tests can point at a temp directory
 * instead of the host's real /Applications.
 */
export function findAppBundle(
  terminal: TerminalChoice,
  dirs: string[] = defaultApplicationsDirs(),
): string | null {
  const fixed = APP_FIXED_PATHS[terminal];
  if (fixed && existsSync(fixed)) return fixed;

  const bundleName = APP_BUNDLE_NAMES[terminal];
  if (bundleName) {
    for (const dir of dirs) {
      const candidate = join(dir, bundleName);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

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
export function probeTerminalInstalled(
  terminal: TerminalChoice,
  /**
   * `applicationsDirsOverride` REPLACES (does not extend) the default
   * applications directories for the `.app` fallback. Production never sets it;
   * it exists so tests can point the fallback at a temp dir and stay isolated
   * from the host's real /Applications (merging with the defaults would make a
   * host that actually has the app produce a false positive).
   */
  opts: { applicationsDirsOverride?: string[] } = {},
): ProbeResult {
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
    // `mdfind` yielded no path. This covers BOTH a non-zero exit AND an exit 0
    // with empty stdout (Spotlight not indexing, e.g. background/launchd
    // contexts). Fall back to the standard `.app` locations before declaring
    // the terminal not installed.
    const bundlePath = findAppBundle(terminal, opts.applicationsDirsOverride);
    if (bundlePath) {
      return { ok: true, foundPath: bundlePath };
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
