import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { leaseCommand } from '../commands/lease.js';
import {
  initLeasesDb,
  closeLeasesDb,
  resetLeasesDb,
  createInventory,
  addMember,
  claimLease,
  getLease,
  forceReleaseLease,
} from '../db/leases-db.js';
import {
  resetSessionDb,
  closeSessionDb,
} from '../dashboard/session-db.js';
import { resetProofDb, closeProofDb } from '../db/proof-db.js';

let testDir: string;
let dbPath: string;
let logs: string[];
let errs: string[];
let exitCode: number | null;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-lease-cli-test-'));
  dbPath = resolve(testDir, 'syntaur.db');
  resetLeasesDb();
  resetSessionDb();
  resetProofDb();
  initLeasesDb(dbPath);

  logs = [];
  errs = [];
  exitCode = null;

  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errs.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new ExitError(exitCode);
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  closeLeasesDb();
  closeSessionDb();
  closeProofDb();
  await rm(testDir, { recursive: true, force: true });
});

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

async function run(argv: string[]): Promise<void> {
  try {
    await leaseCommand.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof ExitError) return;
    throw err;
  }
}

function seedInventory(slug = 'envs', memberCount = 2): void {
  createInventory({ slug, kind: 'dev-env', default_ttl_s: 600 });
  for (let i = 1; i <= memberCount; i += 1) {
    addMember({ inventory_slug: slug, member_id: `m${i}` });
  }
}

describe('lease revoke', () => {
  it('revokes an active lease and reports member_freed=true', async () => {
    seedInventory();
    const a = claimLease('envs', 600);
    await run(['revoke', a.lease_id]);
    expect(exitCode).toBeNull();
    expect(logs.join('\n')).toContain(`revoked ${a.lease_id}`);
    expect(logs.join('\n')).toContain('member_freed=true');
    expect(getLease(a.lease_id)?.state).toBe('revoked');
  });

  it('is idempotent on an already-revoked lease', async () => {
    seedInventory();
    const a = claimLease('envs', 600);
    forceReleaseLease(a.lease_id);
    await run(['revoke', a.lease_id]);
    expect(exitCode).toBeNull();
    expect(logs.join('\n')).toContain(`already revoked ${a.lease_id}`);
  });

  it('exits 1 on unknown lease', async () => {
    await run(['revoke', 'no-such-lease']);
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toContain('not found');
  });
});

describe('lease release-all', () => {
  it('prints one line per released lease plus a summary, matching --for', async () => {
    seedInventory('envs', 3);
    const a = claimLease('envs', 600, 'tag-x');
    const b = claimLease('envs', 600, 'tag-x');
    claimLease('envs', 600, 'tag-y');
    await run(['release-all', '--for', 'tag-x']);
    expect(exitCode).toBeNull();
    const out = logs.join('\n');
    expect(out).toContain(`released ${a.lease_id}`);
    expect(out).toContain(`released ${b.lease_id}`);
    expect(out).toContain('released 2 lease(s)');
    expect(out).toContain('0 stale skipped');
  });

  it('reports zero released when nothing matches', async () => {
    seedInventory();
    claimLease('envs', 600, 'tag-x');
    await run(['release-all', '--for', 'tag-z']);
    expect(logs.join('\n')).toContain('released 0 lease(s)');
  });

  it('emits JSON {released[], stale[]} when --json is set', async () => {
    seedInventory();
    const a = claimLease('envs', 600, 'tag-q');
    await run(['release-all', '--for', 'tag-q', '--json']);
    const parsed = JSON.parse(logs.join('\n'));
    expect(parsed).toEqual({ released: [a.lease_id], stale: [] });
  });
});

describe('lease claim --wait', () => {
  it('succeeds when a slot frees mid-wait', async () => {
    seedInventory('envs', 1);
    const a = claimLease('envs', 600);
    // Release the lease shortly after `claim --wait` starts.
    setTimeout(() => {
      forceReleaseLease(a.lease_id);
    }, 50);
    await run(['claim', 'envs', '--wait', '2s', '--ttl', '60s']);
    expect(exitCode).toBeNull();
    expect(logs.join('\n')).toMatch(/Claimed m1/);
  });

  it('times out when no slot frees within the budget', async () => {
    seedInventory('envs', 1);
    claimLease('envs', 600);
    await run(['claim', 'envs', '--wait', '1s', '--ttl', '60s']);
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/timed out waiting/);
  }, 5000);

  it('fail-fasts when --wait is not set (existing behavior preserved)', async () => {
    seedInventory('envs', 1);
    claimLease('envs', 600);
    await run(['claim', 'envs', '--ttl', '60s']);
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/no idle members/);
  });
});

