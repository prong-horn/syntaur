# Skills — `claim-resource`, `release-resource`, `extend-resource`, `list-resources`

Four agent skills wrap the lease CLI for Claude Code / Codex sessions. They are intentionally thin: they parse arguments, call the underlying CLI, and persist enough state into `.syntaur/context.json` that the agent can clean up later without having to remember lease ids.

All four skills are auto-installed alongside the protocol skills and live under `~/.claude/skills/` and `~/.codex/skills/` after `syntaur install-plugin` (or `npx skills add prong-horn/syntaur`).

---

## `/claim-resource`

Claim an idle member of an inventory for the current assignment session.

```
/claim-resource <inventory_slug> [--ttl <duration>] [--for <tag>]
```

### Triggers

The skill description fires on phrases like "claim a dev env", "lease an environment", "grab a test DB", "claim a slot", as well as explicit `/claim-resource` invocations.

### What the skill does

1. **Reads `.syntaur/context.json`** from the working directory. If neither a `sessionId` nor any of `projectSlug` / `assignmentSlug` / `assignmentDir` is present, it aborts. This guards against writing a leases-only context file that would later trip `syntaur doctor`'s workspace check.
2. **Derives `--for`** if the user didn't pass it — prefers `assignmentSlug`, falls back to `sessionId`. The tag shows up in `lease show` / `lease list` and is the breadcrumb a human uses on the dashboard to ask "whose lease is this?".
3. **Calls `syntaur lease claim <slug> --json …`**. Sandbox is disabled for that Bash call because the CLI writes to `~/.syntaur/syntaur.db` outside the workspace.
4. **Persists the lease** into `.syntaur/context.json`'s `leases: []` array, atomically (`jq` + rename). Each entry: `{ lease_id, inventory_slug, member_id, expires_at, metadata, claimed_at }`.
5. **Reports back** with the claimed `member_id`, lease id, `expires_at`, and the member's connection metadata in a fenced code block so the agent can use it immediately.

### Error surfaces the agent must handle

| stderr fragment | meaning | response |
|---|---|---|
| `no idle members in '<slug>'` | pool exhausted | Tell user. Suggest waiting / adding capacity. |
| `contention timeout on '<slug>'; retry` | `SQLITE_BUSY` >5s | Retry once after ~1s; if still failing, surface. |
| `inventory '<slug>' not found` | typo | Print `syntaur lease list` so the user sees real slugs. |

### What the skill does NOT do

- No automatic retry / blocking wait. The CLI is fail-fast and so is the skill.
- No auto-release on SessionEnd. The agent must call `/release-resource` (or let the TTL expire) — `.syntaur/context.json` is just a memory aid for the agent.

---

## `/release-resource`

Release one or all active leases recorded in `.syntaur/context.json`.

```
/release-resource <lease_id>
/release-resource --all
```

### Triggers

Fires on "release this dev env", "drop the lease", "release my slot", "release all leases", or explicit `/release-resource`.

### What the skill does

1. **Parses arguments.** With `--all`, builds the list from `.syntaur/context.json`'s `leases: []`; otherwise takes the first positional argument as the single `lease_id`. With neither, prints the active leases from context and exits.
2. **Calls `syntaur lease release <lease_id>`** for each.
3. **Always removes the entry from `.syntaur/context.json`**, even if the CLI returned `StaleLeaseError` — a stale lease is dead either way, and keeping it in context is misleading.
4. **Summarizes**: single-lease releases get a one-liner; `--all` prints one line per lease and a `Released N, M already stale` summary.

### Stale releases are normal

If the lease's TTL already expired, or someone force-released it from the dashboard, the CLI returns exit 1 with `lease <id> is no longer active`. The skill treats this as a clean outcome — it just notes the staleness in the summary. The slot has either been reclaimed by `gc` (idle again) or by a new claimant (someone else holds it); either way, the agent shouldn't keep the dead row in its context.

---

## `/extend-resource`

Push out the TTL on an active lease and keep `.syntaur/context.json` in sync.

```
/extend-resource <lease_id> --ttl <duration>
```

### Triggers

Fires on "extend my lease", "renew the lease", "bump the TTL", "keep this resource a bit longer", or explicit `/extend-resource`.

### What the skill does

1. **Reads `.syntaur/context.json`** with the same pre-check guard as `/claim-resource` — aborts if there's no `sessionId` or assignment context.
2. **Calls `syntaur lease extend <lease_id> --ttl <duration>`**. Sandbox disabled (writes `~/.syntaur/syntaur.db`).
3. **On success**, parses the new `expires_at` from stdout and patches the matching entry in `.syntaur/context.json`'s `leases: []` in place (`jq` + atomic rename).
4. **On `StaleLeaseError`**, drops the entry from context and tells the user the lease is dead — they need to `/claim-resource` again.

### Error surfaces

| stderr fragment | meaning | response |
|---|---|---|
| `cannot be extended (expired, revoked, or member generation advanced)` | `StaleLeaseError` | Drop from context; tell user to re-claim. |
| `contention timeout; retry` | `SQLITE_BUSY` | Retry once after ~1s. |
| `--ttl must be positive` | Bad duration. | Re-prompt for a valid duration. |

---

## `/list-resources`

Show both "what I'm holding right now" and "what's out there", in one call.

```
/list-resources
```

### Triggers

Fires on "what leases do I have", "show my leases", "list my resources", "what resources am I holding", or explicit `/list-resources`.

### What the skill does

1. **Reads `.syntaur/context.json`** and prints each entry from `leases: []` (lease id, inventory/member, expires, claimed_at, metadata). Tolerates missing/empty arrays — listing is informational.
2. **Runs `syntaur lease list`** for the workspace-wide overview (per-inventory idle/leased counts).
3. **Flags imminent expiries** — if any session-local lease expires within the next 5 minutes, suggests `/extend-resource <id> --ttl <duration>` next to it.

This is the cheap lookup before deciding to extend, release, or grab another resource.

---

## Future CLI + skill surface

The v1 + v1.1 set above covers the day-to-day surface. Still outstanding for later versions:

| Missing piece | Why it matters | Where it would live |
|---|---|---|
| `provision` adapter | Inventories that grow on demand. | DB layer + new CLI verb. |
| `recycle` adapter | Run a callback between leases (rotate keys, wipe disk, …). | DB layer + claim path. |
| Healthcheck adapter | Catch zombie members before TTL expires them. | DB layer + new sweep. |
| SessionEnd auto-release | Leases held by an exited Claude Code session are not reclaimed automatically; they fall off via TTL. | Hook integration. |
| Per-lease ACL on `lease_id` | The id is still a bearer token in v1. | Schema + auth path. |

If you ship any of these, the corresponding skill is usually a 30-line wrapper that follows the `claim-resource` / `release-resource` template.
