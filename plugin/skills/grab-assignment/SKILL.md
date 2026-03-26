---
name: grab-assignment
description: Discover and claim a pending Syntaur assignment from a mission
argument-hint: <mission-slug> [assignment-slug]
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# Grab Assignment

Claim a pending assignment from a Syntaur mission and set up your working context.

## Arguments

The user provided: $ARGUMENTS

Parse the arguments:
- First argument (required): the mission slug (e.g., `build-auth-system`)
- Second argument (optional): a specific assignment slug to grab. If omitted, you will list pending assignments and pick one.

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

## Step 2: Find Pending Assignments

List assignment directories and check their status:

```bash
ls ~/.syntaur/missions/<mission-slug>/assignments/
```

For each assignment directory, read the `assignment.md` frontmatter and look for `status: pending`. You can use grep:

```bash
grep -l "status: pending" ~/.syntaur/missions/<mission-slug>/assignments/*/assignment.md
```

If no pending assignments exist, tell the user and stop.

If the user specified an assignment slug as the second argument, verify it exists and is pending. If it is not pending, report its current status and stop.

If no specific assignment was requested, present the list of pending assignments with their titles and priorities, and ask the user which one to grab. If there is only one pending assignment, grab it automatically.

## Step 3: Claim the Assignment

Run the Syntaur CLI commands to assign and start the assignment. Use `dangerouslyDisableSandbox: true` for these bash commands since the CLI writes to `~/.syntaur/` which is outside the project sandbox.

```bash
syntaur assign <assignment-slug> --agent claude --mission <mission-slug>
```

Then:

```bash
syntaur start <assignment-slug> --mission <mission-slug>
```

If either command fails, report the error and stop. Common failures:
- Assignment has unmet dependencies (cannot start until dependencies are `completed`)
- Assignment is not in `pending` status
- Mission not found

## Step 4: Read Assignment Context and Set Workspace

After successfully starting the assignment, read the full assignment details:

```bash
cat ~/.syntaur/missions/<mission-slug>/assignments/<assignment-slug>/assignment.md
```

Extract from the frontmatter:
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

1. Generate a session ID:
```bash
python3 -c "import uuid; print(uuid.uuid4())"
```

2. Run the track-session command (use `dangerouslyDisableSandbox: true` since it writes to `~/.syntaur/`):
```bash
syntaur track-session --mission <missionSlug> --assignment <assignmentSlug> --agent claude --session-id <generated-id> --path $(pwd)
```

3. Update the `.syntaur/context.json` context file to include the session ID. Add `"sessionId": "<generated-id>"` to the JSON object you wrote in Step 5.

4. **Add a session row to the assignment's Sessions table.** Open `<assignmentDir>/assignment.md` and find the `## Sessions` markdown table. Append a new row with the session details:

```markdown
| <session-id> | claude | <ISO 8601 start timestamp> | | active |
```

Leave the "Ended" column empty — it will be filled when the assignment is completed. This is critical: the `track-session` CLI registers the session in the mission-level index, but the assignment's own Sessions table must also be updated so it renders correctly in the dashboard and in the assignment file itself.

## Step 6: Report to User

Summarize what was done:
- Which assignment was grabbed
- The objective (first paragraph from assignment.md body)
- The acceptance criteria (the checkbox list)
- The workspace path (if set)
- Suggest next step: "Run `/plan-assignment` to create an implementation plan."
