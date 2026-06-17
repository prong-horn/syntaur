/**
 * Resource leases database module.
 *
 * Shares `~/.syntaur/syntaur.db` with `session-db.ts` and `proof-db.ts`. Each
 * module owns its own schema-version row in the shared `meta` table and creates
 * `meta` with `IF NOT EXISTS` so init order is irrelevant and standalone init
 * (e.g. in a leases-only test DB) is safe.
 *
 * Concurrency model:
 *   - `journal_mode = WAL` allows concurrent readers and one writer.
 *   - `busy_timeout = 5000` lets SQLite absorb short lock contention internally.
 *   - All mutating ops run inside `db.transaction(fn).immediate()` which issues
 *     `BEGIN IMMEDIATE` — acquires the reserved lock up-front so two concurrent
 *     writers serialize cleanly.
 *
 * Atomic claim uses the tuple-subquery form (the bundled SQLite is built
 * without `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, so `UPDATE...ORDER BY...LIMIT...
 * RETURNING` is a syntax error — verified empirically).
 *
 * Timestamp invariant: every timestamp written from this module is produced by
 * `nowIso()` which calls `new Date().toISOString()` (canonical UTC, lexicographic-
 * safe). Lexicographic `<=` comparisons in SQL rely on this. The CLI never
 * accepts user-supplied timestamps. A future caller writing a non-canonical
 * timestamp would silently misorder `<=` checks.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { syntaurRoot } from '../utils/paths.js';

let db: Database.Database | null = null;

const LEASE_SCHEMA_VERSION = '1';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS inventories (
  slug          TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  display_name  TEXT,
  default_ttl_s INTEGER NOT NULL CHECK (default_ttl_s > 0),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_members (
  inventory_slug TEXT NOT NULL,
  member_id      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'idle'
                   CHECK (status IN ('idle','leased','retired')),
  generation     INTEGER NOT NULL DEFAULT 0,
  metadata_json  TEXT,
  last_used_at   TEXT,
  retired_at     TEXT,
  PRIMARY KEY (inventory_slug, member_id),
  FOREIGN KEY (inventory_slug) REFERENCES inventories(slug)
);

CREATE INDEX IF NOT EXISTS idx_members_idle
  ON inventory_members (inventory_slug, status, last_used_at);

CREATE TABLE IF NOT EXISTS leases (
  lease_id        TEXT PRIMARY KEY,
  inventory_slug  TEXT NOT NULL,
  member_id       TEXT NOT NULL,
  member_gen      INTEGER NOT NULL,
  state           TEXT NOT NULL
                    CHECK (state IN ('active','released','expired','revoked')),
  granted_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  released_at     TEXT,
  requested_for   TEXT,
  FOREIGN KEY (inventory_slug, member_id)
    REFERENCES inventory_members(inventory_slug, member_id)
);

CREATE INDEX IF NOT EXISTS idx_leases_gc
  ON leases (state, expires_at);

CREATE TABLE IF NOT EXISTS lease_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id     TEXT NOT NULL,
  event        TEXT NOT NULL,
  at           TEXT NOT NULL,
  detail_json  TEXT,
  FOREIGN KEY (lease_id) REFERENCES leases(lease_id)
);

CREATE INDEX IF NOT EXISTS idx_events_lease
  ON lease_events (lease_id, at);
`;

// --- Types -----------------------------------------------------------------

export type MemberStatus = 'idle' | 'leased' | 'retired';
export type LeaseState = 'active' | 'released' | 'expired' | 'revoked';

export interface InventoryRow {
  slug: string;
  kind: string;
  display_name: string | null;
  default_ttl_s: number;
  created_at: string;
}

export interface InventoryMemberRow {
  inventory_slug: string;
  member_id: string;
  status: MemberStatus;
  generation: number;
  metadata_json: string | null;
  last_used_at: string | null;
  retired_at: string | null;
}

export interface LeaseRow {
  lease_id: string;
  inventory_slug: string;
  member_id: string;
  member_gen: number;
  state: LeaseState;
  granted_at: string;
  expires_at: string;
  released_at: string | null;
  requested_for: string | null;
}

export interface LeaseEventRow {
  id: number;
  lease_id: string;
  event: string;
  at: string;
  detail_json: string | null;
}

export interface InventoryDetail {
  inventory: InventoryRow;
  members: InventoryMemberRow[];
  active_leases: LeaseRow[];
}

export interface CreateInventoryInput {
  slug: string;
  kind: string;
  display_name?: string;
  default_ttl_s: number;
}

export interface AddMemberInput {
  inventory_slug: string;
  member_id: string;
  metadata?: Record<string, unknown>;
}

export interface ClaimResult {
  lease_id: string;
  inventory_slug: string;
  member_id: string;
  member_gen: number;
  granted_at: string;
  expires_at: string;
  metadata: Record<string, unknown> | null;
}

export interface ListLeasesFilter {
  inventory?: string;
  state?: LeaseState;
}

// --- Errors ----------------------------------------------------------------

export class NoIdleMemberError extends Error {
  constructor(public readonly inventorySlug: string) {
    super(`no idle members in '${inventorySlug}'`);
    this.name = 'NoIdleMemberError';
  }
}

export class StaleLeaseError extends Error {
  constructor(public readonly leaseId: string) {
    super(`lease ${leaseId} is no longer active (expired or revoked)`);
    this.name = 'StaleLeaseError';
  }
}

export class NotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`lease ${id} not found`);
    this.name = 'NotFoundError';
  }
}

export class LeaseContentionError extends Error {
  constructor(public readonly inventorySlug: string) {
    super(`contention timeout on '${inventorySlug}'; retry`);
    this.name = 'LeaseContentionError';
  }
}

export class MemberInUseError extends Error {
  constructor(public readonly inventorySlug: string, public readonly memberId: string) {
    super(`member ${inventorySlug}/${memberId} is currently leased; release before retiring`);
    this.name = 'MemberInUseError';
  }
}

export class DuplicateInventoryError extends Error {
  constructor(public readonly slug: string) {
    super(`inventory '${slug}' already exists`);
    this.name = 'DuplicateInventoryError';
  }
}

export class DuplicateMemberError extends Error {
  constructor(public readonly inventorySlug: string, public readonly memberId: string) {
    super(`member ${inventorySlug}/${memberId} already exists`);
    this.name = 'DuplicateMemberError';
  }
}

// --- Helpers ---------------------------------------------------------------

/** Canonical UTC ISO 8601 timestamp. Lexicographic-safe for SQL `<=` checks. */
export function nowIso(): string {
  return new Date().toISOString();
}

function isBusyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string };
  return e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_BUSY_SNAPSHOT';
}

// --- Lifecycle -------------------------------------------------------------

/**
 * Initialize the leases database. Idempotent — repeated calls return the same
 * singleton handle. Pass an explicit `dbPath` for tests; defaults to
 * `~/.syntaur/syntaur.db`. Safe to run standalone (creates its own `meta` table).
 */
export function initLeasesDb(dbPath?: string): Database.Database {
  if (db) return db;

  const finalPath = dbPath ?? resolve(syntaurRoot(), 'syntaur.db');
  db = new Database(finalPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  const database = db;
  const runMigrations = database.transaction(() => {
    database.exec(SCHEMA_SQL);
    database
      .prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
      .run('lease_schema_version', LEASE_SCHEMA_VERSION);
  });
  runMigrations.exclusive();

  return db;
}

export function getLeasesDb(): Database.Database {
  if (!db) {
    throw new Error('Leases database not initialized. Call initLeasesDb() first.');
  }
  return db;
}

export function closeLeasesDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function resetLeasesDb(): void {
  db = null;
}

// --- Inventories -----------------------------------------------------------

export function createInventory(input: CreateInventoryInput): InventoryRow {
  const database = getLeasesDb();
  const row: InventoryRow = {
    slug: input.slug,
    kind: input.kind,
    display_name: input.display_name ?? null,
    default_ttl_s: input.default_ttl_s,
    created_at: nowIso(),
  };
  try {
    database
      .prepare(
        `INSERT INTO inventories (slug, kind, display_name, default_ttl_s, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.slug, row.kind, row.display_name, row.default_ttl_s, row.created_at);
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw new DuplicateInventoryError(input.slug);
    }
    throw err;
  }
  return row;
}

export function listInventories(): InventoryRow[] {
  const database = getLeasesDb();
  return database
    .prepare(
      `SELECT slug, kind, display_name, default_ttl_s, created_at
       FROM inventories ORDER BY slug`,
    )
    .all() as InventoryRow[];
}

export function getInventoryDetail(slug: string): InventoryDetail | null {
  const database = getLeasesDb();
  const inv = database
    .prepare(
      `SELECT slug, kind, display_name, default_ttl_s, created_at
       FROM inventories WHERE slug = ?`,
    )
    .get(slug) as InventoryRow | undefined;
  if (!inv) return null;
  const members = database
    .prepare(
      `SELECT inventory_slug, member_id, status, generation, metadata_json, last_used_at, retired_at
       FROM inventory_members WHERE inventory_slug = ?
       ORDER BY member_id`,
    )
    .all(slug) as InventoryMemberRow[];
  const active_leases = database
    .prepare(
      `SELECT lease_id, inventory_slug, member_id, member_gen, state, granted_at, expires_at, released_at, requested_for
       FROM leases WHERE inventory_slug = ? AND state = 'active'
       ORDER BY granted_at`,
    )
    .all(slug) as LeaseRow[];
  return { inventory: inv, members, active_leases };
}

// --- Members ---------------------------------------------------------------

export function addMember(input: AddMemberInput): InventoryMemberRow {
  const database = getLeasesDb();
  const row: InventoryMemberRow = {
    inventory_slug: input.inventory_slug,
    member_id: input.member_id,
    status: 'idle',
    generation: 0,
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
    last_used_at: null,
    retired_at: null,
  };
  try {
    database
      .prepare(
        `INSERT INTO inventory_members
           (inventory_slug, member_id, status, generation, metadata_json)
         VALUES (?, ?, 'idle', 0, ?)`,
      )
      .run(row.inventory_slug, row.member_id, row.metadata_json);
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw new DuplicateMemberError(input.inventory_slug, input.member_id);
    }
    throw err;
  }
  return row;
}

export function retireMember(inventorySlug: string, memberId: string): void {
  const database = getLeasesDb();
  const retire = database.transaction(() => {
    const row = database
      .prepare(
        `SELECT status FROM inventory_members
         WHERE inventory_slug = ? AND member_id = ?`,
      )
      .get(inventorySlug, memberId) as { status: MemberStatus } | undefined;
    if (!row) throw new NotFoundError(`${inventorySlug}/${memberId}`);
    if (row.status === 'leased') {
      throw new MemberInUseError(inventorySlug, memberId);
    }
    database
      .prepare(
        `UPDATE inventory_members
           SET status = 'retired', generation = generation + 1, retired_at = ?
         WHERE inventory_slug = ? AND member_id = ?`,
      )
      .run(nowIso(), inventorySlug, memberId);
  });
  retire.immediate();
}

// --- Claim -----------------------------------------------------------------

/**
 * Claim an idle member of `slug`. Atomic — uses `BEGIN IMMEDIATE` so two
 * concurrent claimants serialize. Returns lease metadata or throws
 * `NoIdleMemberError` if the inventory has nothing claimable after sweeping.
 */
export function claimLease(
  slug: string,
  ttl_s: number,
  requested_for?: string,
): ClaimResult {
  const database = getLeasesDb();

  try {
    const fn = database.transaction(() => {
      const now = nowIso();

      // (1) Opportunistic sweep — expire active leases on this inventory whose TTL is up.
      database
        .prepare(
          `UPDATE leases
              SET state = 'expired'
            WHERE state = 'active'
              AND expires_at <= ?
              AND inventory_slug = ?`,
        )
        .run(now, slug);

      // (2) Free their members (CAS on generation match).
      database
        .prepare(
          `UPDATE inventory_members
              SET status = 'idle', generation = generation + 1
            WHERE inventory_slug = ?
              AND status = 'leased'
              AND (inventory_slug, member_id) IN (
                SELECT inventory_slug, member_id
                  FROM leases
                 WHERE inventory_slug = ?
                   AND state = 'expired'
                   AND released_at IS NULL
              )
              AND generation = (
                SELECT member_gen FROM leases l
                 WHERE l.inventory_slug = inventory_members.inventory_slug
                   AND l.member_id      = inventory_members.member_id
                   AND l.state          = 'expired'
                   AND l.released_at IS NULL
                ORDER BY l.granted_at DESC LIMIT 1
              )`,
        )
        .run(slug, slug);

      // (3) Mark those freshly-expired leases as fully released (idempotent sentinel).
      database
        .prepare(
          `UPDATE leases
              SET released_at = ?
            WHERE state = 'expired'
              AND released_at IS NULL
              AND inventory_slug = ?`,
        )
        .run(now, slug);

      // (4) Pick an idle member via tuple-subquery (verified portable form).
      const picked = database
        .prepare(
          `UPDATE inventory_members
              SET status = 'leased',
                  generation = generation + 1,
                  last_used_at = ?
            WHERE (inventory_slug, member_id) = (
              SELECT inventory_slug, member_id
                FROM inventory_members
               WHERE inventory_slug = ? AND status = 'idle'
               ORDER BY last_used_at ASC NULLS FIRST
               LIMIT 1
            )
           RETURNING member_id, generation, metadata_json`,
        )
        .get(now, slug) as
        | { member_id: string; generation: number; metadata_json: string | null }
        | undefined;

      if (!picked) {
        throw new NoIdleMemberError(slug);
      }

      // (5) Insert the lease tied to the new member_gen.
      const lease_id = randomUUID();
      const expires_at = new Date(Date.now() + ttl_s * 1000).toISOString();
      database
        .prepare(
          `INSERT INTO leases
             (lease_id, inventory_slug, member_id, member_gen,
              state, granted_at, expires_at, requested_for)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          lease_id,
          slug,
          picked.member_id,
          picked.generation,
          now,
          expires_at,
          requested_for ?? null,
        );

      // (6) Event.
      database
        .prepare(
          `INSERT INTO lease_events (lease_id, event, at, detail_json)
           VALUES (?, 'claimed', ?, ?)`,
        )
        .run(lease_id, now, JSON.stringify({ member_id: picked.member_id }));

      return {
        lease_id,
        inventory_slug: slug,
        member_id: picked.member_id,
        member_gen: picked.generation,
        granted_at: now,
        expires_at,
        metadata: picked.metadata_json
          ? (JSON.parse(picked.metadata_json) as Record<string, unknown>)
          : null,
      } satisfies ClaimResult;
    });

    return fn.immediate();
  } catch (err) {
    if (isBusyError(err)) throw new LeaseContentionError(slug);
    throw err;
  }
}

