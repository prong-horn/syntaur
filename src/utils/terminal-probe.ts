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
 * scripts/install-macos-url-handler.mjs — EXCEPT `cmux`, which is intentionally
 * present here but absent from `detectInstalledTerminals()`. That function lists
 * the *AppleScript-driven* terminals (the applet runs `tell application` blocks
 * for them); cmux is CLI-driven and falls through to `executeLaunchPlan`, so it
 * must not be added there. `cmux.app` is listed here only so `findAppBundle`
 * (and `resolveCmuxCli`) can locate the bundle that contains the cmux CLI.
 */
export const APP_BUNDLE_NAMES: Partial<Record<TerminalChoice, string>> = {
  iterm: 'iTerm.app',
  ghostty: 'Ghostty.app',
  warp: 'Warp.app',
  cmux: 'cmux.app',
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
  // cmux is CLI-driven, but its CLI lives inside the app bundle (not on a
  // standard PATH dir), so detection uses `resolveCmuxCli` rather than a bare
  // `which cmux`. The entry here is for doctor messaging (e.g. "resolved cmux
  // → <path>") and to document cmux as CLI-driven.
  cmux: 'cmux',
};

/**
 * Canonical absolute directories a cmux CLI symlink/binary may live in, checked
 * by `existsSync` (PATH-independent) so resolution agrees between the dashboard
 * server (full PATH) and the macOS applet (stripped PATH). Exported for tests.
 */
export const CMUX_CLI_DIRS: readonly string[] = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
];

/**
 * Queries LaunchServices for the bundle path of the RUNNING cmux app. Returns
 * the raw `lsappinfo` stdout, or null when the query fails or cmux is not
 * running. Injectable (see `resolveCmuxCli`) so tests never shell out to the
 * host's real `/usr/bin/lsappinfo`.
 */
export type CmuxLsappinfoRunner = () => string | null;

/**
 * Default running-app lookup: ask LaunchServices where the running cmux lives.
 * Invokes `/usr/bin/lsappinfo` by ABSOLUTE path so it resolves under the
 * `syntaur://` URL-handler applet's stripped LaunchServices PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), where a bare `lsappinfo` is unresolvable.
 * Returns stdout on a clean exit, else null (non-zero exit / spawn failure).
 */
const defaultCmuxLsappinfoRunner: CmuxLsappinfoRunner = () => {
  const result = spawnSync(
    '/usr/bin/lsappinfo',
    ['info', '-only', 'bundlepath', 'com.cmuxterm.app'],
    { encoding: 'utf-8' },
  );
  return result.status === 0 ? result.stdout : null;
};

/**
 * Absolute path to the cmux CLI (inside the app bundle, a canonical install
 * dir, the running app's bundle, or on PATH), or null when cmux is not
 * installed.
 *
 * cmux is controlled by a first-party CLI that ships *inside* the app bundle at
 * `Contents/Resources/bin/cmux` and is NOT on any standard PATH dir. The macOS
 * `syntaur://` URL-handler applet, which drives the production "Open in agent"
 * flow, launches with a stripped LaunchServices PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), where a bare `cmux` is unresolvable. So
 * BOTH detection (this probe) and launch (`buildTerminalInvocation`) must
 * resolve an absolute path; sharing one resolver keeps server-side preflight
 * and the actual applet launch consistent.
 *
 * Resolution order, chosen so resolution is PATH-independent on macOS (where the
 * applet launch is the only stripped-PATH context) — server preflight and the
 * applet then agree by construction:
 *   1. the bundle CLI (`findAppBundle` → `Contents/Resources/bin/cmux`)
 *   2. a canonical install dir (`CMUX_CLI_DIRS`, via `existsSync` — covers a
 *      Homebrew/`/usr/local` symlink even under the applet's stripped PATH)
 *   3. the RUNNING app via LaunchServices (`/usr/bin/lsappinfo info -only
 *      bundlepath com.cmuxterm.app` → `<bundle>/Contents/Resources/bin/cmux`),
 *      darwin-only. This catches a cmux launched from a non-canonical location
 *      (e.g. straight off a mounted DMG at `/Volumes/cmux/cmux.app`) that misses
 *      every fixed location above. Steps 1–2 keep priority — when a canonical
 *      copy exists but a DIFFERENT copy is running, the canonical CLI drives the
 *      running app over the shared control socket: fine while versions match
 *      (both 0.64.13 today), could skew after an update. That caveat is
 *      documented, not guarded at runtime. Not-running + non-canonical
 *      legitimately stays unresolved (a cold start from nowhere is unlaunchable)
 *      and surfaces as not-installed.
 *   4. `which cmux` — PATH-DEPENDENT, so it is consulted ONLY off macOS. On
 *      darwin we deliberately skip it: a cmux reachable only via a non-canonical
 *      PATH dir would pass the full-PATH server preflight but be invisible to
 *      the stripped-PATH applet, so accepting it would be a false positive.
 *      Skipping it makes macOS detection consistent with the applet (real macOS
 *      installs are the .app bundle, or now the running-app lookup above). Off
 *      macOS there is no stripped-PATH applet, so launch and preflight share the
 *      same PATH.
 *
 * `applicationsDirsOverride` / `cliDirsOverride` / `lsappinfoRunnerOverride`
 * REPLACE the defaults so tests stay hermetic from the host's real
 * `/Applications`, `/usr/local/bin`, and `/usr/bin/lsappinfo`.
 */
