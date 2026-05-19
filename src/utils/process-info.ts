import { execFileSync } from 'node:child_process';

/**
 * Capture the start-time of a process via `ps -o lstart=`. Used as the
 * recycling-defense baseline for session liveness detection: the server later
 * compares this stored start-time to the current `ps -o lstart=` output, so a
 * recycled PID with the same number but different start-time correctly
 * reports as not-live.
 *
 * Returns null when `ps` fails (process already gone, or `ps` not on PATH).
 * Null is the expected sentinel for "no recycling baseline available" — the
 * liveness check trusts `kill -0` alone in that case (small false-positive
 * risk on PID reuse, acceptable).
 */
export function captureProcessStartedAt(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}