// --- Release ---------------------------------------------------------------

export function releaseLease(lease_id: string): void {
  const database = getLeasesDb();

  try {
    const fn = database.transaction(() => {
      const now = nowIso();

      // (1) CAS-guarded member free.
      const memberRes = database
        .prepare(
          `UPDATE inventory_members
              SET status = 'idle', generation = generation + 1
            WHERE (inventory_slug, member_id) = (
                SELECT inventory_slug, member_id FROM leases
                 WHERE lease_id = ? AND state = 'active'
              )
              AND generation = (
                SELECT member_gen FROM leases
                 WHERE lease_id = ? AND state = 'active'
              )`,
        )
        .run(lease_id, lease_id);

      if (memberRes.changes === 0) {
        throw new StaleLeaseError(lease_id);
      }

      // (2) Mark lease released.
      database
        .prepare(
          `UPDATE leases
              SET state = 'released', released_at = ?
            WHERE lease_id = ? AND state = 'active'`,
        )
        .run(now, lease_id);

      // (3) Event.
      database
        .prepare(
          `INSERT INTO lease_events (lease_id, event, at)
           VALUES (?, 'released', ?)`,
        )
        .run(lease_id, now);
    });

    fn.immediate();
  } catch (err) {
    if (isBusyError(err)) throw new LeaseContentionError(lease_id);
    throw err;
  }
}