export function resolveCmuxCli(
  applicationsDirsOverride?: string[],
  cliDirsOverride?: string[],
  lsappinfoRunnerOverride?: CmuxLsappinfoRunner,
): string | null {
  const bundle = findAppBundle('cmux', applicationsDirsOverride);
  if (bundle) {
    const cli = join(bundle, 'Contents/Resources/bin/cmux');
    if (existsSync(cli)) return cli;
  }
  for (const dir of cliDirsOverride ?? CMUX_CLI_DIRS) {
    const cli = join(dir, 'cmux');
    if (existsSync(cli)) return cli;
  }
  if (process.platform === 'darwin') {
    // Running-app fallback: a cmux launched from a non-canonical location is
    // invisible to the fixed checks above. Ask LaunchServices where it lives.
    const runner = lsappinfoRunnerOverride ?? defaultCmuxLsappinfoRunner;
    const stdout = runner();
    if (stdout) {
      // lsappinfo emits e.g. ` "LSBundlePath"="/Volumes/cmux/cmux.app"\n` with
      // leading whitespace and a trailing newline — do NOT anchor the match.
      const match = stdout.match(/"LSBundlePath"="([^"]+)"/);
      if (match) {
        const cli = join(match[1], 'Contents/Resources/bin/cmux');
        if (existsSync(cli)) return cli;
      }
    }
    // darwin deliberately skips `which` (see step 4) — fall through to null.
    return null;
  }
  const which = spawnSync('which', ['cmux'], { encoding: 'utf-8' });
  if (which.status === 0 && which.stdout.trim().length > 0) {
    return which.stdout.trim();
  }
  return null;
}

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
  opts: {
    applicationsDirsOverride?: string[];
    /** REPLACES `CMUX_CLI_DIRS` for the cmux resolver; tests only. */
    cmuxCliDirsOverride?: string[];
    /** REPLACES the default `/usr/bin/lsappinfo` runner; tests only. */
    cmuxLsappinfoRunnerOverride?: CmuxLsappinfoRunner;
  } = {},
): ProbeResult {
  // cmux is special-cased before the generic bundle-id / CLI-name paths: its
  // control CLI lives inside the app bundle and is not on a standard PATH dir,
  // so neither the `mdfind` bundle-id path (cmux is deliberately absent from
  // APP_BUNDLE_IDS — it would resolve the `.app`, not the CLI) nor a bare
  // `which cmux` is correct. `resolveCmuxCli` finds the bundle CLI (or canonical
  // dir / PATH fallback) and is the same resolver `buildTerminalInvocation`
  // uses, so detection and launch agree under a stripped PATH.
  if (terminal === 'cmux') {
    const cli = resolveCmuxCli(
      opts.applicationsDirsOverride,
      opts.cmuxCliDirsOverride,
      opts.cmuxLsappinfoRunnerOverride,
    );
    return cli
      ? { ok: true, foundPath: cli }
      : { ok: false, reason: 'not-installed' };
  }

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
