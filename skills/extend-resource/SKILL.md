---
name: extend-resource
description: Extend the TTL on a Syntaur resource lease previously claimed via /claim-resource. Triggers on "/extend-resource", "extend my lease", "renew the lease", "bump the TTL", "keep this resource a bit longer", or when the user wants more time on an active claim.
license: MIT
---

# Extend Resource

Extend an active Syntaur resource lease by pushing its `expires_at` forward. On success, also updates the lease's `expires_at` in `.syntaur/context.json` so the local record stays accurate. If the lease has already gone stale (expired, revoked, or member generation advanced), drops it from `.syntaur/context.json` and reports.

## Usage

User arguments: `$ARGUMENTS`

- `<lease_id>` (required) — lease to extend
- `--ttl <duration>` (required) — new TTL from now (e.g. `15m`, `2h`)

Examples:
- `/extend-resource cf3bd0a6-ba38-4a8c-a882-bdba9cabad80 --ttl 1h`
- `/extend-resource 6d4a... --ttl 30m`

## Workflow

### Step 1: Parse arguments

Extract `<lease_id>` (first positional) and `--ttl <duration>` (required). If either is missing, abort with a usage message and a hint to call `/list-resources` to see active leases.

### Step 2: Pre-check workspace context

Read `.syntaur/context.json` (a workspace marker) from the current working directory. If the file is missing, OR carries no workspace markers (`repository`/`branch`/`worktreePath`/`workspaceRoot`) and no `sessionId`, abort with:

> "No active Syntaur context in this workspace. Grab an assignment first (`/grab-assignment <project> <slug>`) or restart the session so the SessionStart hook can populate `.syntaur/context.json`."

This guard mirrors `/claim-resource` and `/release-resource` — writing a leases-only context file would trip `syntaur doctor`'s workspace check.

### Step 3: Run the extend CLI

```bash
syntaur lease extend "$LEASE_ID" --ttl "$TTL"
```

(Use `dangerouslyDisableSandbox: true` — the CLI writes to `~/.syntaur/syntaur.db`.)

Possible non-zero exits and how to surface them:

| stderr fragment | meaning | how to respond |
|---|---|---|
| `cannot be extended (expired, revoked, or member generation advanced)` | `StaleLeaseError` — lease is no longer the holder. | Drop the entry from `.syntaur/context.json` (Step 5) and tell user the lease is dead — they'll need to `/claim-resource` again. |
| `contention timeout; retry` | `LeaseContentionError` — busy timeout. | Retry once after ~1s. If it fails again, surface to user. |
| `--ttl must be positive` | Bad duration. | Tell user to pass a positive duration like `15m`, `2h`. |

### Step 4: Parse the new expiry from stdout

On exit 0, stdout looks like: `Extended lease <id> (new expires_at=<iso>).`

Capture the `new_expires_at` value (the ISO timestamp inside the parens).

### Step 5a: On success, update `.syntaur/context.json`

Find the matching entry in `leases[]` by `lease_id` and rewrite its `expires_at`:

```bash
jq --arg lid "$LEASE_ID" --arg exp "$NEW_EXPIRES_AT" \
   '.leases = ((.leases // []) | map(
      if .lease_id == $lid then .expires_at = $exp else . end
    ))' \
  .syntaur/context.json > .syntaur/context.json.tmp \
  && mv .syntaur/context.json.tmp .syntaur/context.json
```

### Step 5b: On `StaleLeaseError`, drop the entry instead

```bash
jq --arg lid "$LEASE_ID" \
   '.leases = ((.leases // []) | map(select(.lease_id != $lid)))' \
  .syntaur/context.json > .syntaur/context.json.tmp \
  && mv .syntaur/context.json.tmp .syntaur/context.json
```

### Step 6: Report back

- On success: `Extended <lease_id> — new expires_at=<iso>.` Also surface the original member id (look it up in the context entry before mutation) so the user knows which resource was extended.
- On stale: `Lease <lease_id> is no longer active — removed from context. Run /claim-resource to grab a new one.`
