/**
 * GC + claim concurrency test.
 *
 * AC: "`lease gc` correctly transitions expired leases without races."
 *
 * Pre-state: capacity-2 inventory, both members claimed, both leases'
 * expires_at fast-forwarded past now.
 *
 * Race: two workers wake simultaneously via Atomics.wait/notify.
 *   - Worker GC runs `gcExpiredLeases()` → sweeps both expired leases.
 *   - Worker CLAIM runs `claimLease(slug, ttl)` → tries to acquire.
 *
 * Invariants after both workers exit:
 *   (i)   Both pre-existing leases end up in state='expired' with
 *         released_at set.
 *   (ii)  The claim worker either got one of the freshly-freed members
 *         OR NoIdleMemberError / LeaseContentionError. All three are
 *         valid; what's NOT valid is double-allocation.
 *   (iii) No (inventory_slug, member_id) ever has two state='active'
 *         leases.
 *   (iv)  For every freed member, no state='active' lease references
 *         its prior generation.
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
  claimLease,
  getLeasesDb,
} from '../db/leases-db.js';

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(here, 'fixtures', 'lease-gc-worker.mjs');
const distBuildPath = resolve(here, '..', '..', 'dist', 'db', 'leases-db.js');

let testDir: string;
let dbPath: string;

beforeAll(async () => {
  try {
    await access(distBuildPath);
  } catch {
    throw new Error(
      `dist build missing at ${distBuildPath}. Run \`npm run build\` before running this test.`,
    );
  }
}, 5000);

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-leases-gc-conc-test-'));
  dbPath = resolve(testDir, 'syntaur.db');
  resetLeasesDb();
});

afterEach(async () => {
  closeLeasesDb();
  await rm(testDir, { recursive: true, force: true });
});

interface WorkerResult {
  ok: boolean;
  mode: 'gc' | 'claim';
  expired?: number;
  lease_id?: string;
  member_id?: string;
  member_gen?: number;
  error?: string;
  message?: string;
}

async function raceGcVsClaim(slug: string): Promise<WorkerResult[]> {
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);

  const modes: Array<'gc' | 'claim'> = ['gc', 'claim'];
  const workers: Worker[] = [];
  const readyPromises: Promise<void>[] = [];
  const resultPromises: Promise<WorkerResult>[] = [];

  for (const mode of modes) {
    const worker = new Worker(workerPath, {
      workerData: { dbPath, slug, mode, sab },
    });
    workers.push(worker);

    let resolveReady: () => void;
    readyPromises.push(
      new Promise<void>((res) => {
        resolveReady = res;
      }),
    );

    let resolveResult: (r: WorkerResult) => void;
    let rejectResult: (e: Error) => void;
    resultPromises.push(
      new Promise<WorkerResult>((res, rej) => {
        resolveResult = res;
        rejectResult = rej;
      }),
    );

    worker.on('message', (msg: unknown) => {
      if (msg === 'ready') resolveReady();
      else if (typeof msg === 'object' && msg !== null) {
        resolveResult(msg as WorkerResult);
      }
    });
    worker.on('error', rejectResult!);
  }

  await Promise.all(readyPromises);
  await new Promise((res) => setTimeout(res, 10));

  Atomics.store(int32, 0, 1);
  Atomics.notify(int32, 0, modes.length);

  const results = await Promise.all(resultPromises);
  await Promise.all(workers.map((w) => w.terminate().catch(() => undefined)));
  return results;
}

function openReadHandle(): void {
  resetLeasesDb();
  initLeasesDb(dbPath);
}

describe('GC + claim concurrency', () => {
  it(
    'gc and claim race safely; no double-allocation; both expired leases finalized',
    async () => {
      resetLeasesDb();
      initLeasesDb(dbPath);
      createInventory({ slug: 'envs', kind: 'dev-env', default_ttl_s: 600 });
      addMember({ inventory_slug: 'envs', member_id: 'm1' });
      addMember({ inventory_slug: 'envs', member_id: 'm2' });

      // Claim both members, then fast-forward both leases' expires_at.
      const a = claimLease('envs', 600);
      const b = claimLease('envs', 600);
      const past = '2000-01-01T00:00:00.000Z';
      getLeasesDb()
        .prepare(`UPDATE leases SET expires_at = ? WHERE lease_id IN (?, ?)`)
        .run(past, a.lease_id, b.lease_id);

      closeLeasesDb();
      resetLeasesDb();

      const results = await raceGcVsClaim('envs');

      const gcResult = results.find((r) => r.mode === 'gc')!;
      const claimResult = results.find((r) => r.mode === 'claim')!;

      // GC must always succeed.
      expect(gcResult.ok).toBe(true);

      // Claim's possible outcomes:
      //   - ok=true with a member_id in {m1, m2}
      //   - ok=false with error in {NoIdleMemberError, LeaseContentionError}
      if (claimResult.ok) {
        expect(['m1', 'm2']).toContain(claimResult.member_id);
      } else {
        expect(['NoIdleMemberError', 'LeaseContentionError']).toContain(
          claimResult.error,
        );
      }

      // Invariants (post-race)
      openReadHandle();

      // (i) Both original leases ended up expired with released_at set.
      const origRows = getLeasesDb()
        .prepare(
          `SELECT lease_id, state, released_at FROM leases
           WHERE lease_id IN (?, ?)`,
        )
        .all(a.lease_id, b.lease_id) as Array<{
        lease_id: string;
        state: string;
        released_at: string | null;
      }>;
      expect(origRows).toHaveLength(2);
      for (const row of origRows) {
        expect(row.state).toBe('expired');
        expect(row.released_at).not.toBeNull();
      }

      // (iii) Strong invariant: no double-active-allocation.
      const dupes = getLeasesDb()
        .prepare(
          `SELECT inventory_slug, member_id, COUNT(*) AS c
           FROM leases WHERE state = 'active'
           GROUP BY inventory_slug, member_id HAVING c > 1`,
        )
        .all();
      expect(dupes).toHaveLength(0);

      // (iv) Any active lease's member_gen matches the current member's generation.
      const orphaned = getLeasesDb()
        .prepare(
          `SELECT l.lease_id, l.member_gen, im.generation
           FROM leases l
           JOIN inventory_members im
             ON l.inventory_slug = im.inventory_slug
            AND l.member_id      = im.member_id
           WHERE l.state = 'active'
             AND l.member_gen != im.generation`,
        )
        .all();
      expect(orphaned).toHaveLength(0);
    },
    15000,
  );
});
