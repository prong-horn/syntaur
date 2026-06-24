---
name: claim-resource
description: Claim an idle member of a Syntaur leases inventory (dev env, test DB, API key, named lock, etc.) for the current assignment session. Triggers on "/claim-resource", "claim a dev env", "lease an environment", "grab a test DB", "claim a slot", or when the user wants to coordinate access to a shared finite resource.
license: MIT
---

# Claim Resource

Claim an idle member of a Syntaur leases inventory and persist the lease into `.syntaur/context.json`. The claimed member's connection metadata (URL, ssh string, port, etc.) is printed back so the agent can use it immediately.

The claim is **fail-fast** — if no member is idle, the command exits non-zero. If a long-running blocking claim is wanted, the agent retries externally with backoff.

## Usage

User arguments: `$ARGUMENTS`

- `<inventory_slug>` (required) — which inventory to claim from
- `--ttl <duration>` (optional) — lease TTL, e.g. `15m`, `2h`. Defaults to the inventory's `default_ttl`.
- `--for <tag>` (optional) — free-form requester tag (defaults to the active assignment slug if omitted)

Examples:
- `/claim-resource dev-envs`
- `/claim-resource dev-envs --ttl 1h`
- `/claim-resource prod-migration-lock --ttl 5m --for "migration-2026-05-12"`

## Workflow

### Step 1: Parse arguments

Extract `<inventory_slug>` (required, first positional), plus optional `--ttl <duration>` and `--for <tag>`.

### Step 2: Pre-check workspace context

Read `.syntaur/context.json` (a workspace marker) from the current working directory. If the file is missing, OR carries no workspace markers (`repository`/`branch`/`worktreePath`/`workspaceRoot`) and no `sessionId`, abort with:

> "No active Syntaur context in this workspace. Grab an assignment first (`/grab-assignment <project> <slug>`) or restart the session so the SessionStart hook can populate `.syntaur/context.json`."

This guard exists because writing a leases-only context file would trip `syntaur doctor`'s workspace check.

If `--for` was not provided, derive its value: prefer the active assignment's slug from the session's open engagement (`syntaur session resume --json`); otherwise fall back to the `sessionId` from the workspace marker.

### Step 3: Run the claim CLI

```bash
syntaur lease claim "$INVENTORY_SLUG" --json \
  ${TTL:+--ttl "$TTL"} \
  --for "$TAG"
```

(Use `dangerouslyDisableSandbox: true` for the Bash call — the CLI writes to `~/.syntaur/syntaur.db`.)

Possible non-zero exits and how to surface them to the user:

| stderr fragment | meaning | how to respond |
|---|---|---|
| `no idle members in '<slug>'` | `NoIdleMemberError` — pool exhausted | Tell user; suggest waiting / retrying later or asking a human to add capacity. |
| `contention timeout on '<slug>'; retry` | `LeaseContentionError` — busy timeout | Retry once after ~1s. If it fails again, surface the error. |
| `inventory '<slug>' not found` | typo or inventory doesn't exist | Tell user; list with `syntaur lease list`. |

### Step 4: Parse the claim result

Parse the stdout JSON: `{ lease_id, inventory_slug, member_id, member_gen, granted_at, expires_at, metadata }`.

### Step 5: Persist the lease in `.syntaur/context.json`

Append the lease record to the `leases: []` array in `.syntaur/context.json` (creating the array if absent). Atomic write via `jq` + rename:

```bash
mkdir -p .syntaur
jq --arg lid "$LEASE_ID" \
   --arg slug "$INVENTORY_SLUG" \
   --arg mid "$MEMBER_ID" \
   --arg exp "$EXPIRES_AT" \
   --arg claimed "$GRANTED_AT" \
   --argjson meta "$METADATA_JSON" \
   '.leases = ((.leases // []) | map(select(.lease_id != $lid)) +
    [{ lease_id: $lid, inventory_slug: $slug, member_id: $mid,
       expires_at: $exp, metadata: $meta, claimed_at: $claimed }])' \
  .syntaur/context.json > .syntaur/context.json.tmp \
  && mv .syntaur/context.json.tmp .syntaur/context.json
```

### Step 6: Report back

Tell the user:
- Which member was claimed (`<inventory>/<member_id>`) and the lease id.
- When the lease expires (`expires_at`).
- The connection metadata, if any (URL, port, credentials reference, etc.) — print as a code block so the agent (or human) can use it.
- Reminder: leases do NOT auto-release on session end or assignment completion in v1. Call `/release-resource <lease_id>` when finished, or let the TTL expire and `gc` reclaim.
