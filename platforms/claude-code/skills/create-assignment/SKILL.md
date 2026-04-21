---
name: create-assignment
description: Create a new Syntaur assignment within a project (or as a one-off)
argument-hint: <title> --project <slug> [--priority <level>] [--depends-on <slugs>] [--type <type>] [--one-off]
allowed-tools:
  - Bash
  - Read
---

# Create Assignment

Create a new assignment within a Syntaur project from Claude Code.

## Arguments

The user provided: $ARGUMENTS

Parse the arguments:
- First argument (required): the assignment title (e.g., `"Add login endpoint"`)
- `--project <slug>` (required unless `--one-off`): the project to add the assignment to
- `--one-off` (optional): create a **standalone** assignment at `~/.syntaur/assignments/<uuid>/` with `project: null`. Folder is named by UUID; `slug` is display-only. `--depends-on` is not permitted for standalone assignments.
- `--slug` (optional): override the auto-generated assignment slug
- `--priority` (optional): `low`, `medium` (default), `high`, or `critical`
- `--type` (optional): classification such as `feature`, `bug`, `refactor`, `research`, `chore`. Defaults to `feature`. When `~/.syntaur/config.md` defines `types.definitions`, the CLI validates against that list.
- `--depends-on` (optional, project-nested only): comma-separated list of assignment slugs this depends on
- `--dir` (optional): override the default project directory

If no title was provided, ask the user what the assignment should be called.

If neither `--project` nor `--one-off` was provided, check if there is an active assignment context in `.syntaur/context.json`. If so, default `--project` to that context's `projectSlug` and confirm with the user: "Add this assignment to project `<projectSlug>`?"

If there is no active context and no project flag, ask the user which project to add it to, or whether it should be a one-off.

## Step 1: Run the CLI

Build the command from the parsed arguments. Use `dangerouslyDisableSandbox: true` since the CLI writes to `~/.syntaur/` which is outside the project sandbox.

```bash
syntaur create-assignment "<title>" --project <slug> [--slug <slug>] [--priority <level>] [--depends-on <slugs>] [--type <type>] [--dir <path>]
```

Or for one-off (standalone at `~/.syntaur/assignments/<uuid>/`):

```bash
syntaur create-assignment "<title>" --one-off [--slug <slug>] [--priority <level>] [--type <type>] [--dir <path>]
```

If the command fails (e.g., project not found, slug collision), report the error and suggest fixes.

## Step 2: Read the Created Assignment

After successful creation, extract the assignment slug and directory from the CLI output. Read the generated `assignment.md`:

```bash
cat ~/.syntaur/projects/<project-slug>/assignments/<assignment-slug>/assignment.md
```

## Step 3: Guide Next Steps

Tell the user:
- The assignment was created with its slug, priority, type, and location. For standalone assignments, the location is `~/.syntaur/assignments/<uuid>/` — note the UUID (not slug) is the folder name.
- List the files created: `assignment.md`, `progress.md`, `comments.md`, `scratchpad.md`, `handoff.md`, `decision-record.md`. `plan.md` is NOT scaffolded — plan files are optional and created on demand by `/plan-assignment`.
- Remind the user: `progress.md` is where timestamped progress entries go (not `assignment.md`), and `comments.md` is written only via `syntaur comment <slug-or-uuid> "body" --type question|note|feedback`.
- Suggest they edit `assignment.md` to fill in the objective, acceptance criteria, context, and any initial todos. The `## Todos` section accepts simple tasks or markdown links to plan files.
- Or suggest running `/plan-assignment` after grabbing — it creates a plan file and auto-appends a linked todo to `## Todos`.
- If dependencies were set, note them. (Standalone assignments cannot declare dependencies.)
- Suggest running `/grab-assignment <project-slug> <assignment-slug>` (or `/grab-assignment --id <uuid>` for standalone) to claim and start working on it.
