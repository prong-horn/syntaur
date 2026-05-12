/**
 * Stale-release CAS regression — the central correctness scenario.
 *
 * AC: "A stale `lease release <lease_id>` issued after the lease expired
 * AND the slot was re-claimed by someone else does NOT free the re-claimed
 * slot."
 *
 * Scenario:
 *   1. Capacity-1 inventory; agent A claims member m1 → lease_A.
 *   2. A's lease wall-clock expires (we fast-forward via direct UPDATE).
 *   3. Agent B claims; the opportunistic sweep in claimLease expires A,
 *      frees the member, bumps generation, and B grabs the slot.
 *   4. Agent A — unaware of all this — calls releaseLease(lease_A).
 *
 * Expected: releaseLease(lease_A) throws StaleLeaseError, B's lease is
 * untouched, the member remains held by B with B's generation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initLeasesDb,
  getLeasesDb,
  closeLeasesDb,
  resetLeasesDb,
  createInventory,
  addMember,
  claimLease,
  releaseLease,
  getLease,
  getInventoryDetail,
  StaleLeaseError,
} from '../db/leases-db.js';

let testDir: string;
let dbPath: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-leases-cas-test-'));
  dbPath = resolve(testDir, 'syntaur.db');
  resetLeasesDb();
  initLeasesDb(dbPath);
  createInventory({ slug: 'envs', kind: 'dev-env', default_ttl_s: 600 });
  addMember({ inventory_slug: 'envs', member_id: 'm1' });
});

afterEach(async () => {
  closeLeasesDb();
  await rm(testDir, { recursive: true, force: true });
});

describe('stale-release CAS regression', () => {
  it('release of an expired+reclaimed lease does NOT free the new holder', () => {
    // (1) A claims
    const a = claimLease('envs', 600);
    expect(a.member_id).toBe('m1');

    // (2) Fast-forward A past its TTL
    getLeasesDb()
      .prepare('UPDATE leases SET expires_at = ? WHERE lease_id = ?')
      .run('2000-01-01T00:00:00.000Z', a.lease_id);

    // (3) B claims — sweep expires A, bumps member, then claims afresh
    const b = claimLease('envs', 600);
    expect(b.member_id).toBe('m1');
    expect(b.lease_id).not.toBe(a.lease_id);
    expect(b.member_gen).toBeGreaterThan(a.member_gen);

    // After B's claim:
    const memberBefore = getInventoryDetail('envs')!.members[0];
    expect(memberBefore.status).toBe('leased');
    expect(memberBefore.generation).toBe(b.member_gen);
    expect(getLease(a.lease_id)?.state).toBe('expired');
    expect(getLease(b.lease_id)?.state).toBe('active');

    // (4) The stale releaser fires
    expect(() => releaseLease(a.lease_id)).toThrow(StaleLeaseError);

    // Invariants hold post-release:
    const memberAfter = getInventoryDetail('envs')!.members[0];
    expect(memberAfter.status).toBe('leased');
    expect(memberAfter.generation).toBe(b.member_gen);
    expect(getLease(a.lease_id)?.state).toBe('expired');
    expect(getLease(b.lease_id)?.state).toBe('active');
    expect(getLease(b.lease_id)?.released_at).toBeNull();
  });
});
