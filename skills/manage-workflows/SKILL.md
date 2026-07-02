---
name: manage-workflows
description: >-
  Manage multiple named lifecycle workflows in Syntaur. Use when the user wants
  more than one status pipeline — e.g. a "bug" workflow distinct from the default
  feature flow — and wants to create, clone, rename, delete, or set a default
  workflow, or bind a project's assignment type to a workflow. Triggers on
  phrases like "multiple workflows", "separate workflow for bugs", "different
  pipeline", "workflow for this project", "bind type to workflow", "default
  workflow", "set the workflow for this ticket".
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Manage Workflows

A **workflow** is a named status bundle — a full `statuses` / `order` / `transitions` / `derive` / `facts` set that a ticket follows. Every workspace has a built-in `default` workflow (the classic single status pipeline). Additional workflows let bugs, features, chores, etc. each run their own lifecycle. The `syntaur workflow` CLI writes to the `workflows:` block in `~/.syntaur/config.md` — the same library the dashboard workflow editor edits, so CLI and dashboard stay in sync.

**Legacy configs are unchanged.** A workspace that only ever uses the default keeps the plain top-level `statuses:` block. The `workflows:` block appears only when the first *non-default* workflow is created; at that point the legacy block is lifted into `workflows.default` and removed (single source of truth). Reads always tolerate an absent `workflows:` block, so backward compatibility holds until the first real workflow exists.

## Which workflow a ticket follows (binding, first-hit wins)

1. the assignment's own `workflow:` frontmatter field (explicit override), else
2. the project's `workflowByType[<type>]` for the ticket's type, else
3. the project's `defaultWorkflow`, else
4. the global `defaultWorkflow`, else
5. `default`.

An id that isn't a defined workflow is skipped, so resolution always terminates at `default`.

## Input

Map the user's intent to a subcommand:

| Subcommand | When to use |
|-----------|-------------|
| `syntaur workflow list [--json]` | Show the defined workflows and the global default (`*` marks it). Run first when the user asks "what workflows do I have?" |
| `syntaur workflow new <id> [--label <label>] [--from <sourceId>] [--set-default]` | Create a workflow. Without `--from`, it seeds the built-in default status set; `--from` clones another workflow's bundle. `--set-default` also promotes it. |
| `syntaur workflow edit <id> --label <label>` | Rename a workflow's display label. |
| `syntaur workflow set-default <id>` | Set the global default workflow. |
| `syntaur workflow delete <id>` | Remove a workflow. **Blocked** while any project binds it or any ticket resolves to it — the CLI lists the blockers; reassign those first. The built-in `default` can never be deleted. |
| `syntaur workflow bind-type <project> <type> <workflow>` | Bind a project's assignment type to a workflow (writes the project's `workflowByType`). |

To edit a workflow's actual statuses/transitions/derive rules, use the dashboard workflow editor (the CLI manages the library + bindings, not per-status editing — that's `syntaur status` for the default workflow).

## Setting a ticket's workflow

- On creation: `syntaur create-assignment "<title>" --project <slug> --workflow <id>` writes the `workflow:` override.
- Per project + type: `syntaur workflow bind-type <project> <type> <workflow>` so every ticket of that type in that project resolves to the workflow without a per-ticket override.

## Safety

- `delete` runs a delete-in-use guard: bound projects and tickets resolving to the workflow both block removal, and so does being the global `defaultWorkflow` (set another default first).
- `syntaur doctor` validates that every binding (global/project `defaultWorkflow`, `workflowByType`, per-ticket `workflow:` override) names a defined workflow, and validates each workflow's derive/facts independently.

## Verify

After any change, run `syntaur workflow list` (and `syntaur doctor` if bindings changed) to confirm the library and default are as intended.
