// Minimal append-only logger + tail reader for ~/.syntaur/daemon.log. The repo
// has no logging abstraction, and the daemon needs a durable, greppable trail
// (dispatch/adopt/reap/kill events) plus a `daemon logs` tail. Logging must
// never throw — a full disk shouldn't crash the supervisor.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { daemonLogPath } from './paths.js';

export interface LogDeps {
  path?: string;
  now?: () => number;
  append?: (path: string, data: string) => void;
  read?: (path: string) => string | null;
}

function defaultAppend(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, data);
}

function defaultRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Append one timestamped line to the daemon log (best-effort, never throws). */
export function appendLog(message: string, deps: LogDeps = {}): void {
  const path = deps.path ?? daemonLogPath();
  const now = deps.now ?? (() => Date.now());
  const append = deps.append ?? defaultAppend;
  try {
    append(path, `${new Date(now()).toISOString()} ${message}\n`);
  } catch {
    /* logging must never throw */
  }
}

/** Return the last `n` non-empty lines of the daemon log (newest last). */
export function tailLog(n: number, deps: LogDeps = {}): string[] {
  const path = deps.path ?? daemonLogPath();
  const read = deps.read ?? defaultRead;
  const raw = read(path);
  if (!raw) return [];
  const lines = raw.split('\n').filter((l) => l.length > 0);
  return n >= lines.length ? lines : lines.slice(-n);
}