describe('lease history', () => {
  it('returns the last N events across all leases', async () => {
    seedInventory();
    const a = claimLease('envs', 600);
    forceReleaseLease(a.lease_id);
    await run(['history', '--limit', '2', '--json']);
    const rows = JSON.parse(logs.join('\n')) as Array<{ event: string }>;
    expect(rows).toHaveLength(2);
    // newest first
    expect(rows[0].event).toBe('force_released');
    expect(rows[1].event).toBe('claimed');
  });

  it('filters by lease id when given', async () => {
    seedInventory();
    const a = claimLease('envs', 600);
    const b = claimLease('envs', 600);
    forceReleaseLease(b.lease_id);
    await run(['history', a.lease_id, '--json']);
    const rows = JSON.parse(logs.join('\n')) as Array<{ lease_id: string }>;
    expect(rows.every((r) => r.lease_id === a.lease_id)).toBe(true);
  });

  it('prints "(no events)" when nothing matches', async () => {
    seedInventory();
    await run(['history', '--json']);
    expect(JSON.parse(logs.join('\n'))).toEqual([]);
  });
});

describe('lease inventory delete', () => {
  it('refuses when active leases exist without --force', async () => {
    seedInventory();
    claimLease('envs', 600);
    await run(['inventory', 'delete', 'envs']);
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/active leases/);
  });

  it('with --force revokes and cascades', async () => {
    seedInventory();
    claimLease('envs', 600);
    claimLease('envs', 600);
    await run(['inventory', 'delete', 'envs', '--force']);
    expect(exitCode).toBeNull();
    expect(logs.join('\n')).toContain('revoked 2 active lease(s)');
  });

  it('reports clearly on unknown slug', async () => {
    await run(['inventory', 'delete', 'no-such']);
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/not found/);
  });
});

describe('lease inventory update', () => {
  it('updates --default-ttl', async () => {
    seedInventory();
    await run(['inventory', 'update', 'envs', '--default-ttl', '1h']);
    expect(exitCode).toBeNull();
    expect(logs.join('\n')).toContain('default_ttl=3600s');
  });

  it('updates --display-name', async () => {
    seedInventory();
    await run(['inventory', 'update', 'envs', '--display-name', 'Renamed']);
    expect(logs.join('\n')).toContain('display_name=Renamed');
  });

  it('refuses when no flag is provided', async () => {
    seedInventory();
    await run(['inventory', 'update', 'envs']);
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/nothing to update/);
  });

  it('reports clearly on unknown slug', async () => {
    await run([
      'inventory',
      'update',
      'no-such',
      '--display-name',
      'X',
    ]);
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/not found/);
  });
});

describe('lease member list', () => {
  it('lists the roster', async () => {
    seedInventory('envs', 3);
    await run(['member', 'list', 'envs']);
    expect(exitCode).toBeNull();
    expect(logs.join('\n')).toMatch(/m1\s+idle/);
    expect(logs.join('\n')).toMatch(/m2\s+idle/);
    expect(logs.join('\n')).toMatch(/m3\s+idle/);
  });

  it('--json returns rows', async () => {
    seedInventory('envs', 2);
    await run(['member', 'list', 'envs', '--json']);
    const rows = JSON.parse(logs.join('\n')) as Array<{ member_id: string }>;
    expect(rows.map((r) => r.member_id)).toEqual(['m1', 'm2']);
  });

  it('prints "(no members)" for an empty inventory', async () => {
    createInventory({ slug: 'empty', kind: 'lock', default_ttl_s: 60 });
    await run(['member', 'list', 'empty']);
    expect(logs.join('\n')).toContain('(no members)');
  });

  it('errors on unknown inventory', async () => {
    await run(['member', 'list', 'no-such']);
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/not found/);
  });
});

describe('lease claim duration guards', () => {
  // AC4: claim must reject ttl <= 0 (mirrors the extend guard) rather than mint
  // a lease whose expires_at == granted_at (born-expired).
  it('rejects claim --ttl 0 instead of minting a born-expired lease (AC4)', async () => {
    seedInventory('envs', 1);
    await run(['claim', 'envs', '--ttl', '0']);
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/ttl.*positive/i);
  });

  // AC5: an oversized duration must produce a clear error, not a raw
  // `RangeError: Invalid time value` from Date.toISOString().
  it('rejects an oversized --ttl with a clear message, not a raw RangeError (AC5)', async () => {
    seedInventory('envs', 1);
    await run(['claim', 'envs', '--ttl', '999999999999999d']);
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).not.toMatch(/Invalid time value/);
    expect(errs.join('\n')).toMatch(/duration/i);
  });

  it('still accepts a normal --ttl (positive control)', async () => {
    seedInventory('envs', 1);
    await run(['claim', 'envs', '--ttl', '60s']);
    expect(exitCode).toBeNull();
    expect(logs.join('\n')).toMatch(/Claimed m1/);
  });
});
