---
name: list-resources
description: List the Syntaur resource leases held by the current session, plus the workspace-wide overview of inventories and active leases. Triggers on "/list-resources", "what leases do I have", "show my leases", "list my resources", "what resources am I holding", or when the user wants both a session-local and system-wide view of leased resources.
license: MIT
---

# List Resources

Print two views in one call:

1. **Your active leases** — the `leases[]` array from `.syntaur/context.json` (this session's claims).
2. **All active leases in this workspace** — output of `syntaur lease list`, which shows every inventory plus its idle/leased counts.

This is the cheap "what am I holding, and what's out there?" lookup before deciding to extend, release, or grab another resource.

## Usage

User arguments: `$ARGUMENTS` (no arguments accepted in v1).

Examples:
- `/list-resources`

## Workflow

### Step 1: Read this session's leases

```bash
jq -r '.leases // []' .syntaur/context.json 2>/dev/null
```

(No `dangerouslyDisableSandbox` needed — read-only.)

If `.syntaur/context.json` is missing or has no `leases` array, treat it as empty. Do NOT abort — listing is informational; the absence of session context is itself a useful signal.

For each entry, capture: `lease_id`, `inventory_slug`, `member_id`, `expires_at`, `claimed_at`, and any `metadata` (e.g. connection URL).

### Step 2: Run the system-wide overview

```bash
syntaur lease list
```

(Use `dangerouslyDisableSandbox: true` — the CLI reads `~/.syntaur/syntaur.db`.)

Capture stdout. If the CLI exits non-zero, surface the error message but still print whatever Step 1 produced.

### Step 3: Report back

Print two sections:

**Your active leases (from `.syntaur/context.json`):**

If the array is empty:
> "No leases held by this session."

Otherwise, one block per lease:
```
<lease_id>
  inventory: <inventory_slug>/<member_id>
  expires:   <expires_at>
  claimed:   <claimed_at>
  metadata:  <metadata JSON, if any>
```

**All inventories in this workspace (from `syntaur lease list`):**

Paste the CLI output verbatim (one row per inventory with kind/idle/leased counts).

### Step 4: Suggest next actions if any leases are nearing expiry

If any session-local lease's `expires_at` is within the next 5 minutes, append:
> "Note: lease `<id>` expires at `<iso>` (within 5 minutes). Run `/extend-resource <id> --ttl <duration>` to keep it."

This is informational only — don't extend automatically.