// --- Extend ----------------------------------------------------------------

/**
 * Extend a lease's TTL from NOW. Refuses if the lease is no longer active,
 * already past its wall-clock expiry, or its bound member generation has
 * advanced.
 */
export function extendLease(lease_id: string, ttl_s: number): { new_expires_at: string } {
  const database = getLeasesDb();

  try {
    const fn = database.transaction(() => {
      const now = nowIso();
      const new_expires_at = new Date(Date.now() + ttl_s * 1000).toISOString();

      const res = database
        .prepare(
          `UPDATE leases
              SET expires_at = ?
            WHERE lease_id = ?
              AND state = 'active'
              AND expires_at > ?
              AND member_gen = (
                SELECT generation FROM inventory_members
                 WHERE inventory_slug = leases.inventory_slug
                   AND member_id      = leases.member_id
              )`,
        )
        .run(new_expires_at, lease_id, now);

      if (res.changes === 0) {
        throw new StaleLeaseError(lease_id);
      }

      database
        .prepare(
          `INSERT INTO lease_events (lease_id, event, at, detail_json)
           VALUES (?, 'extended', ?, ?)`,
        )
        .run(lease_id, now, JSON.stringify({ new_expires_at }));

      return { new_expires_at };
    });

    return fn.immediate();
  } catch (err) {
    if (isBusyError(err)) throw new LeaseContentionError(lease_id);
    throw err;
  }
}

