# Syntaur CLI

Reference for `syntaur` subcommands. Run `syntaur --help` for a full list.

## `syntaur agents`

Manage configurable agents used by `syntaur browse` and future launch flows.

Agents live under the `agents:` list in `~/.syntaur/config.md`. When the block is absent, Syntaur uses built-in defaults (`claude`, `codex`, `pi`, `openclaw`, `hermes`). Every mutating subcommand accepts `--dry-run` to print the proposed change without writing.

### `syntaur agents list`

Print configured agents (or built-in defaults when none are configured). Each line shows `id`, `label`, `command`, and any flags (`default`, `shell-alias`, `prompt=<position>`).

### `syntaur agents add`

Add a new agent.

```
syntaur agents add --id <id> --label <label> --command <path> \
  [--args <csv>] \
  [--prompt-arg-position first|last|none] \
  [--default] \
  [--resolve-from-shell-aliases] \
  [--dry-run]
```

- `--id`, `--label`, `--command` are required.
- `--command` accepts an absolute path or a bare binary name. Relative paths with `/` are rejected.
- `--default` marks the agent as the default launch target (clears any prior default).
- `--resolve-from-shell-aliases` runs the command through `$SHELL -i -c '...'` so shell aliases resolve.
- `--dry-run` runs the same validation as a real write and prints the diff, but skips the config file write.

### `syntaur agents remove <id> [--dry-run]`

Remove a configured agent by id. Errors if the id does not exist.

### `syntaur agents set <id>`

Update one or more fields on an existing agent.

```
syntaur agents set <id> \
  [--label <label>] \
  [--command <path>] \
  [--args <csv>] \
  [--prompt-arg-position first|last|none] \
  [--default | --no-default] \
  [--resolve-from-shell-aliases | --no-resolve-from-shell-aliases] \
  [--dry-run]
```

Passing `--default` clears `default: true` on every other agent atomically. `--no-default` unsets the flag on this agent only.

### `syntaur agents reorder <ids>`

Reorder agents. `<ids>` is a comma-separated list that must cover every currently configured agent exactly once.

```
syntaur agents reorder codex,claude --dry-run
```

## `syntaur status`

Manage the assignment-status workflow — the `statuses:` block in `~/.syntaur/config.md` that the dashboard Settings page also edits. The runtime is **all-or-nothing**: once a `statuses:` block exists the built-in defaults are no longer merged. Every mutating verb accepts `--dry-run` to print a unified diff of the would-be `statuses:` block (and, for `rename`, per-file `assignment.md` diffs) without writing.

### `syntaur status list [--json]`

Print the current statuses, order, and transitions, with a `source: config | default` marker (`--json` emits `{ statuses, order, transitions, source }`).

### `syntaur status init [--force] [--dry-run]`

Materialize the built-in defaults explicitly. Refuses to overwrite an existing custom block unless `--force`.

### `syntaur status reset [--force] [--dry-run]`

Remove the `statuses:` block and revert to implicit defaults.

### `syntaur status add <id> [--dry-run]`

```
syntaur status add <id> --label <label> [--color <hex>] [--icon <name>] \
  [--description <text>] [--terminal] [--after <id> | --before <id> | --at-end]
```

Append a new status. The position flags are mutually exclusive (default `--at-end`).

### `syntaur status set --id <id> [--dry-run]`

Edit metadata on an existing status without renaming it: `--label`, `--color`, `--icon`, `--description`, `--terminal true|false` (literal strings).

### `syntaur status reorder <ids> [--dry-run]`

Replace the order. `<ids>` is a comma-separated list that must be a permutation of the current ids (no drops or extras).

### `syntaur status remove <id> [--force] [--dry-run]`

Remove a status. Without `--force` it errors and lists any assignments still using the id. With `--force` it edits `config.md` only — it drops the status from `statuses`/`order` and prunes transitions referencing it; **affected `assignment.md` files are left untouched** (they now reference an undefined status, which `syntaur doctor` flags). It never deletes assignments.

### `syntaur status rename <id> --to <new-id> [--label <label>] [--dry-run]`

Rename a status id atomically across `config.md` AND every affected `assignment.md` (buffer-write-rollback: if any write fails, all originals are restored). Keeps the original label unless `--label` is given.

### `syntaur status transition add|remove [--dry-run]`

```
syntaur status transition add --from <id> --command <cmd> --to <id> [--label <label>] [--requires-reason]
syntaur status transition remove --from <id> --command <cmd>
```

Define or drop a custom transition.

## `syntaur workspace set`

Set the four `workspace.*` frontmatter fields on an assignment atomically. Validates the file (same checks as `syntaur doctor --assignment --json`) **before** writing and re-validates **after**, restoring the original on failure, and bumps `updated`.

```
syntaur workspace set \
  --repository <path> --worktree-path <path> --branch <name> --parent-branch <name> \
  [--assignment <slug> [--project <slug>]]
```

Targets the active assignment from `.syntaur/context.json` unless `--assignment` is given. Provide at least one field flag.

## `syntaur progress log <text>`

Append a timestamped entry to the active assignment's `progress.md`: newest first (right after the `# Progress` H1), replacing the `No progress yet.` placeholder, incrementing `entryCount`, bumping `updated`, and preserving `assignment`/`generated`.

```
syntaur progress log "<text>" [--assignment <slug> [--project <slug>]]
```

## `syntaur session save`

Write the active session's continuity summary to `<assignmentDir>/sessions/<sessionId>/summary.md`. Preserves the existing `created` timestamp on re-save; the section body comes from `--from-file`, piped stdin, or a written skeleton. Never touches `handoff.md`.

