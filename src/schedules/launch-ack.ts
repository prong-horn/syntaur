/**
 * Launch acknowledgment (Task 8b): "wrapper spawned" ≠ "agent running".
 * `executeLaunchPlan` resolves once the terminal wrapper has spawned, which for
 * unattended use is a false-success factory. After firing, the tick polls here
 * for PROOF the agent actually came up — a non-pending runtime marker (one with
 * a real `sessionId`) attributable to this launch — within `ackTimeoutMs`.
 * Found → the job goes `running` (session linked); timeout → `launch_failed`.
 *
 * Fresh/fork launches write a PENDING marker (no `sessionId`) for the wrapper
 * pid; `readRuntimeMarker` rejects those, so we never ack on a pending marker.
 * The default probe matches by cwd + write-time (the agent's real marker lands
 * under its own pid, a descendant of the wrapper).
 */

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readRuntimeMarker } from '../utils/session-id.js';
import type { LaunchHandle } from '../launch/execute.js';

export interface LaunchAckDeps {
  /** Epoch-ms clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Delay between polls. Defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Probe for proof of life; returns the linked sessionId or null. */
  probe?: (handle: LaunchHandle) => string | null;
  /** Poll cadence (ms). Default 1000. */
  pollIntervalMs?: number;
}

export interface AckResult {
  acked: boolean;
  sessionId?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function runtimeSessionsDir(): string {
  const override = process.env.SYNTAUR_RUNTIME_SESSIONS_DIR;
  return override && override.length > 0 ? override : join(homedir(), '.syntaur', 'runtime', 'sessions');
}

/**
 * Default probe: scan the runtime sessions dir for a NON-pending marker whose
 * cwd matches this launch and whose write-time is at/after the launch (`startedAt`
 * is captured at spawn time; a 1s slack absorbs clock skew). Among qualifying
 * markers, the NEWEST `writtenAt` wins — so a stale prior session in the same cwd
 * doesn't shadow this launch's fresh marker.
 *
 * Residual (documented v1 limitation): two unattended launches into the SAME cwd
 * within the ack window could be confused. In practice scheduled launches resolve
 * to per-assignment worktrees (distinct cwds), so this is rare; lineage/token
 * attribution is the hardening follow-up noted in the design doc.
 */
export function defaultAckProbe(handle: LaunchHandle): string | null {
  const dir = runtimeSessionsDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const startedMs = Date.parse(handle.startedAt);
  let best: { sessionId: string; writtenAt: number } | null = null;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const pid = Number.parseInt(name.slice(0, -'.json'.length), 10);
    if (!Number.isInteger(pid)) continue;
    const marker = readRuntimeMarker(pid, dir); // null unless it has a real sessionId
    if (!marker?.sessionId) continue;
    const cwdMatches = !handle.plan.cwd || marker.cwd === handle.plan.cwd;
    const writtenAt = marker.writtenAt ?? 0;
    const recent = !marker.writtenAt || Number.isNaN(startedMs) || writtenAt >= startedMs - 1000;
    if (cwdMatches && recent && (!best || writtenAt > best.writtenAt)) {
      best = { sessionId: marker.sessionId, writtenAt };
    }
  }
  return best?.sessionId ?? null;
}

/**
 * Poll for launch-ack until proof arrives or `ackTimeoutMs` elapses. The caller
 * (tick) guarantees `claimTtlMs > ackTimeoutMs + launchSlackMs`, so the claim
 * lease cannot expire (and the job be reaped) inside this window.
 */
export async function awaitLaunchAck(
  handle: LaunchHandle,
  ackTimeoutMs: number,
  deps: LaunchAckDeps = {},
): Promise<AckResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const probe = deps.probe ?? defaultAckProbe;
  const interval = deps.pollIntervalMs ?? 1000;
  const deadline = now() + ackTimeoutMs;
  for (;;) {
    const sessionId = probe(handle);
    if (sessionId) return { acked: true, sessionId };
    if (now() >= deadline) return { acked: false };
    await sleep(interval);
  }
}
