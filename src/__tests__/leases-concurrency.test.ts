/**
 * Real-overlap concurrency test for `claimLease`.
 *
 * AC: "Two simultaneous `lease claim` calls always return different members
 * (or one fails) — no double-claim."
 *
 * better-sqlite3 is synchronous; `Promise.all` does not create real overlap.
 * fork()/spawn() startup time (~150-300ms) often serializes sub-ms SQL.
 * We use worker_threads + SharedArrayBuffer + Atomics.wait/notify so both
 * workers wake within microseconds of each other and race on the BEGIN
 * IMMEDIATE transaction inside claimLease.
 *
 * Requires `npm run build` to have produced dist/db/leases-db.js. The
 * verification step in plan.md ensures the build happens before tests.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initLeasesDb,
  resetLeasesDb,
  closeLeasesDb,
  createInventory,
  addMember,
  getLeasesDb,
} from '../db/leases-db.js';

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(here, 'fixtures', 'lease-claim-worker.mjs');
const distBuildPath = resolve(here, '..', '..', 'dist', 'db', 'leases-db.js');

let testDir: string;
let dbPath: string;

beforeAll(async () => {
  // The worker imports from dist; fail loudly if the build is missing.
  try {
    await access(distBuildPath);
  } catch {
    throw new Error(
      `dist build missing at ${distBuildPath}. Run \`npm run build\` before running this test.`,
    );
  }
}, 5000);

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-leases-conc-test-'));
  dbPath = resolve(testDir, 'syntaur.db');
  resetLeasesDb();
});

afterEach(async () => {
  closeLeasesDb();
  await rm(testDir, { recursive: true, force: true });
});

interface WorkerResult {
  ok: boolean;
  lease_id?: string;
  inventory_slug?: string;
  member_id?: string;
  member_gen?: number;
  granted_at?: string;
  expires_at?: string;
  metadata?: Record<string, unknown> | null;
  error?: string;
  message?: string;
}

async function raceClaim(
  slug: string,
  workerCount: number,
): Promise<WorkerResult[]> {
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);

  const workers: Worker[] = [];
  const readyPromises: Promise<void>[] = [];
  const resultPromises: Promise<WorkerResult>[] = [];

  for (let i = 0; i < workerCount; i++) {
    const worker = new Worker(workerPath, { workerData: { dbPath, slug, sab } });
    workers.push(worker);

    let resolveReady: () => void;
    const readyPromise = new Promise<void>((res) => {
      resolveReady = res;
    });
    readyPromises.push(readyPromise);

    let resolveResult: (r: WorkerResult) => void;
    let rejectResult: (e: Error) => void;
    const resultPromise = new Promise<WorkerResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });
    resultPromises.push(resultPromise);

    worker.on('message', (msg: unknown) => {
      if (msg === 'ready') {
        resolveReady();
      } else if (typeof msg === 'object' && msg !== null) {
        resolveResult(msg as WorkerResult);
      }
    });
    worker.on('error', rejectResult!);
    worker.on('exit', (code) => {
      if (code !== 0) {
        // Worker exits with 0 even on a thrown error after posting the message.
        // A non-zero exit before any message is the failure path.
      }
    });
  }

  // Wait for all workers to be ready (own DB handle prepared)
  await Promise.all(readyPromises);

  // Tiny extra delay to let workers reach the Atomics.wait
  await new Promise((res) => setTimeout(res, 10));

  // Release them simultaneously
  Atomics.store(int32, 0, 1);
  Atomics.notify(int32, 0, workerCount);

  const results = await Promise.all(resultPromises);

  // Best-effort cleanup
  await Promise.all(workers.map((w) => w.terminate().catch(() => undefined)));

  return results;
}

/** Open a fresh handle on the same DB to query the final state from the test. */
function openReadHandle(): void {
  resetLeasesDb();
  initLeasesDb(dbPath);
}

describe('leases concurrency (real overlap via worker_threads + Atomics)', () => {
  it(
    'capacity-1: exactly one of two simultaneous claimants succeeds; no double-allocation',
    async () => {
      resetLeasesDb();
      initLeasesDb(dbPath);
      createInventory({ slug: 'envs', kind: 'dev-env', default_ttl_s: 600 });
      addMember({ inventory_slug: 'envs', member_id: 'm1' });
      closeLeasesDb();
      resetLeasesDb();

      const results = await raceClaim('envs', 2);

      const successes = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);
      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);
      expect(failures[0].error).toMatch(/NoIdleMemberError|LeaseContentionError/);

      // Strong invariant: no double-allocation in the DB.
      openReadHandle();
      const dupes = getLeasesDb()
        .prepare(
          `SELECT inventory_slug, member_id, COUNT(*) AS c
           FROM leases WHERE state = 'active'
           GROUP BY inventory_slug, member_id HAVING c > 1`,
        )
        .all();
      expect(dupes).toHaveLength(0);
    },
    15000,
  );

  it(
    'capacity-2: both claimants succeed with DIFFERENT members; no double-allocation',
    async () => {
      resetLeasesDb();
      initLeasesDb(dbPath);
      createInventory({ slug: 'envs', kind: 'dev-env', default_ttl_s: 600 });
      addMember({ inventory_slug: 'envs', member_id: 'm1' });
      addMember({ inventory_slug: 'envs', member_id: 'm2' });
      closeLeasesDb();
      resetLeasesDb();

      const results = await raceClaim('envs', 2);

      const successes = results.filter((r) => r.ok);
      expect(successes).toHaveLength(2);
      expect(successes[0].member_id).not.toBe(successes[1].member_id);

      openReadHandle();
      const dupes = getLeasesDb()
        .prepare(
          `SELECT inventory_slug, member_id, COUNT(*) AS c
           FROM leases WHERE state = 'active'
           GROUP BY inventory_slug, member_id HAVING c > 1`,
        )
        .all();
      expect(dupes).toHaveLength(0);

      const activeCount = getLeasesDb()
        .prepare(`SELECT COUNT(*) AS c FROM leases WHERE state = 'active'`)
        .get() as { c: number };
      expect(activeCount.c).toBe(2);
    },
    15000,
  );
});
