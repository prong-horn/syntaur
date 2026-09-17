import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalPath } from './path-canon.js';
import { syntaurRoot } from './paths.js';
import { captureProcessStartedAt } from './process-info.js';
import {
  acquireLockRecordSerialized,
  releaseLockRecordSerialized,
} from './lock-coordination.js';
import {
  isOwnerRecordDefinitelyStale,
  isPidDefinitelyDead,
  parseOwnerRecord,
  type OwnerRecord,
} from './process-owner.js';

const LOCK_MAX_WAIT_MS = 5_000;

export interface TicketLockHandle {
  token: string;
  release(): Promise<void>;
}

function canonicalTicketPath(ticketPath: string): string {
  return canonicalPath(resolve(ticketPath));
}

function lockPathForTicket(ticketPath: string, root?: string): string {
  const base = root ?? syntaurRoot();
  const hash = createHash('sha256').update(canonicalTicketPath(ticketPath)).digest('hex');
  return resolve(base, 'runtime', 'locks', `${hash}.lock`);
}

function serializeLock(pid: number, startedAt: string | null, token: string): string {
  return `${pid}\n${startedAt ?? ''}\n${token}\n`;
}

function parseLock(raw: string): OwnerRecord | null {
  const parsed = parseOwnerRecord(raw);
  if (!parsed) return null;
  return parsed;
}

function isLockDefinitelyStale(record: OwnerRecord): boolean {
  return isOwnerRecordDefinitelyStale(record);
}

function lockRecordIsDefinitelyStaleRaw(raw: string): boolean {
  const parsed = parseLock(raw);
  if (!parsed) return false;
  return isLockDefinitelyStale(parsed);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Acquire an exclusive per-ticket mutation lock. Waits up to LOCK_MAX_WAIT_MS.
 * Never evicts a live owner by elapsed time or unknown process identity.
 */
export async function acquireTicketMutationLock(
  ticketPath: string,
  root?: string,
): Promise<TicketLockHandle> {
  const lockPath = lockPathForTicket(ticketPath, root);
  await mkdir(resolve(lockPath, '..'), { recursive: true });
  const token = randomBytes(16).toString('hex');
  const payload = serializeLock(process.pid, captureProcessStartedAt(process.pid), token);
  const started = Date.now();
  let backoff = 25;
  while (Date.now() - started < LOCK_MAX_WAIT_MS) {
    try {
      acquireLockRecordSerialized(lockPath, payload, lockRecordIsDefinitelyStaleRaw, root);
      let releaseOnce: Promise<void> | null = null;
      return {
        token,
        release() {
          if (!releaseOnce) {
            releaseOnce = Promise.resolve().then(() => {
              releaseLockRecordSerialized(
                lockPath,
                token,
                process.pid,
                (raw) => parseLock(raw),
                root,
              );
            });
          }
          return releaseOnce;
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 500);
    }
  }
  throw new Error(`Timed out acquiring ticket mutation lock for ${ticketPath}`);
}

export async function withTicketMutationLock<T>(
  ticketPath: string,
  fn: (handle: TicketLockHandle) => Promise<T>,
  root?: string,
): Promise<T> {
  const handle = await acquireTicketMutationLock(ticketPath, root);
  try {
    return await fn(handle);
  } finally {
    await handle.release();
  }
}

/** @internal */
export const _internal = {
  lockPathForTicket,
  parseLock,
  canonicalTicketPath,
  isLockDefinitelyStale,
  isPidDefinitelyDead,
};
