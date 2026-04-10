---
name: grab-assignment
description: Use when the user wants to discover, claim, and start a pending Syntaur assignment, create .syntaur/context.json, and register a Codex session.
---

# Grab Assignment

Claim a pending Syntaur assignment and set up the current workspace.

## Arguments

User arguments: `$ARGUMENTS`

Parse:

- First positional argument: mission slug
- Second positional argument: optional assignment slug

## Workflow

1. If `.syntaur/context.json` already exists in the current working directory, read it and warn that claiming another assignment will replace the active context.
2. Read the mission entry files:
   - `~/.syntaur/missions/<mission-slug>/manifest.md`
   - `~/.syntaur/missions/<mission-slug>/mission.md`
   - `~/.syntaur/missions/<mission-slug>/agent.md`
   - `~/.syntaur/missions/<mission-slug>/claude.md` if it exists
   Note the `workspace` field in `mission.md` frontmatter if present. This indicates which project/codebase grouping the mission belongs to. When writing context to `.syntaur/context.json` (Step 8), include `"workspace": "<value>"` if the mission has a workspace.
3. Discover pending assignments under `~/.syntaur/missions/<mission-slug>/assignments/`.
4. If no assignment slug was provided:
   - list pending assignments with title and priority
   - ask the user to choose unless only one pending assignment exists
5. Claim the assignment:
   - `syntaur assign <assignment-slug> --agent codex --mission <mission-slug>`
   - `syntaur start <assignment-slug> --mission <mission-slug>`
6. Read the full assignment file.
7. If the assignment has no workspace configured, set `workspace.repository` and `workspace.worktreePath` to the current working directory so write boundaries are meaningful.
8. Create `.syntaur/context.json` in the current working directory with:

```json
{
  "missionSlug": "<mission-slug>",
  "assignmentSlug": "<assignment-slug>",
  "missionDir": "/absolute/path/to/mission",
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
   - run `syntaur track-session --mission <mission-slug> --assignment <assignment-slug> --agent codex --session-id <uuid> --path <cwd>`
10. Summarize:
   - assignment slug and title
   - objective
   - acceptance criteria
   - workspace path
11. Suggest next step: `plan-assignment`
