---
name: create-project
description: >-
  Create a new Syntaur project with full scaffolding (manifest, indexes,
  resources, memories). Use when the user wants to start a new project or
  initiative in Syntaur.
license: MIT
metadata:
  author: prong-horn
  version: "1.1.0"
---

# Create Project

Create a new Syntaur project with full scaffolding.

## Input

Expects arguments from the user:

- First (required): the project title (e.g., `"Build Auth System"`)
- `--slug <slug>` (optional): override the auto-generated slug
- `--dir <path>` (optional): override the default project directory
- `--workspace <workspace>` (optional): workspace grouping label (e.g., `syntaur`, `reeva`)

If no title was provided, ask the user what the project should be called.

## Step 1: Run the CLI

```bash
syntaur create-project "<title>" [--slug <slug>] [--dir <path>] [--workspace <workspace>]
```

If the command fails (e.g., slug collision, empty title), report the error and suggest fixes.

## Step 2: Read the Created Project

Extract the project slug and directory from the CLI output. Read the generated `project.md` to confirm structure:

```bash
cat ~/.syntaur/projects/<slug>/project.md
```

## Step 3: Guide Next Steps

Tell the user:

- The project was created with its slug and location (`~/.syntaur/projects/<slug>/`).
- Key files scaffolded:
  - `project.md` — human-authored goal and context (edit this).
  - `manifest.md` — derived root navigation (do not edit directly).
  - `_index-assignments.md`, `_index-plans.md`, `_index-decisions.md`, `_status.md` — derived indexes.
  - `resources/_index.md` and `memories/_index.md` — shared-writable area scaffolding.
- Per-project `agent.md` / `claude.md` are NOT created — protocol v2.0 removed them. Agent-level conventions live at the repo root in `CLAUDE.md` / `AGENTS.md`, and user-defined behavioral rules live in `~/.syntaur/playbooks/<slug>.md`.
- Suggest they edit `project.md` to fill in the goal, scope, and context sections.
- Suggest running `create-assignment "<title>" --project <slug>` to add assignments to this project. Or `create-assignment "<title>" --one-off` for standalone work at `~/.syntaur/assignments/<uuid>/`.
