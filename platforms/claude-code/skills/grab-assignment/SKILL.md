---
name: grab-assignment
description: Load a Syntaur assignment into the current working context
argument-hint: <mission-slug> [assignment-slug]
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# Grab Assignment

Load a Syntaur assignment into the current working context so you can work on it.

**Grabbing is non-destructive.** It never fails because of status. An assignment in `pending`, `in_progress`, `blocked`, `review`, `completed`, or `failed` can all be grabbed — grabbing just sets up context (`.syntaur/context.json`), registers the session, and reads the assignment. Only a `pending` assignment will additionally be transitioned to `in_progress`; any other status is left untouched.

## Arguments

The user provided: $ARGUMENTS

Parse the arguments:
- First argument (required): the mission slug (e.g., `build-auth-system`)
- Second argument (optional): a specific assignment slug to grab. If omitted, you will list the mission's assignments and pick one (preferring `pending` when multiple exist).

## Pre-flight Check

1. Check if `.syntaur/context.json` already exists in the current working directory.
   - If it exists, read it and warn the user: "You already have an active assignment: `<assignmentSlug>` in mission `<missionSlug>`. Grabbing a new assignment will replace this context. Proceed?"
   - If the user says no, stop.

## Step 1: Discover the Mission

Read the mission directory to understand what is available:

```bash
ls ~/.syntaur/missions/<mission-slug>/
```

Read the mission files, starting with the manifest (the protocol-defined entry point):
- Read `~/.syntaur/missions/<mission-slug>/manifest.md` first (root navigation file per protocol spec)
- Read `~/.syntaur/missions/<mission-slug>/mission.md` for goal and context
- Read `~/.syntaur/missions/<mission-slug>/agent.md` for agent instructions
- Read `~/.syntaur/missions/<mission-slug>/claude.md` if it exists for Claude-specific instructions

Note the `workspace` field in `mission.md` frontmatter if present. This indicates which project/codebase grouping the mission belongs to. When writing context to `.syntaur/context.json` (Step 5), include `"workspace": "<value>"` if the mission has a workspace.

## Step 2: Find Assignments

List assignment directories:

```bash
ls ~/.syntaur/missions/<mission-slug>/assignments/
```

If the user specified an assignment slug as the second argument, verify that directory exists. Its status does **not** matter — grab it regardless. If it doesn't exist, report that and stop.

