// Socket + runtime path layout for the daemon (design doc §3).
//
//   /tmp/syntaur-<uid>/daemon.lock          exclusive-create discovery lock
//   /tmp/syntaur-<uid>/current.json         active-daemon pointer
//   /tmp/syntaur-<uid>/<daemonId>/control.sock
//   /tmp/syntaur-<uid>/<daemonId>/pty/<short>.sock
//   /tmp/syntaur-<uid>/<daemonId>/rv/<short>.sock
//   ~/.syntaur/jobs/<short>/state.json | timeline.jsonl
//   ~/.syntaur/daemon.log
//
// The runtime base defaults to `/tmp/syntaur-<uid>` (short, like cc-daemon's
// `/tmp/cc-daemon-501`) so socket paths stay under the AF_UNIX sun_path limit;
// SYNTAUR_RUNTIME_DIR overrides it (required for tests). The jobs dir hangs off
// syntaurRoot() so it honors SYNTAUR_HOME.

import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyntaurError } from '../errors.js';
import { expandHome, syntaurRoot } from '../utils/paths.js';

/** macOS caps AF_UNIX sun_path at 104 bytes, Linux at 108. Guard well under. */
const SUN_PATH_MAX = 100;

function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

/** Base runtime dir holding the lock, pointer, and per-daemon socket trees. */
export function runtimeBaseDir(): string {
  const override = process.env.SYNTAUR_RUNTIME_DIR;
  if (override && override.length > 0) return resolve(expandHome(override));
  return `/tmp/syntaur-${currentUid()}`;
}

export function daemonLockPath(): string {
  return join(runtimeBaseDir(), 'daemon.lock');
}

export function currentPointerPath(): string {
  return join(runtimeBaseDir(), 'current.json');
}

/**
 * Roster of live pty-hosts, kept in the runtime base (NOT under a daemonId) so a
 * restarting daemon — which owns a fresh daemonId — can still find and adopt the
 * previous generation's still-live hosts.
 */
export function rosterPath(): string {
  return join(runtimeBaseDir(), 'roster.json');
}

export function daemonDir(daemonId: string): string {
  return join(runtimeBaseDir(), daemonId);
}

export function ptyDir(daemonId: string): string {
  return join(daemonDir(daemonId), 'pty');
}

export function rvDir(daemonId: string): string {
  return join(daemonDir(daemonId), 'rv');
}

export function controlSockPath(daemonId: string): string {
  return guardSunPath(join(daemonDir(daemonId), 'control.sock'));
}

export function ptySockPath(daemonId: string, short: string): string {
  return guardSunPath(join(ptyDir(daemonId), `${short}.sock`));
}

export function rvSockPath(daemonId: string, short: string): string {
  return guardSunPath(join(rvDir(daemonId), `${short}.sock`));
}

// Jobs registry + daemon log hang off syntaurRoot() (honors SYNTAUR_HOME).

export function jobsDir(): string {
  return join(syntaurRoot(), 'jobs');
}

export function jobDir(short: string): string {
  return join(jobsDir(), short);
}

export function jobStatePath(short: string): string {
  return join(jobDir(short), 'state.json');
}

export function jobTimelinePath(short: string): string {
  return join(jobDir(short), 'timeline.jsonl');
}

export function daemonLogPath(): string {
  return join(syntaurRoot(), 'daemon.log');
}

/**
 * Throws a `SyntaurError` (not an assert) when a computed socket path would
 * exceed the kernel's sun_path limit — the kernel silently truncates longer
 * paths, so binding and connecting would land on different files. Remediation
 * points at the fix: a shorter daemon id / runtime dir.
 */
export function guardSunPath(p: string): string {
  if (Buffer.byteLength(p, 'utf8') > SUN_PATH_MAX) {
    throw new SyntaurError(
      `Unix socket path exceeds ${SUN_PATH_MAX} bytes (kernel would truncate it): ${p}`,
      {
        remediation:
          'Shorten the daemon id, or set SYNTAUR_RUNTIME_DIR to a shorter directory than the default /tmp/syntaur-<uid>.',
      },
    );
  }
  return p;
}

/**
 * Locate the built `dist/` dir by walking up from this module's URL. Robust
 * under bundling: this code runs as `dist/index.js` (bundled) OR, per-entry, as
 * `dist/daemon/<x>.js` — either way the nearest `dist` ancestor is the anchor.
 * (In vitest the module is the source file, which has no `dist` segment — but
 * the entry-path consumers inject explicit paths in tests, so the fallback is
 * never exercised there.)
 */
export function distDir(): string {
  const self = dirname(fileURLToPath(import.meta.url));
  let dir = self;
  for (let i = 0; i < 8 && dir !== dirname(dir); i += 1) {
    if (basename(dir) === 'dist') return dir;
    dir = dirname(dir);
  }
  return self;
}

/** Absolute path to the built CLI entry (`dist/index.js`). */
export function cliEntryPath(): string {
  return join(distDir(), 'index.js');
}

/** Absolute path to the built pty-host entry (`dist/daemon/pty-host-main.js`). */
export function ptyHostMainEntry(): string {
  return join(distDir(), 'daemon', 'pty-host-main.js');
}

/**
 * mkdir -p with mode 0700, then VERIFY the directory is safe to use: not a
 * symlink, owned by us, and mode 0700. On a shared /tmp an attacker can
 * pre-create `/tmp/syntaur-<uid>` (as a symlink or a dir they own), which
 * `mkdirSync` silently no-ops over and a swallowed chmod would leave in place.
 * Fail closed instead so we never write sockets/state into a hostile directory.
 */
export function ensureDir0700(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // chmod may fail if we don't own it — the lstat check below is authoritative.
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) {
    throw new SyntaurError(`Refusing to use ${dir}: it is a symlink.`, {
      remediation: 'Remove it, or set SYNTAUR_RUNTIME_DIR to a safe directory you own.',
    });
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw new SyntaurError(`Refusing to use ${dir}: it is owned by uid ${st.uid}, not ${uid}.`, {
      remediation: 'Remove it, or set SYNTAUR_RUNTIME_DIR to a safe directory you own.',
    });
  }
  if ((st.mode & 0o777) !== 0o700) {
    throw new SyntaurError(
      `Refusing to use ${dir}: mode is ${(st.mode & 0o777).toString(8)}, expected 700.`,
      { remediation: 'Fix its permissions (chmod 700), or set SYNTAUR_RUNTIME_DIR elsewhere.' },
    );
  }
}
