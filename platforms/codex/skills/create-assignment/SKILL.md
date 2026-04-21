---
name: create-assignment
description: Use when the user wants to create a new Syntaur assignment inside a project or as a one-off project plus assignment.
---

# Create Assignment

Create a new Syntaur assignment from Codex.

## Arguments

User arguments: `$ARGUMENTS`

Parse:

- First positional argument: assignment title
- `--project <slug>` required unless `--one-off`
- `--one-off` optional
- `--slug <slug>` optional
- `--priority <level>` optional, default `medium`
- `--depends-on <slug[,slug...]>` optional
- `--dir <path>` optional

If no title was provided, ask the user for it.

If neither `--project` nor `--one-off` was provided, look for `.syntaur/context.json` in the current working directory. If present, default the project to that context's `projectSlug` and tell the user you are using it.

## Workflow

1. Run one of:
   - `syntaur create-assignment "<title>" --project <slug> [--slug <slug>] [--priority <level>] [--depends-on <slugs>] [--dir <path>]`
   - `syntaur create-assignment "<title>" --one-off [--slug <slug>] [--priority <level>] [--dir <path>]`
2. If the command fails, report the error and stop.
3. Read the generated `assignment.md`.
4. Summarize:
   - assignment slug
   - project slug
   - priority
   - location
   - created files: `assignment.md`, `scratchpad.md`, `handoff.md`, `decision-record.md` (plan files are NOT scaffolded — they are created on demand by `plan-assignment`)
5. Suggest next steps:
   - fill in the objective, context, acceptance criteria, and any initial todos in the `## Todos` section
   - or run `plan-assignment` to create a plan file and auto-append a linked todo to `## Todos`
   - run `grab-assignment` to claim it if work should begin now