// --- Read ------------------------------------------------------------------

export function getLease(lease_id: string): LeaseRow | null {
  const database = getLeasesDb();
  const row = database
    .prepare(
      `SELECT lease_id, inventory_slug, member_id, member_gen, state,
              granted_at, expires_at, released_at, requested_for
       FROM leases WHERE lease_id = ?`,
    )
    .get(lease_id) as LeaseRow | undefined;
  return row ?? null;
}

export function listLeases(filter?: ListLeasesFilter): LeaseRow[] {
  const database = getLeasesDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter?.inventory) {
    where.push('inventory_slug = ?');
    params.push(filter.inventory);
  }
  if (filter?.state) {
    where.push('state = ?');
    params.push(filter.state);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return database
    .prepare(
      `SELECT lease_id, inventory_slug, member_id, member_gen, state,
              granted_at, expires_at, released_at, requested_for
       FROM leases ${whereSql}
       ORDER BY granted_at DESC`,
    )
    .all(...params) as LeaseRow[];
}

export function listMembers(inventory_slug: string): InventoryMemberRow[] {
  const database = getLeasesDb();
  const inv = database
    .prepare('SELECT slug FROM inventories WHERE slug = ?')
    .get(inventory_slug);
  if (!inv) throw new NotFoundError(inventory_slug);
  return database
    .prepare(
      `SELECT inventory_slug, member_id, status, generation, metadata_json, last_used_at, retired_at
       FROM inventory_members WHERE inventory_slug = ?
       ORDER BY member_id`,
    )
    .all(inventory_slug) as InventoryMemberRow[];
}

/**
 * Read lease_events. With a `lease_id`, returns that lease's most recent `limit`
 * events, displayed oldest-first (so when truncated you keep the NEWEST activity,
 * not the oldest). Without, returns the most recent `limit` events across all
 * leases in reverse-chronological order (newest first).
 */
export function getLeaseEvents(lease_id?: string, limit = 50): LeaseEventRow[] {
  const database = getLeasesDb();
  if (lease_id) {
    // Select the newest `limit` (DESC), then re-order ascending for display.
    // The previous `ORDER BY at ASC … LIMIT ?` kept the OLDEST N and silently
    // dropped recent events — the opposite of what a timeline viewer wants.
    return database
      .prepare(
        `SELECT id, lease_id, event, at, detail_json FROM (
           SELECT id, lease_id, event, at, detail_json
           FROM lease_events WHERE lease_id = ?
           ORDER BY at DESC, id DESC
           LIMIT ?
         ) ORDER BY at ASC, id ASC`,
      )
      .all(lease_id, limit) as LeaseEventRow[];
  }
  return database
    .prepare(
      `SELECT id, lease_id, event, at, detail_json
       FROM lease_events
       ORDER BY at DESC, id DESC
       LIMIT ?`,
    )
    .all(limit) as LeaseEventRow[];
}

// --- GC --------------------------------------------------------------------

/**
 * Sweep expired leases across ALL inventories. Idempotent; safe to run
 * concurrently with claims (`BEGIN IMMEDIATE` serializes writers).
 * Returns the number of leases newly transitioned to `expired`.
 */
