# Data model + lifecycle

The leases feature owns four SQLite tables inside `~/.syntaur/syntaur.db`. It shares the database file with `session-db.ts` and `proof-db.ts`; each module owns a row in the shared `meta` table for its schema version and creates `meta` with `IF NOT EXISTS` so init order is irrelevant.

## Tables

### `inventories`

```sql
CREATE TABLE inventories (
  slug          TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  display_name  TEXT,
  default_ttl_s INTEGER NOT NULL CHECK (default_ttl_s > 0),
  created_at    TEXT NOT NULL
);
```

`slug` is the user-facing handle (`dev-envs`, `prod-migration-lock`). `kind` is an opaque label used only for grouping in the dashboard.

### `inventory_members`

```sql
CREATE TABLE inventory_members (
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
CREATE INDEX idx_members_idle
  ON inventory_members (inventory_slug, status, last_used_at);
```

- **`status`** — `idle` (claimable), `leased` (currently held), `retired` (permanently removed).
- **`generation`** — monotonically increases every time the member transitions out of `leased`. This is the CAS counter that keeps stale lease tokens from freeing a re-claimed slot. See [concurrency](./concurrency.md).
- **`metadata_json`** — opaque key/value bag passed through to claim results. Don't put real secrets here; store a reference and resolve it on the claimant side.
- **`last_used_at`** — set every time the member is claimed. Used as the tiebreaker when picking which idle member to hand out (oldest-`last_used_at` first → round-robin without an explicit cursor).

### `leases`

```sql
CREATE TABLE leases (
  lease_id        TEXT PRIMARY KEY,         -- opaque UUIDv4
  inventory_slug  TEXT NOT NULL,
  member_id       TEXT NOT NULL,
  member_gen      INTEGER NOT NULL,         -- CAS snapshot taken at claim time
  state           TEXT NOT NULL
                    CHECK (state IN ('active','released','expired','revoked')),
  granted_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  released_at     TEXT,
  requested_for   TEXT,                     -- free-form tag from --for
  FOREIGN KEY (inventory_slug, member_id)
    REFERENCES inventory_members(inventory_slug, member_id)
);
CREATE INDEX idx_leases_gc ON leases (state, expires_at);
```

`lease_id` is a UUIDv4. It is **the only handle** that mutating ops accept — `release`, `extend`, `show`, `force-release` all key off `lease_id`. The `(inventory, member)` pair alone is not enough because a member's generation may have changed since you claimed it.

`member_gen` is captured at claim time and never updated. Mismatch between `leases.member_gen` and `inventory_members.generation` is the signal that the lease is stale (someone force-released or expired-and-reclaimed underneath you).

### `lease_events`

```sql
CREATE TABLE lease_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id     TEXT NOT NULL,
  event        TEXT NOT NULL,    -- 'claimed' | 'released' | 'expired' | 'force_released' | 'extended'
  at           TEXT NOT NULL,
  detail_json  TEXT,
  FOREIGN KEY (lease_id) REFERENCES leases(lease_id)
);
CREATE INDEX idx_events_lease ON lease_events (lease_id, at);
```

An append-only event log per lease. Read it with `syntaur lease history [<lease-id>] [--limit N] [--json]`. Events are written eagerly so the timeline goes back to install. Treat it as a forensic record, not a state source — state lives in the other three tables.

## State machines

### Member status

```
                        retire (CLI)
       ┌──────────────────────────────────┐
       │                                  ▼
   ┌───────┐  claim          ┌────────┐  retire (CLI)        ┌──────────┐
   │ idle  │ ───────────────▶│ leased │ ─── refused ──────▶  │ leased   │
   │       │◀── release      └────────┘   (MemberInUseError) └──────────┘
   │       │◀── expire (gc / opportunistic sweep)
   │       │◀── force_release
   └───────┘                                                  ┌──────────┐
       │                                                      │ retired  │
       └─────────────── retire (CLI) ───────────────────────▶ │ (frozen) │
                                                              └──────────┘
```

A member's `generation` increments on every transition out of `leased`. `retired` is terminal — you cannot un-retire a member; add a new member with a different id instead.

### Lease state

```
              ┌────────┐
              │ active │
              └───┬────┘
   release       │       force_release (admin)
   ┌─────────────┼─────────────┐
   │             │ expire (TTL)│
   ▼             ▼             ▼
┌──────────┐ ┌─────────┐ ┌─────────┐
│ released │ │ expired │ │ revoked │
└──────────┘ └─────────┘ └─────────┘
```

All three terminal states are equivalent from the **caller's** point of view (the lease is dead), but they encode different histories:

- **`released`** — the original holder called `release` cleanly; `released_at` records when.
- **`expired`** — the TTL elapsed and `gc` (or an opportunistic sweep during the next claim on the same inventory) reclaimed the member. `released_at` is also set here once the member has been freed (idempotent sentinel — see below).
- **`revoked`** — someone called `forceReleaseLease()` (dashboard force-release button, or future `syntaur lease revoke` CLI). Member generation is bumped and the previous holder will get a stale-lease error on its next `release` / `extend`.

There is no `released → active` transition. Once dead, the lease is dead. A new claim creates a new `lease_id`.

## The two-step expire pattern

Look at `claimLease()` and you'll notice the opportunistic sweep is split into three SQL statements before the actual pick:

1. `UPDATE leases SET state = 'expired' WHERE state = 'active' AND expires_at <= now AND inventory_slug = ?`
2. `UPDATE inventory_members SET status = 'idle', generation = generation + 1 WHERE …` (CAS on the matching expired lease)
3. `UPDATE leases SET released_at = now WHERE state = 'expired' AND released_at IS NULL AND inventory_slug = ?`

Step 3's `released_at IS NULL` is the **idempotent sentinel**. It means a concurrent claim arriving moments later won't try to free the same member twice — the member's generation has already advanced, and the lease row's `released_at` is non-null, so the WHERE clause filters it out. The same property makes `gc` safe to run alongside `claim`.

## Timestamps

Every timestamp is `new Date().toISOString()` — canonical UTC, lexicographic-safe for SQL `<=`. The CLI never accepts user-supplied timestamps. **A future caller writing a non-canonical timestamp would silently misorder `<=` checks** and break TTL-based expiry. This is the single most load-bearing invariant in the module; if you ever add a public API that inserts into these tables, route the timestamp through `nowIso()`.
