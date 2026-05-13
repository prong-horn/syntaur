# `syntaur lease` — CLI reference

Every subcommand of `syntaur lease`. Run `syntaur lease --help` for the live list.

All commands open `~/.syntaur/syntaur.db` (WAL mode, 5s busy timeout) and exit non-zero on error with a single-line `Error: <message>` on stderr.

**Duration format** — wherever a flag takes a duration (`--ttl`, `--default-ttl`), values are `<n>[s|m|h|d]`. Bare numbers are seconds. Examples: `30s`, `5m`, `2h`, `1d`.

---

## `syntaur lease create-inventory <slug>`

Create a new inventory of leaseable resources.

```
syntaur lease create-inventory <slug>
  --kind <kind>
  [--display-name <text>]
  [--default-ttl <duration>]    # default: 30m
```

- `<slug>` — unique inventory id (e.g. `dev-envs`, `prod-migration-lock`).
- `--kind` — free-form label (e.g. `dev-env`, `db-instance`, `lock`). Used only for grouping in the dashboard; Syntaur does not interpret it.
- `--default-ttl` — used by `claim` when the caller doesn't pass `--ttl`.

**Exits non-zero** if the slug already exists (`DuplicateInventoryError`).

---

## `syntaur lease member add <inventory> <member-id>`

Register a member of an inventory.

```
syntaur lease member add <inventory> <member-id>
  [-m, --metadata key=value]...
```

`--metadata` is repeatable. Keys and values are opaque strings — Syntaur passes them through to claim results so the claimant has whatever it needs (URL, ssh string, secret ref). Don't put real secrets in here; store a reference and resolve it on the claimant's side.

```
syntaur lease member add dev-envs box-1 \
  -m url=https://box-1.example.test \
  -m region=us-west-2
```

**Exits non-zero** if `(inventory, member-id)` already exists (`DuplicateMemberError`).

---

## `syntaur lease member retire <inventory> <member-id>`

Mark a member as `retired`. Retired members can never be claimed again.

**Exits non-zero with `MemberInUseError`** if the member is currently leased — release the lease first. Retiring is intentionally a one-way trapdoor for "this box died" / "this slot is permanently gone". To make a retired slot claimable again, add a new member with a different id.

---

## `syntaur lease claim <inventory>`

Atomically claim an idle member.

```
syntaur lease claim <inventory>
  [--ttl <duration>]      # default: inventory's default_ttl
  [--for <tag>]           # free-form requester label (assignment slug, session id, …)
  [--wait <duration>]     # block up to <duration> for an idle member (backoff: 100ms → 200ms → 400ms → 800ms → 1s cap)
  [--json]                # JSON stdout instead of a one-line summary
```

On success (exit 0), stdout is either:

- One line: `Claimed <member_id> as <lease_id> (expires <iso-timestamp>)`
- Or, with `--json`:
  ```json
  {
    "lease_id":   "cf3bd0a6-…",
    "inventory_slug": "dev-envs",
    "member_id":  "box-2",
    "member_gen": 7,
    "granted_at": "2026-05-12T18:04:11.221Z",
    "expires_at": "2026-05-12T18:34:11.221Z",
    "metadata":   { "url": "https://box-2.example.test" }
  }
  ```

**Fail-fast by default.** Without `--wait`, exits 1 with `Error: no idle members in '<slug>'` when the pool is exhausted. With `--wait <duration>`, polls with the backoff schedule above until a slot frees or the budget runs out (then exits 1 with `Error: timed out waiting …`).

**Possible errors:**

| Exit | Cause | Recovery |
|---|---|---|
| `inventory '<slug>' not found` | typo or inventory doesn't exist | `syntaur lease list` to see what's defined. |
| `no idle members in '<slug>'` | pool exhausted | Wait, retry, or add capacity. |
| `contention timeout on '<slug>'; retry` | SQLite `SQLITE_BUSY` for >5s — heavy concurrency | Retry once after ~1s. If it persists, something is holding a write lock. |

---

## `syntaur lease release <lease-id>`

Release a lease by its opaque id. The slot becomes idle again for the next claimant.

**CAS-guarded** — if your lease has already expired, been revoked, or been released, you get `Error: lease <id> is no longer active (expired or revoked)` and exit 1. This is the right outcome: someone else may already hold the slot, and a stale release must not free their claim. See [concurrency](./concurrency.md).

`release` is idempotent per-lease — repeated calls on the same `lease_id` after the first all return the stale-lease error.

---

## `syntaur lease release-all --for <tag>`

Release every `active` lease whose `requested_for` matches `<tag>`. Useful for cleaning up after a crashed agent or batch.

```
syntaur lease release-all --for <tag>
  [--json]
```

Output: `released <n> lease(s) for tag "<tag>" (<m> stale skipped)` — or `{"released": <n>, "stale": <m>}` with `--json`.

Stale leases (those that went out from under us between the SELECT and the per-row release) are tallied and swallowed, not surfaced as errors — the call is a best-effort sweep.

---

## `syntaur lease revoke <lease-id>`

Force-release a lease (administrative escape hatch). Bumps the bound member's generation if the lease is still the holder, so the previous claimant gets `StaleLeaseError` on its next `release` / `extend`.

```
syntaur lease revoke <lease-id>
```