export function gcExpiredLeases(): number {
  const database = getLeasesDb();

  try {
    const fn = database.transaction(() => {
      const now = nowIso();

      const expRes = database
        .prepare(
          `UPDATE leases SET state = 'expired'
            WHERE state = 'active' AND expires_at <= ?`,
        )
        .run(now);

      database
        .prepare(
          `UPDATE inventory_members
              SET status = 'idle', generation = generation + 1
            WHERE status = 'leased'
              AND (inventory_slug, member_id) IN (
                SELECT inventory_slug, member_id FROM leases
                 WHERE state = 'expired' AND released_at IS NULL
              )
              AND generation = (
                SELECT member_gen FROM leases l
                 WHERE l.inventory_slug = inventory_members.inventory_slug
                   AND l.member_id      = inventory_members.member_id
                   AND l.state          = 'expired'
                   AND l.released_at IS NULL
                ORDER BY l.granted_at DESC LIMIT 1
              )`,
        )
        .run();

      database
        .prepare(
          `UPDATE leases SET released_at = ?
            WHERE state = 'expired' AND released_at IS NULL AND expires_at <= ?`,
        )
        .run(now, now);

      return expRes.changes;
    });

    return fn.immediate();
  } catch (err) {
    if (isBusyError(err)) throw new LeaseContentionError('gc');
    throw err;
  }
}

// --- Force release ---------------------------------------------------------

/**
 * Administrative force-release. Bypasses the lease's `state = 'active'` check
 * (humans force-releasing an already-expired-but-not-yet-released lease is
 * fine), but CAS-guards the member free on the lease's bound `member_gen`.
 * This prevents stomping a member that's currently held by a *different*
 * active lease (i.e. the targeted lease is already terminal and the slot has
 * been re-claimed).
 *
 * Returns `member_freed: true` if the member was actually idled by this call,
 * `false` if a newer claim has already taken the slot.
 */
export function forceReleaseLease(lease_id: string): { member_freed: boolean } {
  const database = getLeasesDb();

  try {
    const fn = database.transaction(() => {
      const now = nowIso();

      const lookup = database
        .prepare(
          `SELECT inventory_slug, member_id, member_gen, state
           FROM leases WHERE lease_id = ?`,
        )
        .get(lease_id) as
        | { inventory_slug: string; member_id: string; member_gen: number; state: LeaseState }
        | undefined;

      if (!lookup) throw new NotFoundError(lease_id);
      if (lookup.state === 'revoked') return { member_freed: false };

      // CAS: free the member only if the lease is still its current holder.
      const memberRes = database
        .prepare(
          `UPDATE inventory_members
              SET status = 'idle', generation = generation + 1
            WHERE inventory_slug = ? AND member_id = ?
              AND generation = ?`,
        )
        .run(lookup.inventory_slug, lookup.member_id, lookup.member_gen);

      database
        .prepare(
          `UPDATE leases
              SET state = 'revoked', released_at = ?
            WHERE lease_id = ? AND state != 'revoked'`,
        )
        .run(now, lease_id);

      const member_freed = memberRes.changes > 0;
      database
        .prepare(
          `INSERT INTO lease_events (lease_id, event, at, detail_json)
           VALUES (?, 'force_released', ?, ?)`,
        )
        .run(lease_id, now, JSON.stringify({ member_freed }));

      return { member_freed };
    });

    return fn.immediate();
  } catch (err) {
    if (isBusyError(err)) throw new LeaseContentionError(lease_id);
    throw err;
  }
}

// --- Inventory update / delete --------------------------------------------

export interface UpdateInventoryInput {
  default_ttl_s?: number;
  display_name?: string | null;
}

/**
 * Update mutable inventory fields. `kind` is immutable in v1 — the typed
 * signature excludes it, and a runtime guard rejects any caller that sneaks
 * a `kind` key through (defense in depth).
 */
