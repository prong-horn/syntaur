---
name: manage-statuses
description: >-
  Manage custom assignment statuses and transitions in Syntaur. Use when the
  user wants to add a status, customize a workflow stage, rename a status,
  remove or reorder statuses, define a custom transition, change which states
  are terminal (the "done state"), or otherwise edit the `statuses:` block in
  `~/.syntaur/config.md`. Triggers on phrases like "add a status", "custom
  status", "rename a status", "workflow stage", "change my workflow",
  "terminal status", "done state".
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Manage Statuses

Customize Syntaur's assignment-status workflow via the `syntaur status` CLI. The CLI writes to the same `statuses:` block in `~/.syntaur/config.md` that the dashboard Settings page edits — so CLI and dashboard edits stay in sync.

The runtime is **all-or-nothing**: once `~/.syntaur/config.md` has a `statuses:` block, the built-in defaults (`pending`, `in_progress`, `blocked`, `review`, `completed`, `failed`) are NOT merged. `syntaur status init` materializes those defaults explicitly so the user has a starting point to customize. `syntaur status reset` removes the block to revert.

## Input

The user usually describes the change in free-form prose ("add a needs-design status after pending", "rename in_progress to working", "remove blocked", "make completed not terminal"). Map their intent to a subcommand:

| Subcommand | When to use |
|-----------|-------------|
| `syntaur status list [--json]` | Show the current set, with `source: config | default` markers. Always run this first when the user asks "what statuses do I have?" |
| `syntaur status init [--force]` | Materialize the built-in defaults explicitly. Run before any custom edit if `list` shows `source: default` for everything. |
| `syntaur status reset [--force]` | Remove the `statuses:` block and revert to implicit defaults. |
| `syntaur status add <id> --label <label> [--color <hex>] [--icon <name>] [--description <text>] [--terminal] [--after <id> | --before <id> | --at-end]` | Append a new status. Position flags are mutually exclusive. |
| `syntaur status set --id <id> [...]` | Mutate metadata on an existing status without renaming. `--terminal true|false` (literal strings). |
| `syntaur status reorder <id,id,...>` | Replace the order array. CSV must be a permutation of current ids — no drops, no extras. |
| `syntaur status remove <id> [--force]` | Remove a status. Without `--force`, errors if any assignment references it; lists offenders. With `--force`, also prunes `order` and `transitions[i]` whose `from === <id>` or `to === <id>`. |
| `syntaur status rename <id> --to <new-id> [--label <label>]` | Rename a status id. **Atomic** rewrite across `config.md` + every affected `assignment.md`. Without `--label`, keeps the original label. |
| `syntaur status transition add --from <id> --command <cmd> --to <id> [--label <label>] [--requires-reason]` | Define a custom transition. |
| `syntaur status transition remove --from <id> --command <cmd>` | Drop a custom transition. |

Every mutating subcommand supports `--dry-run`, which prints a unified diff of the would-be `statuses:` block change (and, for `rename`, a per-file frontmatter diff for each affected `assignment.md`) and exits without writing.

## Step 1: Determine intent → pick subcommand

Read the user's request and choose the subcommand. If ambiguous, ask. If the user says "make my workflow look like X", run `syntaur status list` first, present what's there, and confirm what they actually want changed.

If the user is making a destructive change (`remove`, `rename`, `reset`), default to running with `--dry-run` first and showing the diff, then asking the user to confirm before re-running without `--dry-run`.

## Step 2: Run the CLI

Build and run the chosen `syntaur status ...` invocation. Quote labels and descriptions that contain spaces. Use the literal strings `true`/`false` for `--terminal` on the `set` subcommand.

If the user is on a fresh `~/.syntaur/config.md` (no `statuses:` block) and wants to make any change other than `init`/`reset`, run `syntaur status init` first so subsequent `add` / `set` / `reorder` / `rename` / `remove` operate on an explicit set.

## Step 3: Verify with `syntaur status list`

After every mutating subcommand, run `syntaur status list` (or `--json` for machine consumption) and confirm the change took effect. Report back to the user with the new state.

## Step 4: Guide next steps

- **If the dashboard is running** (`syntaur dashboard`), tell the user to restart it. The dashboard caches `StatusConfig` per-process and CLI mutations cannot reach a separate Node process. The dashboard's own writes invalidate its cache automatically; CLI writes don't.
- **After a `rename`,** every assignment that referenced the old id has been rewritten in-place. Mention this to the user — git will show diffs in many `assignment.md` files. They are intentional.
- **After a `remove --force`,** the affected assignments now reference an undefined status. `syntaur doctor` will flag them as invalid. Suggest the user run `syntaur doctor` and either re-add the status (`syntaur status add ...`) or edit each frontmatter to a valid id.
- **After `transition add`,** the dashboard's transition buttons reflect the new transition only after the cache invalidation above.

## Safety notes

- **`remove` is destructive.** Without `--force` it refuses if any assignment references the id. Don't suggest `--force` without first running `syntaur status remove <id>` (no force) so the user sees the affected list.
- **`rename` rewrites many files.** It edits `config.md` AND every affected `assignment.md` in a single atomic transaction (with rollback if any write fails partway). Always run `--dry-run` first on a non-trivial codebase so the user sees the per-file diff.
- **`terminal: true` is load-bearing.** Terminal statuses affect dashboard progress bars and dependency-satisfaction logic — an assignment with a terminal status counts as "done" for downstream `dependsOn` checks and project-rollup status. Don't toggle this on `pending`-style states without thinking.
- **`init --force` overwrites a custom block.** Use `reset` first if the user wants a clean slate, OR confirm before passing `--force` if they have unsaved customizations.
- **Concurrency.** `rename`'s buffer-write-rollback strategy assumes no concurrent writers. Tell the user to close the dashboard / pause other agents during a rename.
- **`SYNTAUR_HOME` precedence.** If the user has `SYNTAUR_HOME` set, the CLI writes there instead of `~/.syntaur`. Mirror their environment.
