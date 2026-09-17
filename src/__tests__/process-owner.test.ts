import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  acquireOwnerRecord,
  isOwnerRecordDefinitelyStale,
  ownerIdentityMatches,
  parseOwnerRecord,
  recoverStaleOwnerRecord,
  serializeOwnerRecord,
} from '../utils/process-owner.js';
import { captureProcessStartedAt } from '../utils/process-info.js';
import {
  acquireHomeOwnerLock,
  brokerOwnerPath,
  readHomeOwnerRecord,
} from '../chat/broker-owner.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sv11-owner-'));
  process.env.SYNTAUR_HOME = home;
});

afterEach(async () => {
  delete process.env.SYNTAUR_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('process owner records', () => {
  it('publishes a fully initialized owner record atomically', async () => {
    const path = join(home, 'runtime', 'broker-owner');
    const handle = await acquireOwnerRecord(path, 54321);
    const raw = await readFile(path, 'utf-8');
    const parsed = parseOwnerRecord(raw);
    expect(parsed?.pid).toBe(process.pid);
    expect(parsed?.port).toBe(54321);
    expect(parsed?.ownerToken).toBe(handle.record.ownerToken);
    await handle.release();
  });

  it('refuses a second live owner immediately', async () => {
    const path = brokerOwnerPath(home);
    const first = await acquireHomeOwnerLock(11111, home);
    await expect(acquireHomeOwnerLock(22222, home)).rejects.toThrow(/already held/);
    await first.release();
    const second = await acquireHomeOwnerLock(22222, home);
    expect((await readHomeOwnerRecord(home))?.port).toBe(22222);
    await second.release();
  });

  it('does not recover malformed owner records', async () => {
    const path = brokerOwnerPath(home);
    await mkdir(resolve(home, 'runtime'), { recursive: true });
    await writeFile(path, 'not-valid\n', 'utf-8');
    expect(await recoverStaleOwnerRecord(path)).toBe(false);
    expect(await readFile(path, 'utf-8')).toBe('not-valid\n');
  });

  it('releases only matching token ownership', async () => {
    const path = brokerOwnerPath(home);
    const handle = await acquireHomeOwnerLock(33333, home);
    const raw = await readFile(path, 'utf-8');
    const parsed = parseOwnerRecord(raw)!;
    await writeFile(
      path,
      serializeOwnerRecord({ ...parsed, ownerToken: 'other-token' }),
      'utf-8',
    );
    await handle.release();
    expect(await readFile(path, 'utf-8')).toContain('other-token');
    await rm(path);
  });

  it('serializes two recoverers so a fresh successor survives', async () => {
    const path = brokerOwnerPath(home);
    await mkdir(resolve(home, 'runtime'), { recursive: true });
    const stale = serializeOwnerRecord({
      pid: 999_999,
      processStartedAt: 'Tue Jan  1 00:00:00 2020',
      ownerToken: 'dead-token',
      port: 1,
    });
    await writeFile(path, stale, 'utf-8');

    const [a, b] = await Promise.all([
      recoverStaleOwnerRecord(path, home),
      recoverStaleOwnerRecord(path, home),
    ]);
    expect(a || b).toBe(true);
    expect(a && b).toBe(false);

    const successor = await acquireHomeOwnerLock(44444, home);
    expect((await readHomeOwnerRecord(home))?.ownerToken).toBe(successor.record.ownerToken);
    await successor.release();
  });

  it('memoizes concurrent release so only one unlink runs', async () => {
    const path = brokerOwnerPath(home);
    const handle = await acquireHomeOwnerLock(55555, home);
    await Promise.all([handle.release(), handle.release()]);
    await expect(readFile(path, 'utf-8')).rejects.toThrow();
  });

  function runLockChildProcess(op: string, slot: string): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(
        'npx',
        ['vitest', 'run', 'src/__tests__/lock-coord-child.test.ts', '-t', `lock worker ${op}`],
        {
          cwd: resolve('.'),
          env: {
            ...process.env,
            LOCK_COORD_HOME: home,
            LOCK_BARRIER_DIR: join(home, 'barrier'),
            LOCK_CHILD_SLOT: slot,
            LOCK_OP: op,
          },
        },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`lock child ${op} exited ${code}: ${stderr}`));
      });
    });
  }

  it('interleaves recover acquire release across two processes', async () => {
    const path = brokerOwnerPath(home);
    const barrier = join(home, 'barrier');
    await mkdir(resolve(home, 'runtime'), { recursive: true });
    await writeFile(
      path,
      serializeOwnerRecord({
        pid: 999_999,
        processStartedAt: 'Tue Jan  1 00:00:00 2020',
        ownerToken: 'dead-token',
        port: 1,
      }),
      'utf-8',
    );
    await mkdir(barrier, { recursive: true });

    async function waitBarrier(name: string): Promise<void> {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          await readFile(join(barrier, name), 'utf-8');
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      throw new Error(`timed out for barrier ${name}`);
    }

    const childA = runLockChildProcess('recover-acquire-release', '0');
    const childB = runLockChildProcess('recover-acquire-release', '1');
    await Promise.all([waitBarrier('recovered-0'), waitBarrier('recovered-1')]);
    await writeFile(join(barrier, 'go'), '1');
    await Promise.all([childA, childB]);

    expect(await readFile(join(barrier, 'acquired-0'), 'utf-8')).toBeTruthy();
    expect(await readFile(join(barrier, 'acquired-1'), 'utf-8')).toBeTruthy();
    await expect(readFile(path, 'utf-8')).rejects.toThrow();
  });

  it('serializes recover vs acquire contenders across two processes', async () => {
    const path = brokerOwnerPath(home);
    const barrier = join(home, 'barrier');
    await mkdir(barrier, { recursive: true });
    await runLockChildProcess('seed-stale', 'seed');

    async function waitBarrier(name: string): Promise<void> {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          await readFile(join(barrier, name), 'utf-8');
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      throw new Error(`timed out for barrier ${name}`);
    }

    const contenders = Promise.all([
      runLockChildProcess('recover-then-contend', '0'),
      runLockChildProcess('recover-then-contend', '1'),
    ]);
    await Promise.all([waitBarrier('ready-0'), waitBarrier('ready-1')]);
    await writeFile(join(barrier, 'contend'), '1');
    const contentionDeadline = Date.now() + 15_000;
    while (Date.now() < contentionDeadline) {
      const outcomes = ['0', '1'].filter(
        (s) =>
          existsSync(join(barrier, `winner-${s}`)) || existsSync(join(barrier, `loser-${s}`)),
      );
      if (outcomes.length >= 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const winner0 = await readFile(join(barrier, 'winner-0'), 'utf-8').catch(() => null);
    const winner1 = await readFile(join(barrier, 'winner-1'), 'utf-8').catch(() => null);
    const losers = [
      await readFile(join(barrier, 'loser-0'), 'utf-8').catch(() => null),
      await readFile(join(barrier, 'loser-1'), 'utf-8').catch(() => null),
    ].filter(Boolean);
    expect([winner0, winner1].filter(Boolean)).toHaveLength(1);
    expect(losers).toHaveLength(1);
    await writeFile(join(barrier, 'release'), '1');
    await contenders;
    await expect(readFile(path, 'utf-8')).rejects.toThrow();
  });

  it('matches owner identity with start time', () => {
    const startedAt = captureProcessStartedAt(process.pid);
    const record = {
      pid: process.pid,
      processStartedAt: startedAt,
      ownerToken: 'abc',
      port: 1,
    };
    expect(ownerIdentityMatches(record, process.pid, startedAt, 'abc')).toBe(true);
    expect(ownerIdentityMatches(record, process.pid, 'Tue Jan  2 00:00:00 2024', 'abc')).toBe(
      false,
    );
    expect(isOwnerRecordDefinitelyStale(record)).toBe(false);
  });
});
