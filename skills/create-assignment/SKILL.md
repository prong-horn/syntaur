---
name: create-assignment
description: >-
  Create a new Syntaur assignment within a project (or as a standalone one-off).
  Use when the user wants to add a task, create an assignment, or break down
  work within a Syntaur project.
license: MIT
metadata:
  author: prong-horn
  version: "1.2.0"
---

# Create Assignment

Create a new assignment — project-nested or standalone.

## Input

Expects arguments from the user:

- First (required): the assignment title (e.g., `"Add login endpoint"`)
- `--project <slug>` (required unless `--one-off`): the project to add the assignment to
- `--one-off` (optional): create a **standalone** assignment at `~/.syntaur/assignments/<uuid>/` with `project: null`. The folder is named by UUID; `slug` is display-only. `--depends-on` is not permitted for standalone assignments.
- `--slug <slug>` (optional): override the auto-generated assignment slug
- `--priority <level>` (optional): `low`, `medium` (default), `high`, or `critical`
- `--type <type>` (optional): classification such as `feature`, `bug`, `refactor`, `research`, `chore`. Defaults to `feature`. When `~/.syntaur/config.md` defines `types.definitions`, the CLI validates against that list.
- `--depends-on <slug[,slug...]>` (optional, project-nested only): comma-separated list of assignment slugs this depends on
- `--dir <path>` (optional): override the default project directory
- `--with-todos` (optional): scaffold a `## Todos` section in `assignment.md`. **Omit unless the user explicitly asks for it.** Todos are normally a plan (added by `plan-assignment`) or populated during planning — not something to pre-create at assignment time. Pass this flag only if the user explicitly says something like "include todos", "with a todo list", "scaffold todos", etc.

If no title was provided, ask the user what the assignment should be called.

If neither `--project` nor `--one-off` was provided, check `.syntaur/context.json` for an active assignment. If present, default `--project` to that context's `projectSlug` and confirm with the user: "Add this assignment to project `<projectSlug>`?"

If no active context and no project flag, ask the user which project to add it to, or whether it should be a one-off.

## Step 1: Run the CLI

Build the command from the parsed arguments:

```bash
syntaur create-assignment "<title>" --project <slug> [--slug <slug>] [--priority <level>] [--type <type>] [--depends-on <slugs>] [--dir <path>] [--with-todos]
```

Or for a one-off (standalone at `~/.syntaur/assignments/<uuid>/`):

```bash
syntaur create-assignment "<title>" --one-off [--slug <slug>] [--priority <level>] [--type <type>] [--dir <path>] [--with-todos]
```

If the command fails (e.g., project not found, slug collision, invalid type), report the error and suggest fixes.

## Step 2: Read the Created Assignment

After successful creation, extract the assignment slug (and for standalone, the UUID) and directory from the CLI output. Read the generated `assignment.md`:

```bash
# Project-nested:
cat ~/.syntaur/projects/<project-slug>/assignments/<assignment-slug>/assignment.md

# Standalone:
cat ~/.syntaur/assignments/<uuid>/assignment.md
```

## Step 3: Guide Next Steps

Tell the user:
- The assignment was created with its slug, priority, type, and location. For standalone assignments, note that the folder is named by UUID (not slug) — `slug` is display-only.
- Files created: `assignment.md`, `progress.md`, `comments.md`, `scratchpad.md`, `handoff.md`, `decision-record.md`. **`plan.md` is NOT scaffolded** — plan files are optional and created on demand by the `plan-assignment` skill.
- Remind the user: `progress.md` is where timestamped progress entries go (NOT `assignment.md`), and `comments.md` is CLI-mediated — write only via `syntaur comment <slug-or-uuid> "body" --type question|note|feedback [--reply-to <id>]`.
- Suggest editing `assignment.md` to fill in the objective, acceptance criteria, and context. A `## Todos` section is **not** scaffolded by default — it is added automatically by `plan-assignment` (linking the new plan file) or by `syntaur request` (cross-assignment requests). Only the `--with-todos` flag pre-scaffolds an empty `## Todos` section.
- If dependencies were set, note them. Standalone assignments cannot declare `dependsOn`.
- Suggest `grab-assignment <project-slug> <assignment-slug>` (or `grab-assignment --id <uuid>` for standalone) to claim and start working on it.
