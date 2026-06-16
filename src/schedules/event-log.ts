/**
 * Append-only, machine-readable per-job event log at
 * `~/.syntaur/schedules/<id>.jsonl` — one JSON object per line. It is the
 * stream a future orchestrator tails and doubles as a human audit trail. It is
 * NARRATION, not state: the authoritative mutable state is the job file's
 * frontmatter (store.ts). Reads tolerate a torn final line (a crash mid-append).
 */

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { nowTimestamp } from '../utils/timestamp.js';
import { schedulesDir } from './store.js';
import type { JobEvent, JobEventType } from './types.js';

export function eventLogPath(jobId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new Error(`Unsafe schedule id: ${JSON.stringify(jobId)}`);
  }
  return resolve(schedulesDir(), `${jobId}.jsonl`);
}

/** Append one event. Stamps `at` when the caller didn't. Never throws on a
 * missing dir — it creates it (the schedules dir may not exist on first use). */
export async function appendEvent(
  jobId: string,
  type: JobEventType,
  data?: Record<string, unknown>,
): Promise<JobEvent> {
  const event: JobEvent = { type, at: nowTimestamp(), ...(data ? { data } : {}) };
  const path = eventLogPath(jobId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, 'utf-8');
  return event;
}

/** Read all events in order. A torn final line (no trailing newline) is dropped
 * rather than throwing — the next append starts a fresh line. */
export async function readEvents(jobId: string): Promise<JobEvent[]> {
  let content: string;
  try {
    content = await readFile(eventLogPath(jobId), 'utf-8');
  } catch {
    return [];
  }
  const events: JobEvent[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as JobEvent);
    } catch {
      // Only the final line may be legitimately torn; a parse failure earlier
      // means real corruption, but we still skip rather than poison the read.
    }
  }
  return events;
}
