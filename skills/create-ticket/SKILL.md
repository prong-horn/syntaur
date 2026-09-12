---
name: create-ticket
description: >-
  Create a new Syntaur ticket within a project (or as a standalone one-off).
  Use when the user wants to add a task, create a ticket, or break down
  work within a Syntaur project.
license: MIT
metadata:
  author: prong-horn
  version: "1.2.0"
---

# Create Ticket

Create a new ticket — project-nested or standalone.

## Input

Expects arguments from the user:

- First (required): the ticket title (e.g., `"Add login endpoint"`)
- `--project <slug>` (required unless `--one-off`): the project to add the ticket to
- `--one-off` (optional): create a **standalone** ticket at `~/.syntaur/tickets/<uuid>/` with `project: null`. The folder is named by UUID; `slug` is display-only. `--depends-on` is not permitted for standalone tickets.
- `--slug <slug>` (optional): override the auto-generated ticket slug
- `--priority <level>` (optional): `low`, `medium` (default), `high`, or `critical`
- `--type <type>` (optional): classification such as `feature`, `bug`, `refactor`, `research`, `chore`. Defaults to `feature`. When `~/.syntaur/config.md` defines `types.definitions`, the CLI validates against that list.
- `--depends-on <slug[,slug...]>` (optional, project-nested only): comma-separated list of ticket slugs this depends on
- `--dir <path>` (optional): override the default project directory

If no title was provided, ask the user what the ticket should be called.

If neither `--project` nor `--one-off` was provided, check for an active ticket via the session's open engagement (`syntaur session resume --json`). If there is one, default `--project` to its `projectSlug` and confirm with the user: "Add this ticket to project `<projectSlug>`?"

If there is no open engagement and no project flag, ask the user which project to add it to, or whether it should be a one-off.

## Step 1: Run the CLI

Build the command from the parsed arguments:

```bash
syntaur new "<title>" --project <slug> [--slug <slug>] [--priority <level>] [--type <type>] [--depends-on <slugs>] [--dir <path>]
```

Or for a one-off (standalone at `~/.syntaur/tickets/<uuid>/`):

```bash
syntaur new "<title>" --one-off [--slug <slug>] [--priority <level>] [--type <type>] [--dir <path>]
```

If the command fails (e.g., project not found, slug collision, invalid type), report the error and suggest fixes.

## Step 2: Read the Created Ticket

After successful creation, extract the ticket slug (and for standalone, the UUID) and directory from the CLI output. Read the generated `ticket.md`:

```bash
# Project-nested:
cat ~/.syntaur/projects/<project-slug>/tickets/<ticket-slug>/ticket.md

# Standalone:
cat ~/.syntaur/tickets/<uuid>/ticket.md
```

## Step 3: Guide Next Steps

Tell the user:
- The ticket was created with its slug, priority, type, and location. For standalone tickets, note that the folder is named by UUID (not slug) — `slug` is display-only.
- Files created: `ticket.md`, `progress.md`, `comments.md`, `scratchpad.md`, `handoff.md`, `decision-record.md`. **`plan.md` is NOT scaffolded** — plan files are optional and created on demand by the `plan-ticket` skill.
- Remind the user: `progress.md` is where timestamped progress entries go (NOT `ticket.md`), and `comments.md` is CLI-mediated — write only via `syntaur comment <slug-or-uuid> "body" --type question|note|feedback [--reply-to <id>]`.
- Suggest editing `ticket.md` to fill in the objective, acceptance criteria, and context.
- If dependencies were set, note them. Standalone tickets cannot declare `dependsOn`.
- Suggest `grab-ticket <project-slug> <ticket-slug>` (or `grab-ticket --id <uuid>` for standalone) to claim and start working on it.
