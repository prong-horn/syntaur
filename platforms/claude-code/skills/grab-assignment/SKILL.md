---
name: grab-assignment
description: Load a Syntaur assignment into the current working context
argument-hint: <project-slug> [assignment-slug]
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
- First argument (required): the project slug (e.g., `build-auth-system`)
- Second argument (optional): a specific assignment slug to grab. If omitted, you will list the project's assignments and pick one (preferring `pending` when multiple exist).

## Pre-flight Check

1. Check if `.syntaur/context.json` already exists in the current working directory.
   - If it exists AND contains BOTH `projectSlug` and `assignmentSlug`, read it and warn the user: "You already have an active assignment: `<assignmentSlug>` in project `<projectSlug>`. Grabbing a new assignment will replace this context. Proceed?"
   - If the user says no, stop.
   - If the file exists but only has session fields (`sessionId`, `transcriptPath`) and no project/assignment, do NOT warn — that context was populated by the SessionStart hook and is not an "active assignment" marker. Proceed silently and merge new assignment fields in Step 5.

## Step 1: Discover the Project

Read the project directory to understand what is available:

```bash
ls ~/.syntaur/projects/<project-slug>/
```

Read the project files, starting with the manifest (the protocol-defined entry point):
- Read `~/.syntaur/projects/<project-slug>/manifest.md` first (root navigation file per protocol spec)
- Read `~/.syntaur/projects/<project-slug>/project.md` for goal and context
- Read `~/.syntaur/projects/<project-slug>/agent.md` for agent instructions
- Read `~/.syntaur/projects/<project-slug>/claude.md` if it exists for Claude-specific instructions

Note the `workspace` field in `project.md` frontmatter if present. This indicates which project/codebase grouping the project belongs to. When writing context to `.syntaur/context.json` (Step 5), include `"workspace": "<value>"` if the project has a workspace.

## Step 2: Find Assignments

List assignment directories:

```bash
ls ~/.syntaur/projects/<project-slug>/assignments/
```

If the user specified an assignment slug as the second argument, verify that directory exists. Its status does **not** matter — grab it regardless. If it doesn't exist, report that and stop.