**Idempotent.** Revoking an already-revoked lease prints `already revoked <lease-id>` and exits 0. Unknown lease ids exit 1 with `Error: lease <id> not found`.

This is the CLI mirror of the dashboard's `POST /api/leases/:slug/force-release/:lease_id` route — both call the same `forceReleaseLease()` function.

---

## `syntaur lease extend <lease-id> --ttl <duration>`

Push out a lease's `expires_at`. The new `expires_at` is `now + ttl` (it is not additive to the old one).

```
syntaur lease extend cf3bd0a6-… --ttl 15m
```

**Refuses** with `StaleLeaseError` if the lease is not in `state = 'active'` or if the member's `generation` has advanced (i.e., someone force-released it underneath you). Extending an expired lease is forbidden — release and re-claim instead.

---

## `syntaur lease show <lease-id>`

Print a single lease row as JSON.

```json
{
  "lease_id": "cf3bd0a6-…",
  "inventory_slug": "dev-envs",
  "member_id": "box-2",
  "member_gen": 7,
  "state": "active",
  "granted_at": "2026-05-12T18:04:11.221Z",
  "expires_at": "2026-05-12T18:34:11.221Z",
  "released_at": null,
  "requested_for": "resource-leases-primitive"
}
```

Exits 1 if the lease id is unknown.

---

## `syntaur lease history [<lease-id>]`

Read the `lease_events` log.

```
syntaur lease history [<lease-id>]
  [--limit <n>]           # default 50
  [--json]
```

- With `<lease-id>`: print that lease's full event timeline in chronological order (oldest first).
- Without: print the most recent `<limit>` events across all leases in reverse-chronological order (newest first).

Text output is one event per line: `<at>  <event>  <lease_id>  <detail-json>`. `--json` emits the raw rows.

Events written today: `claimed`, `released`, `extended`, `force_released`.

---

## `syntaur lease inventory delete <slug>`

Delete an inventory and cascade-remove its members, leases, and lease_events.

```
syntaur lease inventory delete <slug>
  [--force]
```

**Without `--force`:** refuses if any lease in the inventory is `active`, exiting 1 with `Error: inventory "<slug>" has active leases — use --force to revoke and delete`.

**With `--force`:** `revoke`s every active lease first (each revocation lands in `lease_events`), then deletes everything in a single FK-safe cascade transaction: events → leases → members → inventory row. Output: `deleted "<slug>" (revoked <n> active lease(s))`.

Unknown slug → exit 1 with `Error: inventory '<slug>' not found`.

---

## `syntaur lease inventory update <slug>`

Patch mutable fields on an existing inventory.

```
syntaur lease inventory update <slug>
  [--default-ttl <duration>]
  [--display-name <text>]
```

At least one flag is required. `kind` is **immutable in v1** — there is no flag for it and the DB layer rejects any caller trying to sneak it through. To change kind, delete and recreate.

---

## `syntaur lease member list <inventory>`

Pure member roster — separate from the mixed inventory+leases output of bare `syntaur lease list`.

```
syntaur lease member list <inventory>
  [--json]
```

Text output: `<member_id>  <status>  gen=<n>  last_used=<iso>  <metadata-json>`. `--json` emits raw rows. Status is `idle | leased | retired`.

---

## `syntaur lease list`

List leases — and, when called with no filters, a friendly per-inventory overview.

```
syntaur lease list                            # inventory overview
syntaur lease list --inventory dev-envs       # leases in one inventory
syntaur lease list --state active             # all currently-active leases
syntaur lease list --inventory dev-envs --state expired --json
```

Filters:

- `--inventory <slug>` — restrict to one inventory.
- `--state <state>` — one of `active`, `expired`, `released`, `revoked`.
- `--json` — JSON array instead of the human table.

Bare `syntaur lease list` (no flags, no `--json`) prints one line per inventory with idle/leased counts and active-lease count — meant as the "what's going on?" entry point.

---

## `syntaur lease gc`

Sweep expired leases across all inventories. Idempotent and concurrency-safe — multiple callers running `gc` simultaneously will not double-free or corrupt state.

```
syntaur lease gc
# Expired 3 lease(s).
```

`gc` is what guarantees that a crashed agent doesn't permanently hold a member. Run it on a schedule (cron, systemd timer, or as a step in your own coordination loop) — or accept that the next `claim` against an inventory with no idle members will sit there failing until the dashboard or another caller triggers a sweep. The dashboard's force-release calls into the same code path for one specific lease.

---

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Any error — message on stderr |

There are no other distinguishing exit codes in v1. Scripts that need to react differently to `NoIdleMember` vs `LeaseContention` vs `NotFound` should parse the stderr message or use `--json` paths where available.

---

## What's NOT in the CLI today

Still v2+:

- **Provisioning adapter** — `provision` callback for inventories that grow on demand.
- **Recycle adapter** — `recycle` callback between leases.
- **Healthcheck adapter** — beyond TTL expiry.
- **SessionEnd auto-release** — leases held by an exited Claude Code / Codex session are not reclaimed automatically; they fall off via TTL.
- **Cross-machine distributed coordination** — single SQLite file is the source of truth.
- **Continuous-capacity quotas / semaphore-style primitives.**
- **Per-lease ACL** — `lease_id` is still a bearer token in v1.
