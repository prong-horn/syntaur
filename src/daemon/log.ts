// Minimal append-only logger + tail reader for ~/.syntaur/daemon.log. The repo
// has no logging abstraction, and the daemon needs a durable, greppable trail
// (dispatch/adopt/reap/kill events) plus a `daemon logs` tail. Records are
// written as one structured NDJSON object per line, but `daemon logs` renders
// them back to human-readable text (see formatLogLine) so users never see raw
// JSON. Logging must never throw — a full disk shouldn't crash the supervisor.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { daemonLogPath } from './paths.js';
import type { LogLevel, LogRecord } from './types.js';

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

/**
 * Append one structured NDJSON record to the daemon log (best-effort, never
 * throws). `event` is a short slug (e.g. `dispatch`, `reconcile`); `fields`
 * is free-form context; `ts` and `level` are stamped here.
 */
export function appendLog(
  event: string,
  fields: Record<string, unknown> = {},
  level: LogLevel = 'info',
  deps: LogDeps = {},
): void {
  const path = deps.path ?? daemonLogPath();
  const now = deps.now ?? (() => Date.now());
  const append = deps.append ?? defaultAppend;
  try {
    // JSON.stringify is inside the guard: a circular/unserializable field can
    // throw, and logging must never crash the supervisor.
    const record: LogRecord = { ts: new Date(now()).toISOString(), level, event, ...fields };
    append(path, `${JSON.stringify(record)}\n`);
  } catch {
    /* logging must never throw */
  }
}

/**
 * Render one raw daemon.log line to human-readable text for `daemon logs`.
 * Tolerant and never-throwing: valid `LogRecord` NDJSON → a formatted line;
 * a legacy `${iso} ${message}` plaintext line (pre-upgrade) → passed through
 * unchanged; malformed/partial JSON or any non-record → emitted raw. This is
 * what keeps a mixed legacy+NDJSON tail readable and never dumps raw JSON.
 */
export function formatLogLine(line: string): string {
  const trimmed = line.replace(/\s+$/, '');
  if (!trimmed.startsWith('{')) return trimmed; // legacy plaintext / blank → as-is
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed; // malformed JSON → raw
  }
  if (!parsed || typeof parsed !== 'object') return trimmed;
  const r = parsed as Record<string, unknown>;
  if (typeof r.event !== 'string' || typeof r.ts !== 'string') return trimmed; // not a LogRecord → raw
  const level = typeof r.level === 'string' ? r.level : 'info';
  const extras = Object.entries(r)
    .filter(([k]) => k !== 'ts' && k !== 'level' && k !== 'event')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return `${r.ts} [${level}] ${r.event}${extras ? ` ${extras}` : ''}`;
}

/** Return the last `n` non-empty lines of the daemon log (newest last, raw). */
export function tailLog(n: number, deps: LogDeps = {}): string[] {
  const path = deps.path ?? daemonLogPath();
  const read = deps.read ?? defaultRead;
  const raw = read(path);
  if (!raw) return [];
  const lines = raw.split('\n').filter((l) => l.length > 0);
  return n >= lines.length ? lines : lines.slice(-n);
}