```
syntaur session save [--session-id <id>] [--from-file <path>] [--assignment <slug> [--project <slug>]]
```

`--session-id` defaults to the `sessionId` in `.syntaur/context.json`; the command aborts if no real session id can be resolved.

## `syntaur unassign <assignment>`

Clear the assignee on an assignment (the inverse of `syntaur assign`) and bump `updated`.

```
syntaur unassign <assignment> [--project <slug>] [--dir <path>]
```

For standalone assignments pass the UUID and omit `--project`.

## `syntaur resource`

Manage project-level resources under `<projectDir>/resources/`. Every mutation regenerates `_index.md`.

- `syntaur resource add --project <slug> --name <name> --source <url-or-path> [--category <name>] [--slug <slug>] [--related-assignments <slugs>] [--force]`
- `syntaur resource list --project <slug> [--json]`
- `syntaur resource show <slug> --project <slug> [--json]`
- `syntaur resource update <slug> --project <slug> [--name] [--source] [--category] [--related-assignments]`
- `syntaur resource remove <slug> --project <slug> [--force]`

## `syntaur memory`

Manage project-level memories under `<projectDir>/memories/`. Every mutation regenerates `_index.md`.

- `syntaur memory add --project <slug> --name <name> --source <text> [--scope <scope>] [--source-assignment <slug>] [--slug <slug>] [--related-assignments <slugs>] [--force]`
- `syntaur memory list --project <slug> [--json]`
- `syntaur memory show <slug> --project <slug> [--json]`
- `syntaur memory update <slug> --project <slug> [--name] [--source] [--scope] [--source-assignment] [--related-assignments]`
- `syntaur memory remove <slug> --project <slug> [--force]`

## `syntaur worktree`

Manage git worktrees bound to assignments.

- `syntaur worktree create --branch <name> [--repository <path>] [--parent-branch <name>] [--assignment <slug> [--project <slug>]] [--worktree-path <path>]` — create a worktree and record the workspace block.
- `syntaur worktree list [--repository <path>] [--json]` — list the repository's worktrees.
- `syntaur worktree remove` (alias `prune`) `[--assignment <slug> [--project <slug>]] [--repository <path>] [--delete-branch] [--force]` — remove the assignment's worktree (git teardown first), optionally delete the branch, then clear the four `workspace.*` fields and bump `updated`. Without `--force`, git refuses a dirty/locked worktree.

## `syntaur plan`

Manage plan files for an assignment.

- `syntaur plan create [--assignment <slug> [--project <slug>]] [--force]` — write the initial `plan.md` and append the four-todo cycle to `assignment.md ## Todos`. Refuses to overwrite an existing `plan.md` without `--force`.
- `syntaur plan version [--assignment <slug> [--project <slug>]] [--force]` — create the next `plan-v<N>.md`, supersede the prior cycle, and carry forward unchecked tasks.

## Launch flow

`syntaur browse` opens the TUI browser and, when you pick an assignment, launches an agent.

```
syntaur browse [--agent <id>] [--no-worktree-prompt]
```

### Agent selection

Resolution order:

1. Zero agents configured → error pointing at `syntaur agents add`.
2. One agent configured (or built-in defaults with one agent) → launch directly.
3. Multiple agents configured → interactive picker (pre-selects `default: true`).

`--agent <id>` bypasses the picker. Unknown ids exit with a clear error.

### Worktree / branch prompt

If the selected assignment is missing `workspace.worktreePath` or `workspace.branch`, the launcher runs the following matrix (first match wins):

| Condition | Behavior |
|-----------|----------|
| `--no-worktree-prompt` set | Fall back to existing cwd logic. No prompt, no create. |
| `worktreePath` AND `branch` already set | Use them as cwd. No prompt. |
| `agentDefaults.autoCreateWorktree: skip` | Fall back to cwd logic. No prompt, no create. |
| `agentDefaults.autoCreateWorktree: always` | Create a worktree with inferred defaults (no prompt). |
| default / `ask` | Interactively prompt (`y/n`). On accept, prompt for repository, branch, parent branch, and worktree path. |

Inferred defaults:

- **repository**: `workspace.repository` if set, else the current `git rev-parse --show-toplevel`.
- **branch**: `syntaur/<project-slug>/<assignment-slug>`, or `syntaur/<assignment-slug>` for standalone assignments.
- **parent branch**: current branch, falling back to `main`.
- **worktree path**: `~/.syntaur/worktrees/<project-slug>/<assignment-slug>` (expanded to an absolute path).

On accept, Syntaur runs `git worktree add -b <branch> <worktreePath> <parentBranch>`, writes the four fields back into `assignment.md` (atomic update), and launches the agent with the new worktree as `cwd`. If the frontmatter write fails after the worktree was created, Syntaur rolls back the worktree and branch so `assignment.md` and git state stay consistent.

When the user declines (or `--no-worktree-prompt` is set, or `autoCreateWorktree: skip`), the launcher falls back to `detail.workspace.worktreePath` → `detail.workspace.repository` → `process.cwd()` and prints a one-line warning naming the chosen cwd.

### Shell aliases

If the configured `command` is a shell alias (e.g. `c='claude --dangerously-skip-permissions'`), set `resolveFromShellAliases: true` on that agent. Syntaur will execute `$SHELL -i -c '<quoted command + args>'` so the alias resolves. When `$SHELL` is unset or not absolute, Syntaur falls back to `/bin/sh` and prints a warning.

When launch fails:

- `ENOENT` → "command not found — if this is a shell alias, enable `resolveFromShellAliases: true`."
- `EACCES` → "command is not executable — check file permissions."
- Anything else → the underlying errno and message.
