import { Command } from 'commander';
import {
  initLeasesDb,
  createInventory,
  addMember,
  retireMember,
  claimLease,
  releaseLease,
  extendLease,
  getLease,
  listLeases,
  listInventories,
  getInventoryDetail,
  gcExpiredLeases,
  NoIdleMemberError,
  StaleLeaseError,
  NotFoundError,
  LeaseContentionError,
  MemberInUseError,
  DuplicateInventoryError,
  DuplicateMemberError,
  type LeaseState,
} from '../db/leases-db.js';

const DURATION_REGEX = /^(\d+)\s*(s|m|h|d)?$/i;

/** Parse durations like `30m`, `2h`, `120s`, `1d`, or bare seconds. */
function parseDuration(input: string | undefined, fallbackSeconds: number): number {
  if (!input) return fallbackSeconds;
  const match = DURATION_REGEX.exec(input.trim());
  if (!match) {
    throw new Error(
      `invalid duration "${input}" — use e.g. 30s, 5m, 2h, 1d`,
    );
  }
  const n = Number.parseInt(match[1], 10);
  const unit = (match[2] ?? 's').toLowerCase();
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return n * mult[unit];
}

function parseMetadataFlags(values: string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const raw of values) {
    const eq = raw.indexOf('=');
    if (eq < 0) {
      throw new Error(`invalid -m flag "${raw}" — use key=value`);
    }
    out[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return out;
}

function withErrorHandling(fn: (args: unknown[]) => Promise<void> | void) {
  return async (...args: unknown[]): Promise<void> => {
    try {
      await fn(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  };
}

export const leaseCommand = new Command('lease').description(
  'Resource leases — claim and release coordinated shared resources',
);

// --- create-inventory ------------------------------------------------------

leaseCommand
  .command('create-inventory')
  .description('Create a new inventory of leaseable resources')
  .argument('<slug>', 'Inventory slug (e.g. dev-envs, prod-migration-lock)')
  .requiredOption('--kind <kind>', 'Inventory kind (free-form label, e.g. dev-env, db-instance, lock)')
  .option('--display-name <text>', 'Human-readable display name')
  .option('--default-ttl <duration>', 'Default lease TTL (e.g. 30m, 2h). Default: 30m', '30m')
  .action(async (slug: string, opts: { kind: string; displayName?: string; defaultTtl: string }) => {
    try {
      initLeasesDb();
      const ttl_s = parseDuration(opts.defaultTtl, 30 * 60);
      const row = createInventory({
        slug,
        kind: opts.kind,
        display_name: opts.displayName,
        default_ttl_s: ttl_s,
      });
      console.log(`Created inventory '${row.slug}' (kind=${row.kind}, default_ttl=${row.default_ttl_s}s).`);
    } catch (error) {
      if (error instanceof DuplicateInventoryError) {
        console.error(`Error: inventory '${error.slug}' already exists`);
        process.exit(1);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// --- member group ----------------------------------------------------------

const memberCommand = leaseCommand
  .command('member')
  .description('Manage members of an inventory');

memberCommand
  .command('add')
  .description('Add a member to an inventory')
  .argument('<inventory>', 'Inventory slug')
  .argument('<member-id>', 'Member id (unique within the inventory)')
  .option('-m, --metadata <key=value...>', 'Metadata key=value pairs (repeatable)')
  .action(async (inventory: string, memberId: string, opts: { metadata?: string[] }) => {
    try {
      initLeasesDb();
      const metadata = parseMetadataFlags(opts.metadata);
      addMember({ inventory_slug: inventory, member_id: memberId, metadata });
      console.log(`Added member '${memberId}' to '${inventory}'.`);
    } catch (error) {
      if (error instanceof DuplicateMemberError) {
        console.error(`Error: member ${error.inventorySlug}/${error.memberId} already exists`);
        process.exit(1);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

memberCommand
  .command('retire')
  .description('Retire a member (no longer claimable). Refuses if member is currently leased.')
  .argument('<inventory>', 'Inventory slug')
  .argument('<member-id>', 'Member id')
  .action(async (inventory: string, memberId: string) => {
    try {
      initLeasesDb();
      retireMember(inventory, memberId);
      console.log(`Retired member '${inventory}/${memberId}'.`);
    } catch (error) {
      if (error instanceof MemberInUseError) {
        console.error(
          `Error: member ${error.inventorySlug}/${error.memberId} is currently leased; release before retiring`,
        );
        process.exit(1);
      }
      if (error instanceof NotFoundError) {
        console.error(`Error: member not found`);
        process.exit(1);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// --- claim -----------------------------------------------------------------

leaseCommand
  .command('claim')
  .description('Claim an idle member of an inventory. Fail-fast if none idle.')
  .argument('<inventory>', 'Inventory slug')
  .option('--ttl <duration>', 'Lease TTL (overrides inventory default)')
  .option('--for <tag>', 'Free-form requester tag (session id, assignment slug, etc.)')
  .option('--json', 'Output JSON instead of a one-line summary')
  .action(async (inventory: string, opts: { ttl?: string; for?: string; json?: boolean }) => {
    try {
      initLeasesDb();
      const detail = getInventoryDetail(inventory);
      if (!detail) {
        console.error(`Error: inventory '${inventory}' not found`);
        process.exit(1);
        return;
      }
      const ttl_s = parseDuration(opts.ttl, detail.inventory.default_ttl_s);
      const result = claimLease(inventory, ttl_s, opts.for);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `Claimed ${result.member_id} as ${result.lease_id} (expires ${result.expires_at})`,
        );
      }
    } catch (error) {
      if (error instanceof NoIdleMemberError) {
        console.error(`Error: no idle members in '${error.inventorySlug}'`);
        process.exit(1);
      }
      if (error instanceof LeaseContentionError) {
        console.error(`Error: contention timeout on '${error.inventorySlug}'; retry`);
        process.exit(1);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// --- release ---------------------------------------------------------------

leaseCommand
  .command('release')
  .description('Release a lease by its lease_id')
  .argument('<lease-id>', 'Opaque lease id returned by `claim`')
  .action(async (leaseId: string) => {
    try {
      initLeasesDb();
      releaseLease(leaseId);
      console.log(`Released lease ${leaseId}.`);
    } catch (error) {
      if (error instanceof StaleLeaseError) {
        console.error(
          `Error: lease ${error.leaseId} is no longer active (expired or revoked)`,
        );
        process.exit(1);
      }
      if (error instanceof LeaseContentionError) {
        console.error(`Error: contention timeout; retry`);
        process.exit(1);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// --- extend ----------------------------------------------------------------

leaseCommand
  .command('extend')
  .description('Extend a lease — sets new expires_at = now + ttl. Refuses if expired or stale.')
  .argument('<lease-id>', 'Opaque lease id')
  .requiredOption('--ttl <duration>', 'New TTL from now (e.g. 15m)')
  .action(async (leaseId: string, opts: { ttl: string }) => {
    try {
      initLeasesDb();
      const ttl_s = parseDuration(opts.ttl, 0);
      if (ttl_s <= 0) {
        throw new Error('--ttl must be positive');
      }
      const res = extendLease(leaseId, ttl_s);
      console.log(`Extended lease ${leaseId} (new expires_at=${res.new_expires_at}).`);
    } catch (error) {
      if (error instanceof StaleLeaseError) {
        console.error(
          `Error: lease ${error.leaseId} cannot be extended (expired, revoked, or member generation advanced)`,
        );
        process.exit(1);
      }
      if (error instanceof LeaseContentionError) {
        console.error(`Error: contention timeout; retry`);
        process.exit(1);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// --- show ------------------------------------------------------------------

leaseCommand
  .command('show')
  .description('Show a single lease as JSON')
  .argument('<lease-id>', 'Lease id')
  .action(async (leaseId: string) => {
    try {
      initLeasesDb();
      const row = getLease(leaseId);
      if (!row) {
        console.error(`Error: lease ${leaseId} not found`);
        process.exit(1);
        return;
      }
      console.log(JSON.stringify(row, null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// --- list ------------------------------------------------------------------

const VALID_STATES: ReadonlySet<LeaseState> = new Set([
  'active',
  'expired',
  'released',
  'revoked',
]);

leaseCommand
  .command('list')
  .description('List leases (optionally filtered by inventory and/or state)')
  .option('--inventory <slug>', 'Filter by inventory')
  .option('--state <state>', 'Filter by state: active|expired|released|revoked')
  .option('--json', 'Output JSON instead of a table')
  .action(async (opts: { inventory?: string; state?: string; json?: boolean }) => {
    try {
      initLeasesDb();
      let state: LeaseState | undefined;
      if (opts.state) {
        if (!VALID_STATES.has(opts.state as LeaseState)) {
          throw new Error(
            `--state must be one of: ${[...VALID_STATES].join('|')}`,
          );
        }
        state = opts.state as LeaseState;
      }
      // List inventories too, so a bare `syntaur lease list` shows something useful.
      if (!opts.inventory && !state && !opts.json) {
        const inventories = listInventories();
        if (inventories.length === 0) {
          console.log('(no inventories — create one with `syntaur lease create-inventory <slug> --kind <kind>`)');
          return;
        }
        for (const inv of inventories) {
          const detail = getInventoryDetail(inv.slug);
          if (!detail) continue;
          const idleCount = detail.members.filter((m) => m.status === 'idle').length;
          const leasedCount = detail.members.filter((m) => m.status === 'leased').length;
          console.log(
            `${inv.slug.padEnd(24)} kind=${inv.kind}  idle=${idleCount}  leased=${leasedCount}  active_leases=${detail.active_leases.length}`,
          );
        }
        return;
      }
      const rows = listLeases({ inventory: opts.inventory, state });
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log('(no leases match)');
        return;
      }
      for (const r of rows) {
        console.log(
          `${r.lease_id}  ${r.inventory_slug}/${r.member_id}  ${r.state}  expires=${r.expires_at}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// --- gc --------------------------------------------------------------------

leaseCommand
  .command('gc')
  .description('Sweep expired leases across all inventories (idempotent, concurrency-safe)')
  .action(async () => {
    try {
      initLeasesDb();
      const n = gcExpiredLeases();
      console.log(`Expired ${n} lease(s).`);
    } catch (error) {
      if (error instanceof LeaseContentionError) {
        console.error(`Error: contention timeout; retry`);
        process.exit(1);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// Suppress unused-helper lint by exporting (some callers may wrap actions).
export { withErrorHandling };
