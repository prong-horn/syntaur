---
name: create-ticket
description: >-
  Create a new Syntaur ticket within a project (or in the scratch project when
  no project is given). Use when the user wants to add a task, create a ticket,
  or break down work within a Syntaur project.
license: MIT
metadata:
  author: prong-horn
  version: "1.3.0"
---

# Create Ticket

Create a new ticket — project-nested or in the lazy `scratch` project (prefix `SCR`).

## Input

Expects arguments from the user:

- First (required): the ticket title (e.g., `"Add login endpoint"`)
- `--project <slug>` (optional): the project to add the ticket to. When omitted, `syntaur new` allocates an id in `projects/scratch/` (`SCR-<n>`).
- `--slug <slug>` (optional): override the auto-generated display slug (folder becomes `<ID>-<slug>`)
- `--priority <level>` (optional): `low`, `medium` (default), `high`, or `critical`
- `--type <type>` (optional): classification such as `feature`, `bug`, `refactor`, `research`, `chore`. Defaults to `feature`. When `~/.syntaur/config.md` defines `types.definitions`, the CLI validates against that list.
- `--depends-on <ids>` (optional): comma-separated list of ticket ids (`<PREFIX>-<n>`) this depends on
- `--links <ids>` (optional): comma-separated linked ticket ids
- `--dir <path>` (optional): override the default project directory

If no title was provided, ask the user what the ticket should be called.

If `--project` was not provided, check for an active ticket via the session's open engagement (`syntaur session resume --json`). If there is one, default `--project` to its `projectSlug` and confirm with the user: "Add this ticket to project `<projectSlug>`?"

If there is no open engagement and no project flag, ask the user which project to add it to, or create in scratch by omitting `--project`.

## Step 1: Run the CLI

Build the command from the parsed arguments:

```bash
syntaur new "<title>" [--project <slug>] [--slug <slug>] [--priority <level>] [--type <type>] [--depends-on <ids>] [--links <ids>] [--dir <path>]
```

If the command fails (e.g., project not found, slug collision, invalid type), report the error and suggest fixes.

## Step 2: Read the Created Ticket

After successful creation, extract the ticket id and directory from the CLI output. Read the generated `ticket.md`:

```bash
cat ~/.syntaur/projects/<project-slug>/tickets/<ID>-<slug>/ticket.md
```

## Step 3: Guide Next Steps

Tell the user:
- The ticket was created with its id (`<PREFIX>-<n>`), slug, priority, type, and location under `tickets/<ID>-<slug>/`.
- Files created: `ticket.md`, `progress.md`, `comments.md`, `scratchpad.md`, `handoff.md`, `decision-record.md`. **`plan.md` is NOT scaffolded** — plan files are optional and created on demand by the `plan-ticket` skill.
- Remind the user: `progress.md` is where timestamped progress entries go (NOT `ticket.md`), and `comments.md` is CLI-mediated — write only via `syntaur comment <id> "body" --type question|note|feedback [--reply-to <id>]`.
- Suggest editing `ticket.md` to fill in the objective, acceptance criteria, and context.
- If dependencies were set, note them (ids must resolve).
- Suggest `grab-ticket <ticket-id>` to claim and start working on it.