If no specific assignment was requested, read each `assignment.md` frontmatter and present the list with title, priority, and current status. Prefer `pending` assignments when presenting options (they're the most likely default), but show non-terminal assignments too so the user can pick one to resume. Ask the user which to grab unless there is exactly one obvious candidate (single `pending` assignment).

## Step 3: Claim the Assignment

Read the assignment frontmatter first to learn its current `status`:

```bash
cat ~/.syntaur/projects/<project-slug>/assignments/<assignment-slug>/assignment.md
```

Then run the Syntaur CLI to set the assignee. This is safe at any status and does not transition state. Use `dangerouslyDisableSandbox: true` for these bash commands since the CLI writes to `~/.syntaur/` which is outside the project sandbox.

```bash
syntaur assign <assignment-slug> --agent claude --project <project-slug>
```

**Only if the current status is `pending`**, also run `syntaur start` to transition it to `in_progress`:

```bash
syntaur start <assignment-slug> --project <project-slug>
```

For any other status (`in_progress`, `blocked`, `review`, `completed`, `failed`), **skip `syntaur start`** — the assignment has already been advanced past pending and grabbing should not rewind it. Tell the user which status the assignment is in and continue with context setup.

If `syntaur assign` fails (e.g., project not found, invalid slug), report the error and stop. Do not treat a non-pending status as a failure.

## Step 4: Read Assignment Context and Set Workspace

You have already read the assignment file in Step 3. Extract from the frontmatter:
- `title` -- the assignment title
- `workspace.repository` -- the code repository path (may be null)
- `workspace.worktreePath` -- the worktree path (may be null)
- `workspace.branch` -- the branch name (may be null)
- `dependsOn` -- list of dependency slugs
- `priority` -- priority level

Read the objective, acceptance criteria, and the `## Todos` section (if present) from the markdown body. Active (unchecked) todos indicate outstanding work and may link to plan files to execute.

### Auto-load upstream decision records

If `dependsOn` is non-empty, for each dependency slug `<dep>`, read:
- `<projectDir>/assignments/<dep>/handoff.md` (if it exists) for integration context
- `<projectDir>/assignments/<dep>/decision-record.md` (if it exists) for upstream decisions

Surface those upstream decisions in the Step 6 report — downstream work should inherit prior decisions without the user having to ask.

### Set workspace if not configured

If `workspace.repository` and `workspace.worktreePath` are both null, set them to the current working directory (`$(pwd)`). This is critical because the write boundary hook uses the workspace path to determine which files the agent is allowed to edit. Without it, all code edits outside the assignment directory will be blocked.

Use the Edit tool to update the assignment.md frontmatter:
```yaml
workspace:
  repository: /absolute/path/to/cwd
  worktreePath: /absolute/path/to/cwd
```

## Step 5: Create or Merge Context File

Merge assignment context into `.syntaur/context.json`. Do NOT overwrite: if the file already exists (e.g., the SessionStart hook populated `sessionId` + `transcriptPath`), preserve those fields.

First ensure the directory exists:

```bash
mkdir -p .syntaur
```

Prepare the assignment payload:

```json
{
  "projectSlug": "<project-slug>",
  "assignmentSlug": "<assignment-slug>",
  "projectDir": "/Users/<username>/.syntaur/projects/<project-slug>",
  "assignmentDir": "/Users/<username>/.syntaur/projects/<project-slug>/assignments/<assignment-slug>",
  "workspaceRoot": "<workspace.worktreePath if set, else workspace.repository if it is a local path, else current working directory>",
  "title": "<assignment title>",
  "branch": "<workspace.branch or null>",
  "grabbedAt": "<ISO 8601 timestamp>"
}
```

Merge it on top of whatever context.json already contains:

```bash
if [ -f .syntaur/context.json ]; then
  jq --slurpfile new <(echo "$NEW_CONTEXT_JSON") '. + $new[0]' .syntaur/context.json > .syntaur/context.json.tmp \
    && mv .syntaur/context.json.tmp .syntaur/context.json
else
  echo "$NEW_CONTEXT_JSON" > .syntaur/context.json
fi
```

This preserves any `sessionId` / `transcriptPath` the SessionStart hook wrote, while layering assignment fields on top.

Use absolute paths (expand `~` to the actual home directory). Note: `workspace.repository` may be a remote URL (e.g., `https://github.com/...`) -- only use it as `workspaceRoot` if it starts with `/` (local path). If it is a URL, set `workspaceRoot` to the current working directory.

**IMPORTANT:** The `workspaceRoot` must NEVER be null when the agent will be writing code. If no workspace was configured, default to the current working directory.

## Step 5.5: Register Agent Session

After merging context, register this session in the dashboard.

1. **Source the real Claude session_id + transcript_path.** In priority order:
   1. If `.syntaur/context.json` already has `sessionId` (SessionStart hook populated it), use that ID and read `transcriptPath` from the same file.
   2. Otherwise, fall back to `~/.claude/sessions/*.json`: `ls -t ~/.claude/sessions/*.json | head -5`, read each, and pick the most recently modified entry whose `cwd` matches `$(pwd)`. Extract `sessionId`. The transcript path for Claude Code lives at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — construct that path if you need it.
   3. If neither source yields a real ID, DO NOT synthesize one. Abort with: "Could not resolve a real Claude Code session id. Restart the Claude session so the SessionStart hook can populate `.syntaur/context.json`, or run `/rename <assignment-slug>` and retry."

2. **Merge `sessionId` and `transcriptPath` back into context.json** (safe even if already present — jq merge is idempotent).

3. **Run the track-session CLI** (use `dangerouslyDisableSandbox: true` since it writes to `~/.syntaur/`). Both `--session-id` and real path are required:
   ```bash
   syntaur track-session --project <projectSlug> --assignment <assignmentSlug> --agent claude --session-id <real-session-id> --transcript-path <transcript-path> --path $(pwd)
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
- Active todos from the `## Todos` section (if any), with links to any referenced plan files
- The workspace path (if set)
- Suggest an appropriate next step based on status:
  - `pending` / `in_progress`: `/plan-assignment` to plan implementation
  - `blocked`: investigate the blocker recorded in `blockedReason`
  - `review`: inspect the implementation and help verify acceptance criteria
  - `completed` / `failed`: read the handoff; grab is probably for reference or reopen
