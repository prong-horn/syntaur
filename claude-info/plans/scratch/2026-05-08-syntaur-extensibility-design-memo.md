# Syntaur extensibility — design memo (v2, post external review)

**Status:** exploratory sketch, revised after skeptical review by an external reviewer (codex).
**v1 → v2 changes:** the core primitive is no longer "pools" — it is **leases over a leaseable inventory**, with **jobs** as a separate durable async-work primitive. Pools are a thin construct on top of those two. v1 scope cut hard to static inventory + lease tokens + capacity-1 locks. Several factual and conceptual errors from v1 corrected.

## Context

Syntaur is a protocol + CLI for orchestrating AI coding agents across projects/assignments. Runtime state lives in `~/.syntaur/`: SQLite (`syntaur.db`, WAL mode, already shared between CLI and dashboard), plus filesystem trees for `projects/`, `assignments/`, `playbooks/`, `servers/`, `workspaces.json`.

Trigger for this memo: while dogfooding Syntaur at work, the user has multiple agents running in parallel on different tickets. Each needs to spin up a dev environment to test changes. Spin-up is slow, so they want a **pool of pre-warmed dev envs that agents can claim and release**. The user could build this as a custom integration in their work repo, but felt it might be a generic Syntaur primitive — and is asking where the line should sit between "core Syntaur" and "custom integration."

## Current Syntaur extension surfaces (grounded in the code)

