---
name: grab-assignment
description: Use when the user wants to load a Syntaur assignment into context, create .syntaur/context.json, and register a Codex session. Works regardless of assignment status.
---

# Grab Assignment

Load a Syntaur assignment into the current working context and register this Codex session.

**Grabbing is non-destructive.** It never fails because of status. Any status (`pending`, `in_progress`, `blocked`, `review`, `completed`, `failed`) can be grabbed — grabbing just sets up context and registers the session. Only a `pending` assignment additionally transitions to `in_progress`; any other status is left untouched.

## Arguments

User arguments: `$ARGUMENTS`

Parse:

- First positional argument: project slug
- Second positional argument: optional assignment slug

## Workflow

1. If `.syntaur/context.json` already exists in the current working directory, read it and warn that claiming another assignment will replace the active context.
2. Read the project entry files:
   - `~/.syntaur/projects/<project-slug>/manifest.md`
   - `~/.syntaur/projects/<project-slug>/project.md`
   - `~/.syntaur/projects/<project-slug>/agent.md`
   - `~/.syntaur/projects/<project-slug>/claude.md` if it exists
   Note the `workspace` field in `project.md` frontmatter if present. This indicates which project/codebase grouping the project belongs to. When writing context to `.syntaur/context.json` (Step 8), include `"workspace": "<value>"` if the project has a workspace.
3. Discover assignments under `~/.syntaur/projects/<project-slug>/assignments/`. Do **not** filter by status — every assignment is grabbable.
4. If no assignment slug was provided:
   - list assignments with title, priority, and current status (highlight `pending` ones as the default candidates)
   - ask the user to choose unless there is exactly one obvious candidate
   If a slug *was* provided, verify the directory exists. Its status does not matter; do not block on it.
5. Read the chosen assignment's `assignment.md` — its frontmatter for `status`, and its markdown body for the objective, acceptance criteria, and `## Todos` section (active todos indicate outstanding work and may link to plan files to execute). If `dependsOn` is non-empty, also read each dep's `handoff.md` AND `decision-record.md` to inherit upstream context and decisions.
6. Claim the assignment:
   - Always: `syntaur assign <assignment-slug> --agent codex --project <project-slug>` (safe at any status; does not transition state)
   - **Only if current status is `pending`**: `syntaur start <assignment-slug> --project <project-slug>` to transition it to `in_progress`. Skip this command for any other status — grabbing must not rewind a `review`, `completed`, or `failed` assignment.
   If `syntaur assign` fails (e.g., project not found, invalid slug), report and stop. Do not treat a non-pending status as a failure.
7. If the assignment has no workspace configured, set `workspace.repository` and `workspace.worktreePath` to the current working directory so write boundaries are meaningful.
8. Create `.syntaur/context.json` in the current working directory with:

```json
{
  "projectSlug": "<project-slug>",
  "assignmentSlug": "<assignment-slug>",
  "projectDir": "/absolute/path/to/project",
  "assignmentDir": "/absolute/path/to/assignment",
  "workspaceRoot": "/absolute/path/to/workspace",
  "title": "<assignment title>",
  "branch": "<workspace.branch or null>",
  "grabbedAt": "<ISO 8601 timestamp>",
  "sessionId": "<uuid>"
}
```

9. Register the agent session:
   - generate a UUID
   - run `syntaur track-session --project <project-slug> --assignment <assignment-slug> --agent codex --session-id <uuid> --path <cwd>`
10. Summarize:
   - assignment slug and title
   - current status (call it out if the assignment was already past `pending` — e.g., "already in `review`, status unchanged")
   - objective
   - acceptance criteria
   - active todos from the `## Todos` section (if any), including any plan files they link to
   - workspace path
11. Suggest a next step appropriate to status:
   - `pending` / `in_progress`: `plan-assignment`
   - `blocked`: investigate `blockedReason`
   - `review`: inspect the implementation and help verify acceptance criteria
   - `completed` / `failed`: read the handoff; grab is probably for reference or reopen
