/**
 * Worker fixture for leases-concurrency.test.ts.
 *
 * Each worker:
 *   1. Opens its OWN better-sqlite3 handle on the shared file.
 *   2. Signals 'ready' to the parent via parentPort.
 *   3. Blocks on Atomics.wait until the parent flips int32[0] to 1.
 *   4. Calls claimLease against the production module (imported from dist).
 *   5. Posts back { ok: true, ... } or { ok: false, error: <ErrorName> }.
 *
 * Requires `npm run build` to have produced dist/db/leases-db.js before tests.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

const here = dirname(fileURLToPath(import.meta.url));
const distModule = resolve(here, '..', '..', '..', 'dist', 'db', 'leases-db.js');

const { initLeasesDb, resetLeasesDb, claimLease } = await import(distModule);

const { dbPath, slug, sab } = workerData;
const int32 = new Int32Array(sab);

resetLeasesDb();
initLeasesDb(dbPath);

parentPort.postMessage('ready');

// Block until the parent flips int32[0] to 1
Atomics.wait(int32, 0, 0);

try {
  const result = claimLease(slug, 600);
  parentPort.postMessage({ ok: true, ...result });
} catch (err) {
  parentPort.postMessage({
    ok: false,
    error: err?.name ?? 'Error',
    message: err?.message ?? String(err),
  });
} finally {
  process.exit(0);
}
