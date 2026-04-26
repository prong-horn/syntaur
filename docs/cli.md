# Syntaur CLI

Reference for `syntaur` subcommands. Run `syntaur --help` for a full list.

## `syntaur agents`

Manage configurable agents used by `syntaur browse` and future launch flows.

Agents live under the `agents:` list in `~/.syntaur/config.md`. When the block is absent, Syntaur uses built-in defaults (`claude`, `codex`). Every mutating subcommand accepts `--dry-run` to print the proposed change without writing.

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
