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
  retireMember,
  claimLease,
  releaseLease,
  extendLease,
  forceReleaseLease,
  gcExpiredLeases,
  getLease,
  listLeases,
  getInventoryDetail,
  NoIdleMemberError,
  StaleLeaseError,
  NotFoundError,
  MemberInUseError,
  DuplicateInventoryError,
  DuplicateMemberError,
} from '../db/leases-db.js';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { initProofDb, closeProofDb, resetProofDb } from '../db/proof-db.js';

let testDir: string;
let dbPath: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-leases-db-test-'));
  dbPath = resolve(testDir, 'syntaur.db');
  resetLeasesDb();
  resetSessionDb();
  resetProofDb();
});

afterEach(async () => {
  closeLeasesDb();
  closeSessionDb();
  closeProofDb();
  await rm(testDir, { recursive: true, force: true });
});

function fastForwardLease(leaseId: string, pastIso: string): void {
  getLeasesDb()
    .prepare('UPDATE leases SET expires_at = ? WHERE lease_id = ?')
    .run(pastIso, leaseId);
}

describe('initLeasesDb', () => {
  it('creates the four lease tables + indexes + seeds lease_schema_version', () => {
    const db = initLeasesDb(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('meta');
    expect(names).toContain('inventories');
    expect(names).toContain('inventory_members');
    expect(names).toContain('leases');
    expect(names).toContain('lease_events');

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_members_idle');
    expect(indexNames).toContain('idx_leases_gc');
    expect(indexNames).toContain('idx_events_lease');

    const version = db
      .prepare("SELECT value FROM meta WHERE key = 'lease_schema_version'")
      .get() as { value: string } | undefined;
    expect(version?.value).toBe('1');
  });

  it('applies WAL + busy_timeout + foreign_keys pragmas', () => {
    const db = initLeasesDb(dbPath);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('returns the same singleton on repeat calls', () => {
    const a = initLeasesDb(dbPath);
    const b = initLeasesDb(dbPath);
    expect(a).toBe(b);
  });

  it('coexists with session-db and proof-db schema versions in the same file', () => {
    initLeasesDb(dbPath);
    closeLeasesDb();
    resetLeasesDb();

    initSessionDb(dbPath);
    closeSessionDb();
    resetSessionDb();

    initProofDb(dbPath);
    closeProofDb();
    resetProofDb();

    const db = initLeasesDb(dbPath);
    const rows = db
      .prepare("SELECT key, value FROM meta ORDER BY key")
      .all() as Array<{ key: string; value: string }>;
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(map.lease_schema_version).toBe('1');
    expect(map.proof_schema_version).toBe('1');
    expect(map.schema_version).toBeDefined();
  });

  it('is safe to run standalone (creates its own meta table)', () => {
    const db = initLeasesDb(dbPath);
    const metaTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
      .get();
    expect(metaTable).toBeDefined();
  });
});

describe('inventories and members', () => {
  beforeEach(() => {
    initLeasesDb(dbPath);
  });

  it('creates an inventory and adds members', () => {
    createInventory({ slug: 'envs', kind: 'dev-env', default_ttl_s: 600 });
    addMember({
      inventory_slug: 'envs',
      member_id: 'm1',
      metadata: { url: 'http://a.test' },
    });
    addMember({ inventory_slug: 'envs', member_id: 'm2' });
    const detail = getInventoryDetail('envs');
    expect(detail?.inventory.slug).toBe('envs');
    expect(detail?.members).toHaveLength(2);
    expect(detail?.active_leases).toHaveLength(0);
    const m1 = detail!.members.find((m) => m.member_id === 'm1');
    expect(m1?.status).toBe('idle');
    expect(JSON.parse(m1!.metadata_json!)).toEqual({ url: 'http://a.test' });
  });

  it('rejects duplicate inventory slugs', () => {
    createInventory({ slug: 'envs', kind: 'dev-env', default_ttl_s: 600 });
    expect(() =>
      createInventory({ slug: 'envs', kind: 'dev-env', default_ttl_s: 600 }),
    ).toThrow(DuplicateInventoryError);
  });

  it('rejects duplicate member ids in the same inventory', () => {
    createInventory({ slug: 'envs', kind: 'dev-env', default_ttl_s: 600 });
    addMember({ inventory_slug: 'envs', member_id: 'm1' });
    expect(() =>
      addMember({ inventory_slug: 'envs', member_id: 'm1' }),
    ).toThrow(DuplicateMemberError);
  });

  it('retire bumps generation and forbids retiring a leased member', () => {
    createInventory({ slug: 'envs', kind: 'dev-env', default_ttl_s: 600 });
    addMember({ inventory_slug: 'envs', member_id: 'm1' });
    const lease = claimLease('envs', 60);
    expect(() => retireMember('envs', 'm1')).toThrow(MemberInUseError);
    releaseLease(lease.lease_id);
    retireMember('envs', 'm1');
    const detail = getInventoryDetail('envs');
    expect(detail?.members[0].status).toBe('retired');
  });
});

describe('claim / release / extend happy paths', () => {
  beforeEach(() => {
    initLeasesDb(dbPath);
    createInventory({ slug: 'envs', kind: 'dev-env', default_ttl_s: 600 });
    addMember({
      inventory_slug: 'envs',
      member_id: 'm1',
      metadata: { url: 'http://a.test' },
    });
    addMember({ inventory_slug: 'envs', member_id: 'm2' });
  });

  it('claim returns lease + metadata; subsequent claim picks the other member', () => {
    const a = claimLease('envs', 60);
    expect(a.member_id).toMatch(/^m[12]$/);
    expect(a.metadata).toBeDefined();
    const b = claimLease('envs', 60);
    expect(b.member_id).not.toBe(a.member_id);
  });

  it('claim throws NoIdleMemberError when pool is exhausted', () => {
    claimLease('envs', 60);
    claimLease('envs', 60);
    expect(() => claimLease('envs', 60)).toThrow(NoIdleMemberError);
  });

  it('release frees the member for the next claim', () => {
    const a = claimLease('envs', 60);
    claimLease('envs', 60); // exhaust
    expect(() => claimLease('envs', 60)).toThrow(NoIdleMemberError);
    releaseLease(a.lease_id);
    const c = claimLease('envs', 60);
    expect(c.member_id).toBe(a.member_id);
  });

  it('release a second time on the same lease_id is a no-op StaleLeaseError', () => {
    const a = claimLease('envs', 60);
    releaseLease(a.lease_id);
    expect(() => releaseLease(a.lease_id)).toThrow(StaleLeaseError);
  });

  it('extend updates expires_at and writes an extended event', () => {
    const a = claimLease('envs', 60);
    const originalExpiry = a.expires_at;
    const res = extendLease(a.lease_id, 3600);
    expect(res.new_expires_at > originalExpiry).toBe(true);
    const row = getLease(a.lease_id);
    expect(row?.expires_at).toBe(res.new_expires_at);
  });

  it('extend refuses an already-expired lease (wall-clock)', () => {
    const a = claimLease('envs', 60);
    fastForwardLease(a.lease_id, '2000-01-01T00:00:00.000Z');
    expect(() => extendLease(a.lease_id, 60)).toThrow(StaleLeaseError);
  });

  it('extend refuses if member_gen has advanced (force-release scenario)', () => {
    const a = claimLease('envs', 60);
    forceReleaseLease(a.lease_id);
    expect(() => extendLease(a.lease_id, 60)).toThrow(StaleLeaseError);
  });
});

describe('gcExpiredLeases', () => {
  beforeEach(() => {
    initLeasesDb(dbPath);
    createInventory({ slug: 'envs', kind: 'dev-env', default_ttl_s: 600 });
    addMember({ inventory_slug: 'envs', member_id: 'm1' });
  });

  it('transitions expired active leases to expired, frees member, bumps generation', () => {
    const a = claimLease('envs', 600);
    const memberBefore = getInventoryDetail('envs')!.members[0];
    expect(memberBefore.status).toBe('leased');
    expect(memberBefore.generation).toBe(1);

    fastForwardLease(a.lease_id, '2000-01-01T00:00:00.000Z');
    const n = gcExpiredLeases();
    expect(n).toBe(1);

    const memberAfter = getInventoryDetail('envs')!.members[0];
    expect(memberAfter.status).toBe('idle');
    expect(memberAfter.generation).toBe(2);

    const row = getLease(a.lease_id);
    expect(row?.state).toBe('expired');
    expect(row?.released_at).toBeTruthy();
  });

  it('is idempotent — running gc again does nothing', () => {
    const a = claimLease('envs', 600);
    fastForwardLease(a.lease_id, '2000-01-01T00:00:00.000Z');
    expect(gcExpiredLeases()).toBe(1);
    expect(gcExpiredLeases()).toBe(0);
  });

  it('preserves an active lease that is not yet expired', () => {
    claimLease('envs', 600);
    expect(gcExpiredLeases()).toBe(0);
    expect(
      listLeases({ state: 'active' }).length,
    ).toBe(1);
  });
});

describe('forceReleaseLease', () => {
  beforeEach(() => {
    initLeasesDb(dbPath);
    createInventory({ slug: 'envs', kind: 'dev-env', default_ttl_s: 600 });
    addMember({ inventory_slug: 'envs', member_id: 'm1' });
  });

  it('happy path: lease still bound → member freed, generation bumped, lease revoked', () => {
    const a = claimLease('envs', 600);
    const res = forceReleaseLease(a.lease_id);
    expect(res.member_freed).toBe(true);

    const row = getLease(a.lease_id);
    expect(row?.state).toBe('revoked');
    expect(row?.released_at).toBeTruthy();

    const detail = getInventoryDetail('envs')!;
    expect(detail.members[0].status).toBe('idle');
    expect(detail.members[0].generation).toBe(2);
  });

  it('CAS regression: force-releasing an expired lease whose member is held by a NEW active lease must NOT idle the new holder', () => {
    // Capacity 1
    const a = claimLease('envs', 600);
    // Expire A's lease wall-clock
    fastForwardLease(a.lease_id, '2000-01-01T00:00:00.000Z');
    // B claims — opportunistic sweep transitions A to expired (bumping gen)
    // and the claim itself bumps gen again, so B.member_gen > A.member_gen.
    const b = claimLease('envs', 600);
    expect(b.member_id).toBe(a.member_id);
    expect(b.member_gen).toBeGreaterThan(a.member_gen);

    // Now force-release A. Member is now held by B; A's member_gen is stale.
    const res = forceReleaseLease(a.lease_id);
    expect(res.member_freed).toBe(false); // <- the CAS protected B

    // A is now marked revoked.
    const rowA = getLease(a.lease_id);
    expect(rowA?.state).toBe('revoked');

    // B is still the holder and its lease is still active.
    const rowB = getLease(b.lease_id);
    expect(rowB?.state).toBe('active');

    const detail = getInventoryDetail('envs')!;
    expect(detail.members[0].status).toBe('leased');
    expect(detail.members[0].generation).toBe(b.member_gen);

    // detail_json on the force_released event records member_freed=false
    const ev = initLeasesDb(dbPath)
      .prepare(
        "SELECT detail_json FROM lease_events WHERE lease_id = ? AND event = 'force_released'",
      )
      .get(a.lease_id) as { detail_json: string } | undefined;
    expect(ev).toBeDefined();
    expect(JSON.parse(ev!.detail_json)).toEqual({ member_freed: false });
  });

  it('is idempotent on already-revoked leases', () => {
    const a = claimLease('envs', 600);
    forceReleaseLease(a.lease_id);
    // Second call returns { member_freed: false } and does not throw.
    expect(forceReleaseLease(a.lease_id)).toEqual({ member_freed: false });
  });

  it('throws NotFoundError for an unknown lease id', () => {
    expect(() => forceReleaseLease('nonexistent')).toThrow(NotFoundError);
  });
});
