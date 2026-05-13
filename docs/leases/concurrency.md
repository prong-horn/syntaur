# Concurrency + correctness

The leases primitive is the first piece of Syntaur that promises atomic coordination across processes. This document spells out the correctness contract and the mechanics that uphold it.

## The contract

Given an inventory of N members and any number of concurrent callers:

1. **Atomic claim** — two simultaneous `lease claim` calls against an inventory with one idle member never both succeed. Exactly one returns a lease; the other gets `NoIdleMemberError` (or `LeaseContentionError` if SQLite couldn't acquire the write lock within `busy_timeout`).
2. **CAS release** — a stale `release` issued after the lease expired AND the slot was re-claimed by someone else does NOT free the new claim's slot. The stale caller gets `StaleLeaseError`.
3. **Idempotent GC** — `gc` may run concurrently with claims and other `gc` calls; it never double-frees a member or corrupts the lease state.
4. **Lexicographic time** — TTL comparisons (`expires_at <= now`) are correct under any clock reading because every timestamp is canonical UTC ISO 8601.

Each of these has a regression test in `src/__tests__/leases-db.test.ts`. The two-process / real-overlap tests use Node `worker_threads` + `Atomics` to drive genuine concurrent claims through a single SQLite file.

## Mechanics

### WAL mode + `BEGIN IMMEDIATE`

`initLeasesDb()` sets:

```js
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
```

WAL allows concurrent readers and one writer. Every mutating op runs inside `db.transaction(fn).immediate()`, which issues `BEGIN IMMEDIATE`. That acquires the *reserved* lock at the top of the transaction rather than deferring to first-write — two concurrent writers therefore serialize cleanly via SQLite's internal lock rather than racing into a deadlock at COMMIT time.

`busy_timeout = 5000` lets SQLite absorb up to 5 seconds of contention internally. If that runs out, the operation throws with `code = 'SQLITE_BUSY'`, which the module catches and rethrows as a typed `LeaseContentionError`. The CLI surfaces it as `Error: contention timeout; retry`.

### Atomic claim — tuple-subquery form

The natural `UPDATE … ORDER BY last_used_at LIMIT 1 RETURNING …` syntax does NOT work — the bundled `better-sqlite3` is built without `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, so it's a syntax error (verified empirically; this is documented as a top-of-file comment in `leases-db.ts`). Instead `claimLease()` uses the portable tuple-subquery form:

```sql
UPDATE inventory_members
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
RETURNING member_id, generation, metadata_json;
```

This runs as a single statement inside `BEGIN IMMEDIATE`. Because the lock is reserved up front, a second claimant arriving while we're inside this transaction blocks at its own `BEGIN IMMEDIATE` and sees the new state on retry — meaning either it gets the next idle member or `NoIdleMemberError`.

### CAS release via `member_gen`

`claimLease()` snapshots `inventory_members.generation` into `leases.member_gen` at the moment of claim. `releaseLease()` then runs:

```sql
UPDATE inventory_members
   SET status = 'idle', generation = generation + 1
 WHERE (inventory_slug, member_id) = (
       SELECT inventory_slug, member_id FROM leases
        WHERE lease_id = ? AND state = 'active'
       )
   AND generation = (
       SELECT member_gen FROM leases
        WHERE lease_id = ? AND state = 'active'
       );
```

If `member_gen` no longer matches the live `inventory_members.generation`, the UPDATE affects 0 rows and the function throws `StaleLeaseError`. **The lease row itself is then left untouched**, so a subsequent `show` still shows the old state — useful for debugging "what happened to my lease". This is the regression hardening test scenario:

> Caller A claims member-1. Caller A's lease TTL expires. `gc` reclaims member-1; generation bumps from 7 → 8. Caller B claims and gets member-1 with `member_gen=8`. Caller A finally calls `release` — and **must not** free member-1, because B is using it.

Force-release works the same way: `forceReleaseLease()` bumps `generation`, so any later `release` or `extend` from the original holder fails CAS.

### Opportunistic sweep inside claim

`claimLease()` runs a three-step expire-and-free at the top of every claim — see [data model](./data-model.md#the-two-step-expire-pattern). The point is that `gc` is a convenience, not a correctness requirement: even if no scheduled `gc` ever runs, the next claim on a contended inventory will reclaim its own expired members. `gc` exists for the cold-inventory case (TTL expired but nobody's claiming, so the slot stays "leased" until something looks).

### Lexicographic timestamps

Every write goes through:

```ts
export function nowIso(): string {
  return new Date().toISOString();   // canonical UTC, e.g. '2026-05-12T18:04:11.221Z'
}
```

Canonical ISO 8601 in UTC sorts correctly under `<=` as plain text. This is what makes `WHERE expires_at <= now` a valid TTL check without parsing dates in SQL. If anyone ever inserts a non-canonical timestamp — local time, offset suffix, missing milliseconds — `<=` will silently misorder. **The CLI never accepts user-supplied timestamps**, and any new DB-level entry point must route through `nowIso()`.

## Failure modes and the right response

| Symptom | Cause | Right response |
|---|---|---|
| `NoIdleMemberError` | Pool exhausted. | Pass `claim --wait <duration>` for a bounded poll, retry externally with your own backoff, or add capacity. |
| `LeaseContentionError` | `SQLITE_BUSY` for >5s. Usually means a runaway transaction or pathological concurrency. | Retry once after ~1s. If it persists, check for a stuck process holding a write lock. |
| `StaleLeaseError` on `release` | Your lease expired or was force-released. Slot has been reclaimed by someone else (or freed by `gc`). | Treat the slot as gone. Do not retry. The skill removes the entry from `.syntaur/context.json` anyway. |
| `StaleLeaseError` on `extend` | Same as above, plus the explicit "member generation advanced" case. | Re-claim if you still need a resource. |
| `MemberInUseError` on `retire` | You're trying to retire a currently-leased member. | Release the lease first, then retire. |
| Database file missing or unreadable | `~/.syntaur/syntaur.db` not present or permissioned out. | `syntaur doctor` and check directory perms. |

## Known limits

- **Single host.** SQLite is local-file. There is no cross-machine coordination in v1. Two laptops cannot share an inventory.
- **`claim --wait` is bounded, not unbounded.** Polling with backoff (100ms → 200ms → 400ms → 800ms → 1s cap) until the budget expires. Long-running blocking patterns still want application-level orchestration on top.
- **`gc` is unscheduled.** Nothing runs `gc` for you. Either run it on a cron, accept that the opportunistic sweep inside `claim` handles hot inventories, or use `revoke` / the dashboard for one-off cleanups.
- **5s `busy_timeout` is global.** Long-running transactions in another part of Syntaur (or another process holding the DB) can push leases ops over the threshold.