If no specific assignment was requested, read each `assignment.md` frontmatter and present the list with title, priority, and current status. Prefer `pending` assignments when presenting options (they're the most likely default), but show non-terminal assignments too so the user can pick one to resume. Ask the user which to grab unless there is exactly one obvious candidate (single `pending` assignment).

## Step 3: Claim the Assignment

Read the assignment frontmatter first to learn its current `status`:

```bash
cat ~/.syntaur/missions/<mission-slug>/assignments/<assignment-slug>/assignment.md
```

Then run the Syntaur CLI to set the assignee. This is safe at any status and does not transition state. Use `dangerouslyDisableSandbox: true` for these bash commands since the CLI writes to `~/.syntaur/` which is outside the project sandbox.

```bash
syntaur assign <assignment-slug> --agent claude --mission <mission-slug>
```

**Only if the current status is `pending`**, also run `syntaur start` to transition it to `in_progress`:

```bash
syntaur start <assignment-slug> --mission <mission-slug>
```

For any other status (`in_progress`, `blocked`, `review`, `completed`, `failed`), **skip `syntaur start`** — the assignment has already been advanced past pending and grabbing should not rewind it. Tell the user which status the assignment is in and continue with context setup.

If `syntaur assign` fails (e.g., mission not found, invalid slug), report the error and stop. Do not treat a non-pending status as a failure.

## Step 4: Read Assignment Context and Set Workspace

You have already read the assignment file in Step 3. Extract from the frontmatter:
- `title` -- the assignment title
- `workspace.repository` -- the code repository path (may be null)
- `workspace.worktreePath` -- the worktree path (may be null)
- `workspace.branch` -- the branch name (may be null)
- `dependsOn` -- list of dependency slugs
- `priority` -- priority level

Read the objective and acceptance criteria from the markdown body.

### Set workspace if not configured

If `workspace.repository` and `workspace.worktreePath` are both null, set them to the current working directory (`$(pwd)`). This is critical because the write boundary hook uses the workspace path to determine which files the agent is allowed to edit. Without it, all code edits outside the assignment directory will be blocked.

Use the Edit tool to update the assignment.md frontmatter:
```yaml
workspace:
  repository: /absolute/path/to/cwd
  worktreePath: /absolute/path/to/cwd
```

## Step 5: Create Context File

Write `.syntaur/context.json` in the current working directory with the assignment context. First ensure the directory exists:

```bash
mkdir -p .syntaur
```

Then write the JSON file with this structure:

```json
{
  "missionSlug": "<mission-slug>",
  "assignmentSlug": "<assignment-slug>",
  "missionDir": "/Users/<username>/.syntaur/missions/<mission-slug>",
  "assignmentDir": "/Users/<username>/.syntaur/missions/<mission-slug>/assignments/<assignment-slug>",
  "workspaceRoot": "<workspace.worktreePath if set, else workspace.repository if it is a local path, else current working directory>",
  "title": "<assignment title>",
  "branch": "<workspace.branch or null>",
  "grabbedAt": "<ISO 8601 timestamp>"
}
```

Use absolute paths (expand `~` to the actual home directory). Note: `workspace.repository` may be a remote URL (e.g., `https://github.com/...`) -- only use it as `workspaceRoot` if it starts with `/` (local path). If it is a URL, set `workspaceRoot` to the current working directory.

**IMPORTANT:** The `workspaceRoot` must NEVER be null when the agent will be writing code. If no workspace was configured, default to the current working directory.

## Step 5.5: Register Agent Session

After creating the context file, register this session in the mission's agent session log so it appears in the dashboard.

1. Find the current Claude Code session ID by reading from `~/.claude/sessions/`. These are JSON files keyed by PID containing `sessionId`, `cwd`, etc. Find the most recently modified file whose `cwd` matches the current working directory:
```bash
ls -t ~/.claude/sessions/*.json | head -5
```
Read the most recent file(s) and find the one whose `cwd` matches `$(pwd)`. Extract the `sessionId` field — this is the real Claude Code session ID that can be used with `claude --resume <sessionId>` to resume this exact conversation.

If you cannot find a matching session file (e.g., no file matches the cwd, or the sessions directory is empty), ask the user to run `/rename <assignment-slug>` to name the current session after the assignment. Then store the assignment slug as the session name in context.json (`"sessionName": "<assignment-slug>"`) instead of `sessionId`. The user can later resume with `claude --resume <assignment-slug>`.

2. Run the track-session command (use `dangerouslyDisableSandbox: true` since it writes to `~/.syntaur/`):
```bash
syntaur track-session --mission <missionSlug> --assignment <assignmentSlug> --agent claude --session-id <claude-session-id> --path $(pwd)
```

3. Update the `.syntaur/context.json` context file to include the session ID. Add `"sessionId": "<claude-session-id>"` to the JSON object you wrote in Step 5.

## Step 5.6: Load Playbooks

Read all playbook files from `~/.syntaur/playbooks/` and treat their content as active behavioral rules for this assignment:

```bash
ls ~/.syntaur/playbooks/*.md 2>/dev/null
```

For each `.md` file found, read it and internalize the rules in its body section. These are user-defined behavioral policies that you must follow throughout your work on this assignment. Playbooks take precedence over default conventions when they conflict.

If no playbook files exist, skip this step.

## Step 6: Report to User

Summarize what was done:
- Which assignment was grabbed
- Its current status (note if it was already past `pending` — e.g., "already in `review`, status unchanged")
- The objective (first paragraph from assignment.md body)
- The acceptance criteria (the checkbox list)
- The workspace path (if set)
- Suggest an appropriate next step based on status:
  - `pending` / `in_progress`: `/plan-assignment` to plan implementation
  - `blocked`: investigate the blocker recorded in `blockedReason`
  - `review`: inspect the implementation and help verify acceptance criteria
  - `completed` / `failed`: read the handoff; grab is probably for reference or reopen
