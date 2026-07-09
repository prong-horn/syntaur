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

import { chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

/** mkdir -p with mode 0700, chmod'd afterward to defeat the process umask. */
export function ensureDir0700(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort; a chmod failure shouldn't abort a bind
  }
}