- **Pluggable today:** playbooks (`~/.syntaur/playbooks/`, behavioral markdown), `config.md` (custom statuses/transitions/types), resources/memories (markdown content under projects).
- **Hardcoded today:** skills (`skills/<name>/SKILL.md`, declared in plugin.json), platform hooks (`platforms/claude-code/hooks/*.sh` etc., declared in each platform's manifest), platform adapters (TS-coded under `platforms/`, hardcoded list in `setup-adapter.ts`), dashboard panels (React/Vite app in `dashboard/`).
- **`externalIds` field on assignments:** rendered in `dashboard/src/pages/AssignmentDetail.tsx:372` and `statusline/statusline.sh:145`, but no integration *writes* to it — there is no Linear/Jira sync adapter yet.
- **Closest existing pattern to a leaseable inventory:** none, really. Tracked servers at `~/.syntaur/servers/` are a *read-only registry* of tmux sessions and ports. An observational registry is not adjacent in complexity to an allocative control plane; claim/release is the hard part.
- **No coordination primitives:** no locks, leases, queues, semaphores. Single-agent-per-cwd is enforced *by convention* via `.syntaur/context.json`, not by anything stronger.
- **SessionEnd is already an unreliable signal in Syntaur.** Cleanup is best-effort `curl` in `platforms/codex/scripts/session-cleanup.sh`. Hard crashes, laptop sleep, killed shells, and intentionally detached long-running work do not fire SessionEnd. **Anything that builds correctness on top of SessionEnd is repeating an existing weak point.**
- **No protocol-level event bus:** lifecycle transitions in `src/lifecycle/transitions.ts` are silent file I/O. The only existing hooks are at the agent-runtime layer (Claude Code, Codex), not the Syntaur protocol layer.

## Where the line should sit

Two formulations, the second is sharper:

- **First cut:** native = coordination (claim, sequence, queue, lock, lease, gate, notify, persist across sessions, expose to humans); integration = execution (provision, run tests, call cloud APIs, deploy).
- **Sharper cut from review:** **core owns durable protocol state that must be visible, auditable, and recoverable across sessions; integrations own provider-specific actuation.**

The sharper version makes the seam at the dev-env case more honest: a claim result can change *where the assignment runs* (its `workspace.repository/worktreePath/branch`), what the write boundary is, and what humans see in the dashboard. That seam crosses provisioning and the assignment model. So "how to `terraform apply` a fresh env" is external; "what the assignment's effective workspace becomes after the claim" is core.

## Sketch 1 — Leases (the actual core primitive)

What was called "pools" in v1 is two abstractions stacked together. Separating them:

- **Leaseable inventory** — a finite set of named members, exclusive claim with a lease token, release/extend/transfer via that token.
- **Provisioning controller** — a process that watches inventory and provisions/recycles/heals backing instances. Async, retries, idempotency. **Belongs on the jobs primitive (Sketch 2), not in the lease primitive.**

A "pool" is then: an inventory + (optionally) a provisioning controller + a thin CLI/skill surface. v1 ships *only* the inventory half.

### Schema

```sql
CREATE TABLE inventories (
  slug          TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,            -- 'dev-env','test-user','prod-migration-lock', etc.
  display_name  TEXT,
  capacity      INTEGER,                  -- null = static set; rows in inventory_members carry the truth
  default_ttl_s INTEGER NOT NULL,
  created_at    INTEGER
);

CREATE TABLE inventory_members (
  inventory_slug TEXT NOT NULL,
  member_id      TEXT NOT NULL,
  status         TEXT NOT NULL,           -- idle|leased|retired|broken
  generation     INTEGER NOT NULL DEFAULT 0,   -- bumped on every state change; underpins CAS
  metadata_json  TEXT,
  last_used_at   INTEGER,
  PRIMARY KEY (inventory_slug, member_id)
);

CREATE TABLE leases (
  lease_id        TEXT PRIMARY KEY,        -- opaque, generated on claim (e.g. UUIDv7)
  inventory_slug  TEXT NOT NULL,
  member_id       TEXT NOT NULL,
  member_gen      INTEGER NOT NULL,        -- generation of inventory_member at time of claim
  state           TEXT NOT NULL,           -- active|released|expired|revoked
  granted_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  released_at     INTEGER,
  -- metadata about *who requested it*, not correctness anchors
  requested_for   TEXT,                    -- 'session:abc' | 'assignment:foo/bar' | free string
  notify_targets  TEXT                     -- json: where to ping if revoked etc.
);

CREATE TABLE lease_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id TEXT, event TEXT, at INTEGER, detail_json TEXT
);
```

### Atomic claim (lease-aware)

```sql
BEGIN IMMEDIATE;
-- pick an idle member, fail fast if none
UPDATE inventory_members
   SET status='leased', generation=generation+1, last_used_at=?
 WHERE (inventory_slug, member_id) = (
   SELECT inventory_slug, member_id FROM inventory_members
    WHERE inventory_slug=? AND status='idle'
    ORDER BY last_used_at ASC NULLS FIRST
    LIMIT 1
 )
 RETURNING member_id, generation;

-- insert lease tied to that exact member generation
INSERT INTO leases (lease_id, inventory_slug, member_id, member_gen, state, ...)
VALUES (?, ?, ?, ?, 'active', ...);
COMMIT;
```

The lease is *bound* to a specific `member_gen`. Every subsequent operation is CAS-guarded.

### Mutations are CAS-guarded, lease-token in hand

```sql
-- release
UPDATE inventory_members SET status='idle', generation=generation+1
 WHERE inventory_slug=? AND member_id=?
   AND generation=(SELECT member_gen FROM leases WHERE lease_id=? AND state='active');
-- if 0 rows affected: lease was already expired/revoked; refuse, do not free the slot
```

This eliminates the v1 correctness bug: a stale releaser (slow callback, late SessionEnd hook, retried script) cannot free a member that was already reclaimed by someone else.

### CLI

```
syntaur lease create-inventory <slug> --kind=dev-env --default-ttl=30m
syntaur lease member add <slug> <id> [-m k=v]
syntaur lease member retire <slug> <id>
syntaur lease claim <slug> [--ttl=15m] [--wait[=Ns]] [--for=<tag>] [--json]
   # returns { lease_id, member_id, metadata, expires_at }
syntaur lease release  <lease_id>
syntaur lease extend   <lease_id> --ttl=15m
syntaur lease show     <lease_id>
syntaur lease list     [--inventory=<slug>] [--state=active|expired]
syntaur lease gc                     # mark expired; never silently re-frees a member
```

Every mutating subcommand takes the **lease token**, not the member id. `release <member_id>` doesn't exist.

### Holder identity is metadata, not a correctness anchor

`requested_for` (`session:<id>`, `assignment:<slug>`, free string) is metadata — useful for *notifying* and for human-readable dashboards. It is **not** used to drive auto-release. Specifically:

- SessionEnd does **not** auto-release. The session may have spawned a detached test that still needs the env; the SessionEnd hook is unreliable anyway.
- The lease's own `expires_at` is the only correctness anchor. Agents that want long-running claims set a long TTL and explicitly extend; agents that want short claims set short TTLs and the GC reclaims them honestly.
- Optional: a SessionEnd hook can **flag** active leases as "owner session ended" for the dashboard to surface, so a human can revoke if needed.

### Capacity-1 locks

A capacity-1 inventory with one member *is* a named lock once leases have tokens. Same storage, same CAS, same release semantics. The lock-specific UX (`syntaur lock acquire <name>` / `release`) is a skin over `lease claim/release`. Worth being explicit that the *abstraction is shared at the data layer*, not that locks and recyclable env pools have the same business logic — they don't. Lock-specific concerns (reentrancy, deadlock avoidance) layer on top without changing the substrate.

## Sketch 2 — Jobs (durable async work)

The thing v1 tried to hand-wave with "shell-script adapters and an optional event bus." External review correctly identified that provision, recycle, healthcheck, retry-broken, external sync, and notifier retries all want the same primitive: **durable, retriable, observable async work with idempotency and audit**. Raw events do not provide that.

### Schema

```sql
CREATE TABLE jobs (
  job_id        TEXT PRIMARY KEY,           -- UUIDv7
  kind          TEXT NOT NULL,              -- 'lease.provision','lease.recycle','linear.sync',...
  state         TEXT NOT NULL,              -- queued|running|succeeded|failed|cancelled
  payload_json  TEXT,
  result_json   TEXT,
  attempt       INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  next_run_at   INTEGER,
  dedupe_key    TEXT,                       -- nullable; UNIQUE to support exactly-once
  created_at    INTEGER, updated_at INTEGER,
  -- linkage
  inventory_slug TEXT, member_id TEXT, lease_id TEXT
);
CREATE UNIQUE INDEX jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE job_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT, attempt INTEGER,
  started_at INTEGER, finished_at INTEGER,
  exit_code INTEGER, stdout_path TEXT, stderr_path TEXT,
  error_class TEXT, error_message TEXT
);
```

### Handlers

Job handlers are registered by `kind`. v1 ships **two transports**:

1. **In-process TS handlers** for the kinds Syntaur itself owns (e.g., `lease.gc`, `lease.notify-owner-session-ended`).
2. **Subprocess handlers** for integration-supplied kinds. *But* — addressing the external review's point that plain stdin/stdout/exit-code is too flimsy for stateful work — the subprocess contract is:
   - Stdin: JSON envelope `{ job_id, attempt, payload, deadline_at, lease_token? }`
   - Stdout: JSON result on success: `{ status: "ok", result: {...} }`; explicit `{ status: "retry", reason, retry_after_s }` for transient failures.
   - Stderr: free-form logs, captured to `job_attempts.stderr_path`.
   - Timeout enforced by the runner; SIGTERM on deadline; second attempt picks up via the same `job_id`.
   - Adapter declares a **schema version** in its manifest; runner refuses mismatched versions instead of silently corrupting.

This is intentionally heavier than shell-hooks-as-callbacks. The point: provisioner work *is* stateful and partial-completion-prone; pretending otherwise is the bug v1 had.

### A runner

Single-host, single SQLite. Runner = a tiny background process started by the dashboard server (or `syntaur jobs run` for headless setups). Picks up `state='queued' AND next_run_at <= now` rows, runs them, writes results, requeues with backoff on retry.

### What this unlocks (besides pools)

- **External-ID sync** (Linear/Jira): scheduled `jobs` per assignment kind=`linear.sync`, with dedupe and retries.
- **Notifications** (Slack, push): kind=`notify.slack` with at-least-once + dedupe.
- **Long-running operations from skills**: a skill can enqueue a job and return immediately, with the agent or dashboard polling `job_id`.

Once jobs exist, the "event bus" idea collapses: lifecycle transitions just enqueue jobs of the appropriate kinds. No separate bus, no separate transport.

## Sketch 3 — Pools as a thin construct on top

A pool, in v2 vocabulary, is the *configuration* that ties an inventory together with a provisioning controller (implemented as jobs) plus a default lease TTL and CLI shorthands. Nothing in the pool layer is novel storage — it's a config row pointing at an inventory and a set of job-kinds.

```sql
CREATE TABLE pools (
  slug             TEXT PRIMARY KEY,
  inventory_slug   TEXT NOT NULL,
  provisioner_kind TEXT,                   -- nullable; static-only pools have no provisioner
  target_capacity  INTEGER,
  recycle_kind     TEXT,                   -- job kind to run between leases
  healthcheck_kind TEXT,                   -- periodic job kind
  config_json      TEXT
);
```

For v1, this table doesn't even exist — `syntaur lease create-inventory` is enough. Pools get introduced in v2 alongside jobs, *once we have the substrate that makes provisioner workflows safe.*

## Phasing (revised)

1. **v1: Leases over static inventory.** Schema for `inventories` / `inventory_members` / `leases` / `lease_events`. CLI `lease *`. Skills `claim-resource <inventory>` / `release-resource <lease_id>`. Dashboard "Inventories" tab. **No provisioner, no recycle, no GC of broken members, no SessionEnd auto-release.** Capacity-1 locks fall out as a thin UX skin. This ships the user's dev-env need provided they statically register their pre-warmed envs as inventory members. ~1 milestone, genuinely small.

2. **v2: Jobs + pools.** Schema for `jobs` / `job_attempts`. Runner integrated with the dashboard server. Subprocess job handler contract with schema versioning, timeouts, structured retry signaling. `pools` config layer + provisioner/recycle/healthcheck job kinds. *Now* you can describe a dev-env pool that elastically scales and recycles between leases. ~1–1.5 milestones.

3. **v3: Plugin manifest formalization.** Once `jobs` has lived long enough to know what its registration surface should be, and once at least one external-id-adapter has been built against it, formalize a plugin manifest aligned with **existing `plugin.json` files in the repo** (not a bespoke `plugin.md`). Surfaces: job kinds, lease inventory kinds, external-id adapters, CLI namespacing. **Defer dashboard-panel plugins** until trust/auth/sandboxing/routing have a real design — that surface area is not small.

## Reasonable use cases (pruned and caveated)

Static inventories + leases will fit:

- **Pre-warmed dev/preview environments.** (Original case. Static set, user pre-provisions, Syntaur coordinates claims.)
- **Test database instances** (static set of containers, recycled by an out-of-band script for now).
- **Browser/Playwright contexts** (static set).
- **API keys with rate limits** (static set; metadata holds the key, claim returns it via `--json`).
- **OAuth tokens with expiry** (TTL ≈ token lifetime).
- **Mobile emulators / simulators** (static set).
- **Device farm slots, lab equipment, USB dongles** (the physical-resource cases — pure static).
- **Capacity-1 named locks** for "only one agent migrates prod at a time" — collapses to a single-member inventory.

Use cases the design **does not currently fit well** and should be removed from the v1 sales pitch:

- **Free localhost ports.** A port is reserved when a process binds the socket, not when Syntaur hands out the number. Two agents racing on `3000` aren't fixed by leasing the integer.
- **Test user accounts** at face value. They *look* leaseable but real state leaks through email, webhook history, third-party systems. `recycle` is not a binary clean/dirty transition. Acceptable in v1 *only if* the user accepts that "cleanliness" of a returned member is the integration's problem.
- **GPU/build/CI runners** at v1 (no provisioner). Workable in v2.
- **Continuous-capacity quotas** (CPU, bandwidth, model RPM/TPM): want a semaphore primitive, not leases. Future work, separate design.
- **Cross-machine distributed locks.** SQLite is single-host. If two workstations need to share a prod-migration lock, the storage moves and the design changes.
- **Affinity-required claims** ("agent A always wants member 3"). Anti-leasing.
- **Strong fairness / priority / preemption.** Don't put queue scheduling theory in v1; FIFO is fine.

## Specific questions for any further reviewer

1. Is the **lease-with-token + jobs-for-async** split the right two primitives, or is there a single abstraction (e.g., "durable resource state machine") that swallows both without losing clarity?
2. The decision to **drop SessionEnd auto-release** is a UX regression vs. v1 — agents have to be deliberate about TTLs. Is the correctness gain worth the loss, or is there a hybrid (e.g., "soft owner advisory" surfaced in the dashboard, while leases remain TTL-anchored) worth designing?
3. The **subprocess job contract** is heavier than git-hooks-style shell scripts. Is that the right line, or do we want an in-process plugin SDK (TS) for adapters that need richer signaling, with subprocess as a fallback for language-agnostic work?
4. **Where exactly does a claim plug into `workspace.*` on the active assignment?** A claim that grants a dev env URL/branch arguably should mutate the assignment's effective workspace; otherwise we lose write-boundary integrity. This is a seam between the leasing layer and the assignment model that v2 does not yet specify.
5. **External-ID sync** (Linear/Jira) is the strongest v2-or-later candidate. Should it ship *with* jobs as the bootstrap adopter, or is it cleaner to ship jobs alone first and validate the abstraction against a second use case?
