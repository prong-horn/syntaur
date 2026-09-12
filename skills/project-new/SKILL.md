---
name: project-new
description: >-
  Create a new Syntaur project with full scaffolding (manifest, indexes, ticket
  id prefix). Use when the user wants to start a new project or initiative in
  Syntaur.
license: MIT
metadata:
  author: prong-horn
  version: "1.2.0"
---

# Create Project

Create a new Syntaur project with full scaffolding.

## Input

Expects arguments from the user:

- First (required): the project title (e.g., `"Build Auth System"`)
- `--slug <slug>` (optional): override the auto-generated slug
- `--prefix <prefix>` (optional): override the auto-derived ticket id prefix (2–5 uppercase letters)
- `--dir <path>` (optional): override the default project directory

If no title was provided, ask the user what the project should be called.

## Step 1: Run the CLI

```bash
syntaur project new "<title>" [--slug <slug>] [--prefix <prefix>] [--dir <path>]
```

If the command fails (e.g., slug collision, empty title), report the error and suggest fixes.

## Step 2: Read the Created Project

Extract the project slug, prefix, and directory from the CLI output. Read the generated `project.md` to confirm structure:

```bash
cat ~/.syntaur/projects/<slug>/project.md
```

## Step 3: Guide Next Steps

Tell the user:

- The project was created with its slug, ticket id prefix, and location (`~/.syntaur/projects/<slug>/`).
- Key files scaffolded:
  - `project.md` — human-authored goal and context (edit this). Includes `prefix` and `nextTicket` for ticket ids.
  - `manifest.md` — derived root navigation (do not edit directly).
  - `_index-tickets.md`, `_index-plans.md`, `_index-decisions.md`, `_status.md` — derived indexes.
- Per-project `agent.md` / `claude.md` are NOT created — protocol v2.0 removed them. Agent-level conventions live at the repo root in `CLAUDE.md` / `AGENTS.md`, and user-defined behavioral rules live in `~/.syntaur/playbooks/<slug>.md`.
- Suggest they edit `project.md` to fill in the goal, scope, and context sections.
- Suggest running `syntaur new "<title>" --project <slug>` to add tickets to this project.
