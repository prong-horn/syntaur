# User-authored agent target descriptors

Register an arbitrary coding agent with Syntaur — **without a Syntaur release** — by dropping a JSON
descriptor in `~/.syntaur/targets/`. The loader validates each file, merges valid descriptors into the
built-in registry, and the merged target then flows through `syntaur setup --target <id>` (Tier 1
skills + Tier 2 protocol files) exactly like a built-in agent.

- **Location:** `~/.syntaur/targets/*.json` (one descriptor per file; the filename is cosmetic — the
  `id` field is authoritative).
- **Format:** JSON only (Syntaur ships no YAML parser).
- **Precedence:** built-ins win. A descriptor whose `id` collides with a built-in (`cursor`, `codex`,
  `opencode`, `claude`, `pi`, `openclaw`, `hermes`) is **rejected** — user descriptors may only ADD new
  agent ids, never override a built-in (this protects the native `claude`/`codex` plugin paths).
- **Failure mode:** a malformed file is skipped with a warning (surfaced by `syntaur doctor` and the
  `setup`/`setup-adapter` commands) — one bad file never breaks setup for the others.

## Schema

| Field | Required | Type | Notes |
|---|---|---|---|
| `id` | yes | string | `^[a-z0-9][a-z0-9_-]*$`; must not be a built-in id |
| `displayName` | yes | string | Human-readable name for prompts + `doctor` |
| `skillsShAgentId` | no | string | The `npx skills add --agent <id>` id, if the agent is known to skills.sh |
| `detect` | yes | `DetectSpec` | How to probe whether the agent is installed (see below) |
| `skillsDir` | no | `{ project?: string; global?: string }` | `global` is home/env-expanded to absolute (used by the offline copy fallback); `project` stays project-relative |
| `instructions` | no | `{ files: [{ path, renderer }] }` | Tier-2 protocol files; `renderer` MUST be a built-in renderer key |

`renderer` must be one of: **`codexAgents`**, **`cursorProtocol`**, **`cursorAssignment`**,
**`openCodeConfig`**, **`hermesSoul`**. (User descriptors reference rendering logic by key — they
cannot ship code.)

### `DetectSpec` (the declarative install probe)

| `kind` | Fields | True when |
|---|---|---|
| `pathExists` | `path: string` | the path exists (`~` and `$VAR`/`${VAR}` expanded) |
| `anyPathExists` | `paths: string[]` | ANY listed path exists |
| `envSet` | `env: string` | `process.env[env]` is a non-empty string |

## Tier-1 reachability

A descriptor by itself does NOT make skills.sh aware of a brand-new agent. For the agent's **skills** to
actually install, provide **either**:

- a real `skillsShAgentId` that `npx skills add --agent <id>` already supports, **or**
- a `skillsDir.global` so Syntaur's offline copy fallback can install the bundled skills directly.

Tier-2 protocol files (the `instructions` renderers) always work regardless.

## Example

`~/.syntaur/targets/acme.json`:

```json
{
  "id": "acme",
  "displayName": "Acme Agent",
  "skillsShAgentId": "acme",
  "detect": { "kind": "pathExists", "path": "~/.acme" },
  "skillsDir": { "global": "~/.acme/skills" },
  "instructions": {
    "files": [{ "path": "AGENTS.md", "renderer": "codexAgents" }]
  }
}
```

Then:

```bash
syntaur setup --target acme           # Tier 1 (skills) + Tier 2 (AGENTS.md)
syntaur setup --target acme --dry-run # preview every action, write nothing
syntaur doctor                        # verifies acme's skills + protocol files
```

User descriptors are Tier-1 + Tier-2 only. They cannot declare a native plugin (`claude`/`codex`) or a
Tier-3 enforcement plugin — those are built-in, code-backed paths.
