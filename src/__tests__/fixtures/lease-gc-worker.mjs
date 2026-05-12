/**
 * Worker fixture for leases-gc-concurrency.test.ts.
 *
 * workerData.mode is either 'gc' or 'claim'. Both open their own DB
 * handle, signal 'ready', block on Atomics, then race.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

const here = dirname(fileURLToPath(import.meta.url));
const distModule = resolve(here, '..', '..', '..', 'dist', 'db', 'leases-db.js');

const { initLeasesDb, resetLeasesDb, claimLease, gcExpiredLeases } = await import(
  distModule
);

const { dbPath, slug, mode, sab } = workerData;
const int32 = new Int32Array(sab);

resetLeasesDb();
initLeasesDb(dbPath);

parentPort.postMessage('ready');
Atomics.wait(int32, 0, 0);

try {
  if (mode === 'gc') {
    const expired = gcExpiredLeases();
    parentPort.postMessage({ ok: true, mode, expired });
  } else if (mode === 'claim') {
    const result = claimLease(slug, 600);
    parentPort.postMessage({ ok: true, mode, ...result });
  } else {
    parentPort.postMessage({ ok: false, mode, error: 'unknown mode' });
  }
} catch (err) {
  parentPort.postMessage({
    ok: false,
    mode,
    error: err?.name ?? 'Error',
    message: err?.message ?? String(err),
  });
} finally {
  process.exit(0);
}
