import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { captureProcessStartedAt } from './process-info.js';
import {
  acquireLockRecordSerialized,
  recoverStaleLockRecordSerialized,
  releaseLockRecordSerialized,
} from './lock-coordination.js';

export interface OwnerRecord {
  pid: number;
  processStartedAt: string | null;
  ownerToken: string;
  port?: number;
}

export function mintOwnerToken(): string {
  return randomBytes(16).toString('hex');
}

/** Whether `pid` is definitely gone (ESRCH). EPERM means alive or unknown. */
export function isPidDefinitelyDead(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ESRCH';
  }
}

export function parseOwnerRecord(raw: string): OwnerRecord | null {
  const lines = raw.trim().split('\n');
  if (lines.length < 3) return null;
  const pid = Number.parseInt(lines[0], 10);
  if (!Number.isFinite(pid)) return null;
  const processStartedAt = lines[1] === '' ? null : lines[1];
  const ownerToken = lines[2]?.trim();
  if (!ownerToken) return null;
  let port: number | undefined;
  if (lines[3] !== undefined && lines[3] !== '') {
    const p = Number.parseInt(lines[3], 10);
    if (Number.isFinite(p) && p >= 1 && p <= 65535) port = p;
  }
  return { pid, processStartedAt, ownerToken, port };
}

export async function readOwnerRecord(path: string): Promise<OwnerRecord | null> {
  const { readFile } = await import('node:fs/promises');
  try {
    const raw = await readFile(path, 'utf-8');
    return parseOwnerRecord(raw);
  } catch {
    return null;
  }
}

export function serializeOwnerRecord(record: OwnerRecord): string {
  const portLine = record.port !== undefined ? String(record.port) : '';
  return `${record.pid}\n${record.processStartedAt ?? ''}\n${record.ownerToken}\n${portLine}\n`;
}

/**
 * True when the live process matches the stored owner record. A recycled pid with
 * a different start identity is treated as a mismatch (dead owner).
 */
export function ownerIdentityMatches(
  record: OwnerRecord,
  livePid: number,
  liveStartedAt: string | null,
  liveToken: string,
): boolean {
  if (record.pid !== livePid || record.ownerToken !== liveToken) return false;
  if (record.processStartedAt && liveStartedAt) {
    return record.processStartedAt === liveStartedAt;
  }
  return true;
}

/**
 * Whether a stored owner record is provably stale. Unknown identity (EPERM on ps)
 * and malformed records are never treated as dead.
 */
export function isOwnerRecordDefinitelyStale(record: OwnerRecord): boolean {
  if (isPidDefinitelyDead(record.pid)) return true;
  if (!record.processStartedAt) return false;
  const liveStart = captureProcessStartedAt(record.pid);
  if (!liveStart) return false;
  return record.processStartedAt !== liveStart;
}

function ownerRecordIsDefinitelyStaleRaw(raw: string): boolean {
  const record = parseOwnerRecord(raw);
  if (!record) return false;
  return isOwnerRecordDefinitelyStale(record);
}

/**
 * Remove a stale owner record when the pid is absent or start identity mismatches.
 * All conforming mutation paths share the runtime coordination DB mutex.
 */
export async function recoverStaleOwnerRecord(
  path: string,
  root?: string,
): Promise<boolean> {
  return recoverStaleLockRecordSerialized(path, ownerRecordIsDefinitelyStaleRaw, root);
}

export interface AcquiredOwnerHandle {
  record: OwnerRecord;
  release(): Promise<void>;
}

/**
 * Acquire an exclusive owner record at `path`. Fails immediately when a live owner
 * holds the record. Publishes via temp file + atomic rename under coordination.
 */
export async function acquireOwnerRecord(
  path: string,
  port?: number,
  root?: string,
): Promise<AcquiredOwnerHandle> {
  await mkdir(dirname(path), { recursive: true });
  const ownerToken = mintOwnerToken();
  const record: OwnerRecord = {
    pid: process.pid,
    processStartedAt: captureProcessStartedAt(process.pid),
    ownerToken,
    ...(port !== undefined ? { port } : {}),
  };
  const payload = serializeOwnerRecord(record);
  acquireLockRecordSerialized(path, payload, ownerRecordIsDefinitelyStaleRaw, root);
  let releaseOnce: Promise<void> | null = null;
  return {
    record,
    release() {
      if (!releaseOnce) {
        releaseOnce = Promise.resolve().then(() => {
          releaseLockRecordSerialized(
            path,
            record.ownerToken,
            record.pid,
            (raw) => parseOwnerRecord(raw),
            root,
          );
        });
      }
      return releaseOnce;
    },
  };
}
