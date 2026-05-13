# Recipes

Common shapes for the leases primitive. Each recipe is "what to type" plus the failure modes you should expect.

---

## Recipe: dev environment pool for parallel agents

The motivating use case. Three pre-warmed sandboxes; up to three agents working in parallel; nobody steps on anyone else.

### Setup (once)

```bash
syntaur lease create-inventory dev-envs \
  --kind dev-env \
  --default-ttl 1h \
  --display-name "Pre-warmed dev environments"

syntaur lease member add dev-envs box-1 \
  -m url=https://box-1.dev.internal \
  -m ssh="ssh dev@box-1.dev.internal"

syntaur lease member add dev-envs box-2 \
  -m url=https://box-2.dev.internal \
  -m ssh="ssh dev@box-2.dev.internal"

syntaur lease member add dev-envs box-3 \
  -m url=https://box-3.dev.internal \
  -m ssh="ssh dev@box-3.dev.internal"
```

### Per-agent use

In each agent session:

```
/claim-resource dev-envs --ttl 30m
```

The skill writes the claimed lease into `.syntaur/context.json`. When done:

```
/release-resource --all
```

### Failure modes

- **Three agents, four want envs.** The fourth gets `no idle members in 'dev-envs'`. Either pass `claim --wait <duration>` for a bounded poll, retry the claim from the agent on a longer cadence, or add a fourth box.
- **Agent crashes mid-session.** The lease TTL kicks in (1h here). Either schedule `syntaur lease gc` on a 5-minute cron, or trust that the next claim will run the opportunistic sweep. `syntaur lease revoke <id>` (CLI) and the dashboard's force-release are the human escape hatches. For a known requester tag, `syntaur lease release-all --for <tag>` reclaims everything that crash held.

---

## Recipe: named lock (capacity-1 inventory)

A migration window, a deploy gate, anywhere you want "only one of these running at a time" across processes.

```bash
syntaur lease create-inventory prod-migration-lock \
  --kind lock \
  --default-ttl 10m

syntaur lease member add prod-migration-lock the-lock
```

To take the lock:

```bash
LEASE_JSON=$(syntaur lease claim prod-migration-lock --ttl 30m --for "migration-$(date +%s)" --json)
LEASE_ID=$(echo "$LEASE_JSON" | jq -r .lease_id)

trap 'syntaur lease release "$LEASE_ID" || true' EXIT

# ... do the migration ...
```

Fail-fast on contention is usually right for locks — if someone else holds the migration window, you do NOT want to silently wait two hours. Crash, page the human.

For "wait a bit then give up", wrap it:

```bash
for i in 1 2 3 4 5; do
  if LEASE=$(syntaur lease claim prod-migration-lock --ttl 30m --json 2>/dev/null); then
    break
  fi
  sleep 30
done
[ -z "$LEASE" ] && { echo "lock unavailable after 2.5min"; exit 1; }
```

---

## Recipe: test database pool with recycling

You have N throwaway databases. Tests claim one, run, release. Between leases, the database is wiped clean by your recycler script. Syntaur does NOT provide the recycler in v1 — you wire it up yourself.

### Setup

```bash
syntaur lease create-inventory test-dbs --kind db --default-ttl 20m

syntaur lease member add test-dbs db-1 -m dsn="postgres://test@db-1/test"
syntaur lease member add test-dbs db-2 -m dsn="postgres://test@db-2/test"
syntaur lease member add test-dbs db-3 -m dsn="postgres://test@db-3/test"
```

### Inside the test harness

```bash
LEASE=$(syntaur lease claim test-dbs --json)
DSN=$(echo "$LEASE" | jq -r .metadata.dsn)
LEASE_ID=$(echo "$LEASE" | jq -r .lease_id)

trap '
  ./scripts/wipe-test-db.sh "$DSN" || true
  syntaur lease release "$LEASE_ID" || true
' EXIT

pytest --dsn "$DSN"
```

Notice the recycler (`wipe-test-db.sh`) runs **before** the release. That way the next claimant gets a clean DB even if your test ran trash into it. If your wipe is slow or unreliable, do it on `claim` instead — but then accept that an aborted previous run leaves the DB in whatever state the trap couldn't fix.

---

## Recipe: rate-limited API key rotation

You have K vendor API keys, each rate-limited individually. M concurrent jobs want a key each; you want exactly one job per key at a time.

```bash
syntaur lease create-inventory vendor-keys --kind api-key --default-ttl 5m

# Store a reference; not the key itself.
syntaur lease member add vendor-keys key-a -m secret_ref="vault://prod/vendor/key-a"
syntaur lease member add vendor-keys key-b -m secret_ref="vault://prod/vendor/key-b"
```

The job claims a `secret_ref` and resolves the actual key from your secret store. The lease primitive never touches the secret material.

Keep TTLs **shorter than your vendor's rate limit window**. If the vendor enforces 60 req/min/key, a 5m lease lets one job soak that key for 5 minutes; that may be fine or may starve other callers. Tune to your workload.

---

## Recipe: extending a long-running claim

Your job legitimately needs longer than the inventory's default TTL. Two options:

**A. Claim with a longer `--ttl` up front.** Best if you know the duration.

```bash
syntaur lease claim dev-envs --ttl 4h --json
```

**B. Extend periodically.** Best if you don't know the duration.

```bash
LEASE_ID=…
# every 5 minutes, push out by 10 more:
while job_still_running; do
  syntaur lease extend "$LEASE_ID" --ttl 10m
  sleep 300
done
```

Caveat on B: if the job hangs and stops extending, the TTL eventually expires and another claimant takes the slot. That's the design — extension is a heartbeat, not a permanent escape.

---

## Recipe: scheduled GC

Nothing runs `gc` for you. The opportunistic sweep inside `claim` covers hot inventories, but cold ones can accumulate expired leases that look "leased" on the dashboard until someone claims.

User-level cron entry:

```cron
*/5 * * * * /usr/local/bin/syntaur lease gc >> ~/.syntaur/logs/gc.log 2>&1
```

`gc` is idempotent, concurrency-safe, and cheap — running it every minute is fine. Pick a frequency based on how stale your dashboard view can be.

---

## Anti-patterns

- **Don't put secrets in `--metadata`.** It's plaintext in SQLite. Store a `secret_ref` and resolve on the claimant side.
- **Don't use a lease as a long-lived flag.** Lease state is for "currently holding a thing", not "this feature is enabled". TTLs always tick.
- **Don't re-implement claim in your own code by SELECTing idle members and UPDATEing them yourself.** You will get the CAS wrong. Use the CLI.
- **Don't share `lease_id`s across security boundaries.** They are bearer tokens — anyone with the id can `release` or `extend`. v1 has no per-lease ACL.
- **Don't expect SessionEnd auto-release.** It doesn't exist in v1. Releases are explicit or TTL-driven.