export function updateInventory(
  slug: string,
  input: UpdateInventoryInput,
): InventoryRow {
  if ('kind' in input) {
    throw new Error('inventory kind is immutable');
  }
  if (
    input.default_ttl_s === undefined &&
    input.display_name === undefined
  ) {
    throw new Error('nothing to update');
  }
  if (input.default_ttl_s !== undefined && input.default_ttl_s <= 0) {
    throw new Error('default_ttl_s must be positive');
  }
  const database = getLeasesDb();

  const fn = database.transaction(() => {
    const existing = database
      .prepare('SELECT slug FROM inventories WHERE slug = ?')
      .get(slug);
    if (!existing) throw new NotFoundError(slug);

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.default_ttl_s !== undefined) {
      sets.push('default_ttl_s = ?');
      params.push(input.default_ttl_s);
    }
    if (input.display_name !== undefined) {
      sets.push('display_name = ?');
      params.push(input.display_name);
    }
    params.push(slug);

    database
      .prepare(`UPDATE inventories SET ${sets.join(', ')} WHERE slug = ?`)
      .run(...params);

    return database
      .prepare(
        `SELECT slug, kind, display_name, default_ttl_s, created_at
         FROM inventories WHERE slug = ?`,
      )
      .get(slug) as InventoryRow;
  });

  try {
    return fn.immediate();
  } catch (err) {
    if (isBusyError(err)) throw new LeaseContentionError(slug);
    throw err;
  }
}

/**
 * Delete an inventory and all of its members, leases, and lease_events.
 *
 * Without `force`: refuses if any lease for the inventory is currently
 * `active` (throws `MemberInUseError`).
 *
 * With `force`: tallies active leases as `revoked` and cascades through
 * events → leases → members → inventory row, ALL inside one `BEGIN IMMEDIATE`
 * transaction. The acquire-up-front lock prevents a concurrent `claimLease`
 * from grabbing a freshly-idled member between the active-lease snapshot and
 * the cascade — what would otherwise be a use-after-free window. No explicit
 * `force_released` event is written because the entire event log for this
 * inventory is deleted in the same tx anyway.
 */
export function deleteInventory(
  slug: string,
  opts: { force?: boolean } = {},
): { deleted: boolean; revoked: number } {
  const database = getLeasesDb();

  let revoked = 0;
  const fn = database.transaction(() => {
    const existing = database
      .prepare('SELECT slug FROM inventories WHERE slug = ?')
      .get(slug);
    if (!existing) throw new NotFoundError(slug);

    const activeLeases = database
      .prepare(
        `SELECT lease_id FROM leases
          WHERE inventory_slug = ? AND state = 'active'`,
      )
      .all(slug) as Array<{ lease_id: string }>;

    if (activeLeases.length > 0 && !opts.force) {
      throw new MemberInUseError(slug, '*');
    }
    revoked = activeLeases.length;

    database
      .prepare(
        `DELETE FROM lease_events
          WHERE lease_id IN (SELECT lease_id FROM leases WHERE inventory_slug = ?)`,
      )
      .run(slug);
    database.prepare('DELETE FROM leases WHERE inventory_slug = ?').run(slug);
    database
      .prepare('DELETE FROM inventory_members WHERE inventory_slug = ?')
      .run(slug);
    database.prepare('DELETE FROM inventories WHERE slug = ?').run(slug);
  });

  try {
    fn.immediate();
  } catch (err) {
    if (isBusyError(err)) throw new LeaseContentionError(slug);
    throw err;
  }
  return { deleted: true, revoked };
}

// --- Bulk release by tag --------------------------------------------------

/**
 * Release every `active` lease whose `requested_for` matches `tag`. Per-row
 * `releaseLease` calls keep each release in its own transaction; a
 * `StaleLeaseError` from any individual release is tallied as `stale` and
 * swallowed (the caller asked for a best-effort sweep). Returns the
 * per-lease ids in two arrays so callers can render one-line-per-lease
 * summaries without re-querying.
 */
export function releaseLeasesByRequestedFor(
  tag: string,
): { released: string[]; stale: string[] } {
  const database = getLeasesDb();
  const rows = database
    .prepare(
      `SELECT lease_id FROM leases
        WHERE state = 'active' AND requested_for = ?`,
    )
    .all(tag) as Array<{ lease_id: string }>;

  const released: string[] = [];
  const stale: string[] = [];
  for (const { lease_id } of rows) {
    try {
      releaseLease(lease_id);
      released.push(lease_id);
    } catch (err) {
      if (err instanceof StaleLeaseError) {
        stale.push(lease_id);
        continue;
      }
      throw err;
    }
  }
  return { released, stale };
}
