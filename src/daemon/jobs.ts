// Jobs registry: `~/.syntaur/jobs/<short>/state.json` + `timeline.jsonl`.
//
// Phase A persists ONLY this dir and the roster (Decision 2). state.json is
// written atomically (tmp + rename) so a concurrent reader never sees a torn
// file; the timeline is an append-only JSONL audit trail. Everything hangs off
// syntaurRoot(), so SYNTAUR_HOME redirects it in tests.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { jobDir, jobStatePath, jobTimelinePath, jobsDir } from './paths.js';
import type { JobState } from './types.js';

/** Read one job's state.json, or null when missing/corrupt. */
export function readJobState(short: string): JobState | null {
  try {
    return JSON.parse(readFileSync(jobStatePath(short), 'utf8')) as JobState;
  } catch {
    return null;
  }
}

/** Atomically write a job's state.json (tmp + rename). */
export function writeJobState(state: JobState): void {
  mkdirSync(jobDir(state.short), { recursive: true });
  const path = jobStatePath(state.short);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Append one event to a job's timeline.jsonl (stamps `at` if omitted). */
export function appendTimeline(
  short: string,
  event: { event: string; at?: string; [key: string]: unknown },
): void {
  mkdirSync(jobDir(short), { recursive: true });
  const stamped = { ...event, at: event.at ?? new Date().toISOString() };
  appendFileSync(jobTimelinePath(short), `${JSON.stringify(stamped)}\n`);
}

/** Short ids of every job dir under `~/.syntaur/jobs/`. */
export function listJobShorts(): string[] {
  try {
    return readdirSync(jobsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Every readable job state (skips corrupt/missing). */
export function readAllJobStates(): JobState[] {
  const out: JobState[] = [];
  for (const short of listJobShorts()) {
    const s = readJobState(short);
    if (s) out.push(s);
  }
  return out;
}
