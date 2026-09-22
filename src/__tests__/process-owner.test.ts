import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
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

  async function barrierDirListing(barrierPath: string): Promise<string> {
    const names = await readdir(barrierPath).catch(() => [] as string[]);
    const parts = await Promise.all(
      names.map(async (name) => {
        const raw = await readFile(join(barrierPath, name), 'utf-8').catch(() => '');
        return `${name}(${raw.length}B)`;
      }),
    );
    return parts.join(', ') || '(empty)';
  }

  async function waitForBarrier(
    barrierPath: string,
    name: string,
    timeoutMs = 15_000,
  ): Promise<string> {
    const filePath = join(barrierPath, name);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const text = (await readFile(filePath, 'utf-8')).trim();
        if (text) return text;
      } catch {
        /* not ready */
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      `timed out for barrier ${name}; listing: ${await barrierDirListing(barrierPath)}`,
    );
  }

  async function waitForSlotOutcome(
    barrierPath: string,
    slot: string,
    timeoutMs = 15_000,
  ): Promise<{ slot: string; kind: 'winner' | 'loser'; token?: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const winner = await readFile(join(barrierPath, `winner-${slot}`), 'utf-8').catch(() => '');
      if (winner.trim()) {
        return { slot, kind: 'winner', token: winner.trim() };
      }
      const loser = await readFile(join(barrierPath, `loser-${slot}`), 'utf-8').catch(() => '');
      if (loser.trim()) {
        return { slot, kind: 'loser' };
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      `timed out for slot ${slot} outcome; listing: ${await barrierDirListing(barrierPath)}`,
    );
  }

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

    const childA = runLockChildProcess('recover-acquire-release', '0');
    const childB = runLockChildProcess('recover-acquire-release', '1');
    await Promise.all([
      waitForBarrier(barrier, 'recovered-0'),
      waitForBarrier(barrier, 'recovered-1'),
    ]);
    await writeFile(join(barrier, 'go'), '1');
    await Promise.all([childA, childB]);

    expect(await waitForBarrier(barrier, 'acquired-0')).toBeTruthy();
    expect(await waitForBarrier(barrier, 'acquired-1')).toBeTruthy();
    await expect(readFile(path, 'utf-8')).rejects.toThrow();
  });

  it('serializes recover vs acquire contenders across two processes', async () => {
    const path = brokerOwnerPath(home);
    const barrier = join(home, 'barrier');
    await mkdir(barrier, { recursive: true });
    await runLockChildProcess('seed-stale', 'seed');

    const contenders = Promise.all([
      runLockChildProcess('recover-then-contend', '0'),
      runLockChildProcess('recover-then-contend', '1'),
    ]);
    await Promise.all([
      waitForBarrier(barrier, 'ready-0'),
      waitForBarrier(barrier, 'ready-1'),
    ]);
    await writeFile(join(barrier, 'contend'), '1');
    const [outcome0, outcome1] = await Promise.all([
      waitForSlotOutcome(barrier, '0'),
      waitForSlotOutcome(barrier, '1'),
    ]);
    const outcomes = [outcome0, outcome1];
    const winners = outcomes.filter((o) => o.kind === 'winner');
    const losers = outcomes.filter((o) => o.kind === 'loser');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0].slot).not.toBe(losers[0].slot);
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
