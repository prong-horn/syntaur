import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  acquireOwnerRecord,
  recoverStaleOwnerRecord,
  serializeOwnerRecord,
} from '../../utils/process-owner.js';

function brokerOwnerPath(root: string): string {
  return join(root, 'runtime', 'broker-owner');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isSqliteLocked(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('database is locked');
}

async function withSqliteLockRetry<T>(label: string, fn: () => Promise<T>, attempts = 200): Promise<T> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isSqliteLocked(err)) throw err;
      await sleep(5);
    }
  }
  throw new Error(`${label} failed after ${attempts} SQLITE_BUSY retries`);
}

async function writeBarrierAtomic(barrierDir: string, name: string, content: string): Promise<void> {
  const finalPath = join(barrierDir, name);
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, finalPath);
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${path}`);
}

/** Retry acquire after EEXIST so contenders wait for the live holder to release. */
async function acquireOwnerAfterContention(
  ownerPath: string,
  port: number,
  home: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await acquireOwnerRecord(ownerPath, port, home);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      await sleep(5);
    }
  }
  throw new Error(`timed out acquiring owner record at ${ownerPath}`);
}

export async function runLockCoordChild(op: string): Promise<void> {
  const home = process.env.LOCK_COORD_HOME ?? process.env.SYNTAUR_HOME;
  const barrierDir = process.env.LOCK_BARRIER_DIR;
  const slot = process.env.LOCK_CHILD_SLOT ?? '0';
  if (!home || !barrierDir) {
    throw new Error('lock coord child requires LOCK_COORD_HOME and LOCK_BARRIER_DIR');
  }
  await mkdir(barrierDir, { recursive: true });
  const ownerPath = brokerOwnerPath(home);

  if (op === 'recover-acquire-release') {
    const recovered = await withSqliteLockRetry('recoverStaleOwnerRecord', () =>
      recoverStaleOwnerRecord(ownerPath, home),
    );
    await writeBarrierAtomic(barrierDir, `recovered-${slot}`, recovered ? '1' : '0');
    await waitForFile(join(barrierDir, 'go'));
    const handle = await acquireOwnerAfterContention(ownerPath, Number(slot) + 10, home);
    await writeBarrierAtomic(barrierDir, `acquired-${slot}`, handle.record.ownerToken);
    await handle.release();
    await writeBarrierAtomic(barrierDir, `done-${slot}`, '1');
    return;
  }

  if (op === 'recover-then-contend') {
    await waitForFile(join(barrierDir, 'seeded'));
    const recovered = await withSqliteLockRetry('recoverStaleOwnerRecord', () =>
      recoverStaleOwnerRecord(ownerPath, home),
    );
    await writeBarrierAtomic(barrierDir, `recover-${slot}`, recovered ? '1' : '0');
    await writeBarrierAtomic(barrierDir, `ready-${slot}`, '1');
    await waitForFile(join(barrierDir, 'contend'));
    try {
      const handle = await withSqliteLockRetry('acquireOwnerRecord', () =>
        acquireOwnerRecord(ownerPath, 9000 + Number(slot), home),
      );
      await writeBarrierAtomic(barrierDir, `winner-${slot}`, handle.record.ownerToken);
      await waitForFile(join(barrierDir, 'release'));
      await handle.release();
    } catch {
      await writeBarrierAtomic(barrierDir, `loser-${slot}`, '1');
    }
    await writeBarrierAtomic(barrierDir, `done-${slot}`, '1');
    return;
  }

  if (op === 'seed-stale') {
    await mkdir(join(home, 'runtime'), { recursive: true });
    await writeFile(
      ownerPath,
      serializeOwnerRecord({
        pid: 999_999,
        processStartedAt: 'Tue Jan  1 00:00:00 2020',
        ownerToken: 'dead-token',
        port: 1,
      }),
      'utf-8',
    );
    await writeBarrierAtomic(barrierDir, 'seeded', '1');
    return;
  }

  throw new Error(`unknown lock coord op: ${op}`);
}
