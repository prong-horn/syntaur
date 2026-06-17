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
  listMembers,
  listInventories,
  getInventoryDetail,
  gcExpiredLeases,
  forceReleaseLease,
  getLeaseEvents,
  updateInventory,
  deleteInventory,
  releaseLeasesByRequestedFor,
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
  const seconds = n * mult[unit];
  // Bound the duration so claim/extend's `new Date(Date.now() + seconds*1000)`
  // can never overflow the JS Date range and throw a raw
  // "RangeError: Invalid time value". 100 years is far beyond any real lease.
  const MAX_DURATION_SECONDS = 100 * 365 * 86400;
  if (seconds > MAX_DURATION_SECONDS) {
    throw new Error(
      `invalid duration "${input}" — too large (max ${MAX_DURATION_SECONDS}s ≈ 100 years)`,
    );
  }
  return seconds;
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
  .description('Claim an idle member of an inventory. Fail-fast unless --wait is set.')
  .argument('<inventory>', 'Inventory slug')
  .option('--ttl <duration>', 'Lease TTL (overrides inventory default)')
  .option('--for <tag>', 'Free-form requester tag (session id, assignment slug, etc.)')
  .option(
    '--wait <duration>',
    'Block up to <duration> waiting for an idle member. Backoff: 100ms → 200ms → 400ms → 800ms → 1s cap.',
  )
  .option('--json', 'Output JSON instead of a one-line summary')
  .action(
    async (
      inventory: string,
      opts: { ttl?: string; for?: string; wait?: string; json?: boolean },
    ) => {
      try {
        initLeasesDb();
        const detail = getInventoryDetail(inventory);
        if (!detail) {
          console.error(`Error: inventory '${inventory}' not found`);
          process.exit(1);
          return;
        }
        const ttl_s = parseDuration(opts.ttl, detail.inventory.default_ttl_s);
        // Mirror the `extend` guard: a non-positive TTL would mint a lease whose
        // expires_at == granted_at (born-expired) and instantly get swept.
        if (ttl_s <= 0) {
          console.error('Error: --ttl must be positive');
          process.exit(1);
          return;
        }
        const waitBudgetMs =
          opts.wait !== undefined ? parseDuration(opts.wait, 0) * 1000 : 0;

        const tryClaim = (): ReturnType<typeof claimLease> =>
          claimLease(inventory, ttl_s, opts.for);

        let result: ReturnType<typeof claimLease>;
        if (waitBudgetMs <= 0) {
          result = tryClaim();
        } else {
          const deadline = Date.now() + waitBudgetMs;
          const backoffSchedule = [100, 200, 400, 800];
          let attempt = 0;
          // First attempt is immediate.
          while (true) {
            try {
              result = tryClaim();
              break;
            } catch (err) {
              if (!(err instanceof NoIdleMemberError)) throw err;
              const remaining = deadline - Date.now();
              if (remaining <= 0) {
                console.error(
                  `Error: timed out waiting ${opts.wait} for an idle member of '${inventory}'`,
                );
                process.exit(1);
                return;
              }
              const delay = Math.min(
                backoffSchedule[Math.min(attempt, backoffSchedule.length - 1)] ?? 1000,
                1000,
                remaining,
              );
              attempt += 1;
              await new Promise((r) => setTimeout(r, delay));
            }
          }
        }

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
    },
  );

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

// --- revoke ----------------------------------------------------------------

leaseCommand
  .command('revoke')
  .description(
    'Force-release a lease (administrative). Idempotent — already-revoked exits 0.',
  )
  .argument('<lease-id>', 'Lease id to revoke')
  .action(async (leaseId: string) => {
    try {
      initLeasesDb();
      const existing = getLease(leaseId);
      if (!existing) {
        console.error(`Error: lease ${leaseId} not found`);
        process.exit(1);
        return;
      }
      if (existing.state === 'revoked') {
        console.log(`already revoked ${leaseId}`);
        return;
      }
      const res = forceReleaseLease(leaseId);
      console.log(`revoked ${leaseId} (member_freed=${res.member_freed})`);
    } catch (error) {
      if (error instanceof NotFoundError) {
        console.error(`Error: lease ${error.id} not found`);
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

// --- release-all -----------------------------------------------------------

leaseCommand
  .command('release-all')
  .description('Release every active lease matching --for <tag>.')
  .requiredOption('--for <tag>', 'Requester tag to match against `requested_for`')
  .option('--json', 'Output JSON {released, stale} as id arrays')
  .action(async (opts: { for: string; json?: boolean }) => {
    try {
      initLeasesDb();
      const res = releaseLeasesByRequestedFor(opts.for);
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      for (const lid of res.released) {
        console.log(`released ${lid}`);
      }
      for (const lid of res.stale) {
        console.log(`skipped ${lid} (stale)`);
      }
      console.log(
        `released ${res.released.length} lease(s) for tag "${opts.for}" (${res.stale.length} stale skipped)`,
      );
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

// --- history ---------------------------------------------------------------

leaseCommand
  .command('history')
  .description(
    'Show lease_events. With a lease-id, print that lease\'s timeline; without, print the last N events across all leases.',
  )
  .argument('[lease-id]', 'Optional lease id to filter on')
  .option('--limit <n>', 'Max events to return (default 50)', '50')
  .option('--json', 'Output JSON rows')
  .action(
    async (
      leaseId: string | undefined,
      opts: { limit: string; json?: boolean },
    ) => {
      try {
        initLeasesDb();
        const limit = Number.parseInt(opts.limit, 10);
        if (!Number.isFinite(limit) || limit <= 0) {
          throw new Error('--limit must be a positive integer');
        }
        const rows = getLeaseEvents(leaseId, limit);
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        if (rows.length === 0) {
          console.log('(no events)');
          return;
        }
        for (const r of rows) {
          const detail = r.detail_json ? ` ${r.detail_json}` : '';
          console.log(`${r.at}  ${r.event.padEnd(16)} ${r.lease_id}${detail}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    },
  );

// --- inventory group -------------------------------------------------------

const inventoryCommand = leaseCommand
  .command('inventory')
  .description('Manage existing inventories (update, delete)');

inventoryCommand
  .command('update')
  .description(
    'Update mutable inventory fields. `kind` is immutable in v1.',
  )
  .argument('<slug>', 'Inventory slug')
  .option('--default-ttl <duration>', 'New default TTL (e.g. 30m, 2h)')
  .option('--display-name <text>', 'New display name')
  .action(
    async (
      slug: string,
      opts: { defaultTtl?: string; displayName?: string },
    ) => {
      try {
        initLeasesDb();
        if (opts.defaultTtl === undefined && opts.displayName === undefined) {
          throw new Error(
            'nothing to update — pass --default-ttl or --display-name',
          );
        }
        const patch: { default_ttl_s?: number; display_name?: string } = {};
        if (opts.defaultTtl !== undefined) {
          patch.default_ttl_s = parseDuration(opts.defaultTtl, 0);
        }
        if (opts.displayName !== undefined) {
          patch.display_name = opts.displayName;
        }
        const row = updateInventory(slug, patch);
        console.log(
          `Updated inventory '${row.slug}' (kind=${row.kind}, default_ttl=${row.default_ttl_s}s, display_name=${row.display_name ?? '(none)'}).`,
        );
      } catch (error) {
        if (error instanceof NotFoundError) {
          console.error(`Error: inventory '${slug}' not found`);
          process.exit(1);
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    },
  );

inventoryCommand
  .command('delete')
  .description(
    'Delete an inventory. Refuses if any lease is active unless --force is set.',
  )
  .argument('<slug>', 'Inventory slug')
  .option('--force', 'Revoke all active leases first, then cascade delete')
  .action(async (slug: string, opts: { force?: boolean }) => {
    try {
      initLeasesDb();
      const res = deleteInventory(slug, { force: opts.force });
      console.log(
        `deleted "${slug}" (revoked ${res.revoked} active lease(s))`,
      );
    } catch (error) {
      if (error instanceof MemberInUseError) {
        console.error(
          `Error: inventory "${slug}" has active leases — use --force to revoke and delete`,
        );
        process.exit(1);
      }
      if (error instanceof NotFoundError) {
        console.error(`Error: inventory '${slug}' not found`);
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

// --- member list -----------------------------------------------------------

memberCommand
  .command('list')
  .description('List all members of an inventory (pure roster — no lease state).')
  .argument('<inventory>', 'Inventory slug')
  .option('--json', 'Output JSON rows')
  .action(async (inventory: string, opts: { json?: boolean }) => {
    try {
      initLeasesDb();
      const rows = listMembers(inventory);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log('(no members)');
        return;
      }
      for (const r of rows) {
        const meta = r.metadata_json ? ` ${r.metadata_json}` : '';
        const last = r.last_used_at ? ` last_used=${r.last_used_at}` : '';
        console.log(
          `${r.member_id.padEnd(24)} ${r.status.padEnd(8)} gen=${r.generation}${last}${meta}`,
        );
      }
    } catch (error) {
      if (error instanceof NotFoundError) {
        console.error(`Error: inventory '${inventory}' not found`);
        process.exit(1);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// Suppress unused-helper lint by exporting (some callers may wrap actions).
export { withErrorHandling };
