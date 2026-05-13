# Resource Leases — Overview

A coordination primitive for sharing finite resources across parallel agents (or humans, or scripts). Two agents racing for the one dev environment, the one test database, the one prod-migration window — leases let them queue cleanly instead of stomping.

## Mental model

You register an **inventory** of pre-existing members. A **member** is the actual thing being shared — a dev box, a test DB row, an API key, a slot. To use one, a caller asks the inventory to **claim** a member; the inventory atomically picks an idle member and hands back an opaque **lease** with a TTL. When the caller is done, it **releases** the lease (or lets the TTL expire and **gc** reclaim it).

```
inventory (slug, kind, default_ttl)
  ├── member (id, status: idle|leased|retired, metadata)
  ├── member …
  └── lease (lease_id, member_id, state: active|released|expired|revoked, expires_at)
```

The lease is what's durable. The member is the resource. **Members are pre-registered by you** — Syntaur does not provision them in v1.

## When to use leases

Use a lease when **all four** of the following are true:

1. There is a **finite pool** of identical-ish resources (1+ members).
2. Concurrent callers **shouldn't share** the same member at the same time.
3. The cost of someone holding a stale claim is bounded by a **TTL** you can name.
4. You can pre-register the members yourself (URLs, IPs, secret refs — anything).

Classic fits:

- **Dev environment pool** — N pre-warmed sandboxes, M parallel agents.
- **Test database pool** — one DB per test job, recycled between leases by your script.
- **Named locks** — one-member inventory acts as a mutex (migration windows, deploy gates).
- **Rate-limited credentials** — one API key per concurrent caller.

## When NOT to use leases

- **Pure observation.** If nothing claims and releases, you want [tracked servers](../../README.md), not leases.
- **Distributed across hosts.** SQLite is single-host; the leases DB lives in `~/.syntaur/syntaur.db`. Same machine only in v1.
- **Continuous quotas.** Leases are capacity-1-per-member. For semaphore-style "5 callers can share this", use something else.
- **Auto-provisioning.** Nothing spins up missing members. If you need that, build a provisioner script that calls `lease member add` and then a recycler that runs on release.

## v1 scope

In:

- Static inventories — you register members.
- Atomic claim with opaque lease tokens, plus `claim --wait <duration>` for callers that want a bounded poll.
- CAS-guarded release/extend (a stale token can't free someone else's slot).
- TTL-driven expiry + idempotent `gc`.
- Administrative `revoke` (CLI + dashboard) and bulk `release-all --for <tag>`.
- Inventory update / delete (cascade) and pure `member list` roster.
- `history` reads the `lease_events` log.
- Dashboard Inventories page (read + force-release).
- Four skills: `claim-resource`, `release-resource`, `extend-resource`, `list-resources`.

Out (deferred to v2+):

- Automatic provisioning / recycling adapters.
- Cross-host coordination.
- Healthchecks on members beyond TTL expiry.
- Jobs primitive for durable async work.
- Plugin manifest system / pool config layer.
- SessionEnd auto-release (TTLs are the only correctness anchor in v1).
- Continuous-capacity quotas / semaphore-style primitives.

## See also

- [CLI reference](./cli-reference.md)
- [Skills](./skills.md)
- [Data model + lifecycle](./data-model.md)
- [Concurrency + correctness](./concurrency.md)
- [Recipes](./recipes.md)
