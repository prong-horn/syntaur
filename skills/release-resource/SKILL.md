---
name: release-resource
description: Release a Syntaur resource lease previously claimed via /claim-resource, freeing the member for the next claimant. Triggers on "/release-resource", "release this dev env", "drop the lease", "release my slot", "release all leases", or when the user is done with a claimed resource.
license: MIT
---

# Release Resource

Release one or more active resource leases, removing them from `.syntaur/context.json` and freeing their members for the next claimant.

## Usage

User arguments: `$ARGUMENTS`

- `<lease_id>` — release a specific lease by id
- `--all` — release every active lease recorded in `.syntaur/context.json`

Examples:
- `/release-resource cf3bd0a6-ba38-4a8c-a882-bdba9cabad80`
- `/release-resource --all`

## Workflow

### Step 1: Parse arguments

If `--all` is passed, build the list of `lease_id`s from `.syntaur/context.json`'s `leases: []` array. Otherwise the first positional argument is the single `lease_id` to release.

If there is no `lease_id` and `--all` was not passed, abort with: "Specify `<lease_id>` or use `--all`. Active leases: $(jq -r '.leases[]?.lease_id' .syntaur/context.json 2>/dev/null || echo 'none')."

### Step 2: Release each lease

For each `lease_id`:

```bash
syntaur lease release "$LEASE_ID"
```

(Use `dangerouslyDisableSandbox: true` since the CLI writes to `~/.syntaur/syntaur.db`.)

Outcomes:

| Result | Meaning | What to do |
|---|---|---|
| Exit 0 with `Released lease <id>.` | Normal release. | Continue. |
| Exit 1 with `lease ... is no longer active` | Stale lease (already expired/revoked). The slot has already been freed. | Still remove from `.syntaur/context.json` — the row is dead either way. Note the staleness in the final summary. |
| Exit 1 with `contention timeout; retry` | `LeaseContentionError`. | Retry once after ~1s; if it fails again, surface to the user. |

### Step 3: Remove the entry from `.syntaur/context.json`

Whether the CLI succeeded OR returned a stale-lease error, drop the matching record from `.syntaur/context.json` (stale leases are dead — keeping them in context is misleading):

```bash
jq --arg lid "$LEASE_ID" \
   '.leases = ((.leases // []) | map(select(.lease_id != $lid)))' \
  .syntaur/context.json > .syntaur/context.json.tmp \
  && mv .syntaur/context.json.tmp .syntaur/context.json
```

### Step 4: Report back

For a single release: `Released <lease_id> (<inventory>/<member_id>).` or `Lease <id> was already stale; removed from context.`

For `--all`: print one line per lease, then a summary count: `Released N lease(s), M already stale.`

If no leases were recorded in context, say so explicitly.
