---
name: grab-assignment
description: >-
  Discover and claim a pending Syntaur assignment from a project (or a
  standalone one-off). Use when the user wants to start working on a Syntaur
  assignment, claim a task, or set up their working context.
license: MIT
metadata:
  author: prong-horn
  version: "1.1.0"
---

# Grab Assignment

Claim a pending Syntaur assignment and set up the current workspace.

## Input

Expects up to two arguments from the user:

- First (required): the project slug (e.g., `build-auth-system`), OR `--id <uuid>` to claim a standalone assignment at `~/.syntaur/assignments/<uuid>/`.
- Second (optional, project-nested only): a specific assignment slug to grab. If omitted, list available pending assignments and pick one.

## Pre-flight Check

Check if `.syntaur/context.json` already exists in the current working directory.

- If it exists AND contains BOTH `projectSlug` and `assignmentSlug`, it represents an active assignment. Warn the user: "You already have an active assignment: `<assignmentSlug>` in project `<projectSlug>`. Grabbing a new one will replace this context. Proceed?" — stop if the user says no.
- If it exists but only has session fields (`sessionId`, `transcriptPath`) and no project/assignment, it was populated by the platform's SessionStart hook (Claude Code, etc.) and does NOT represent an active assignment. Proceed silently and merge assignment fields on top in Step 5.

## Step 1: Discover the Project (project-nested path)

For a project-nested grab, read the project entry files:

- `~/.syntaur/projects/<project-slug>/manifest.md`
- `~/.syntaur/projects/<project-slug>/project.md`

Note the `workspace` field in `project.md` frontmatter if present. Per-project `agent.md` / `claude.md` were removed in protocol v2.0 — repo-level `CLAUDE.md` / `AGENTS.md` and user playbooks under `~/.syntaur/playbooks/` take their place. Step 7 loads playbooks.

For a standalone grab (`--id <uuid>`), skip this step — there is no parent project.

## Step 2: Find Assignments

List assignment directories:

- Project-nested: `~/.syntaur/projects/<project-slug>/assignments/`
- Standalone: the single directory at `~/.syntaur/assignments/<uuid>/`

Do NOT filter by status — every assignment is grabbable. If a slug was provided, verify the directory exists. If no specific assignment was requested, read each `assignment.md` frontmatter and present the list with title, priority, and current status (highlighting `pending` as the likely default). Ask the user to choose unless there is exactly one obvious candidate.

## Step 3: Claim the Assignment

```bash
# Always safe at any status; does not transition state:
syntaur assign <assignment-slug> --agent <your-agent-name> --project <project-slug>
```

If the current status is `pending`, also run:

```bash
syntaur start <assignment-slug> --project <project-slug>
```

Skip `start` for any non-`pending` status — grabbing must never rewind a `review`, `completed`, or `failed` assignment.

> **Agent identity:** Use an identifier for your agent platform — e.g., `claude`, `cursor`, `codex`, `opencode`.

If either command fails, report the error and stop.

## Step 4: Read Assignment Context and Backfill Workspace

Read the full assignment file. Also read `comments.md` if present (inherited questions / notes). For each `dependsOn` entry, read the dependency's `handoff.md` AND `decision-record.md` so upstream decisions carry forward.

From the assignment frontmatter extract: `title`, `workspace.repository`, `workspace.worktreePath`, `workspace.branch`, `dependsOn`, `priority`.

If `workspace.repository` and `workspace.worktreePath` are both null, set them to the current working directory. Write boundaries use this path, so it must never be null while an agent is writing code.

## Step 5: Create or Merge Context File

Merge assignment context into `.syntaur/context.json`. Never overwrite — if the file already exists (e.g., platform SessionStart hook populated `sessionId` / `transcriptPath`), preserve those fields.

```bash
mkdir -p .syntaur
```

Prepare the assignment payload:

```json
{
  "projectSlug": "<project-slug or null for standalone>",
  "assignmentSlug": "<assignment-slug>",
  "projectDir": "/absolute/path/to/project or null",
  "assignmentDir": "/absolute/path/to/assignment",
  "workspaceRoot": "<workspace path or current working directory>",
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

Use absolute paths (expand `~` to the home directory). If `workspace.repository` is a remote URL (e.g. `https://github.com/...`), set `workspaceRoot` to the current working directory instead.

## Step 6: Register Agent Session (real IDs only — no UUIDs)

`syntaur track-session` requires a `--session-id` from the agent runtime. Synthetic UUIDs are rejected. Source the real id in this order:

1. If `.syntaur/context.json` already has `sessionId` (platform SessionStart hook populated it), use it and the companion `transcriptPath` if present.
2. Otherwise, fall back to the per-agent lookup:
   - **Claude Code**: the most-recently-modified `~/.claude/sessions/*.json` whose `cwd` matches `$(pwd)` — read its `sessionId`. The transcript path is `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (omit if the file is absent).
   - **Codex**: the most-recently-modified file under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` whose first-line `session_meta.payload.cwd` matches `$(pwd)`. Use `payload.id` as the session id and the full rollout path as the transcript path.
   - **Other agents**: use whatever real session identifier the runtime exposes. Do not invent one.
3. If no real id can be resolved, stop and tell the user to restart the session so the platform hook can populate it, or to run `/rename <assignment-slug>` (Claude Code) and retry.

After resolving, merge `sessionId` + `transcriptPath` back into context.json. Then register:

```bash
syntaur track-session \
  --project <project-slug> --assignment <assignment-slug> \
  --agent <your-agent-name> \
  --session-id <real-id> \
  --transcript-path <path-if-known> \
  --path $(pwd)
```

Omit `--transcript-path` entirely (don't pass an empty string) if no transcript path was resolved.

## Step 7: Load Playbooks

Read all playbook files from `~/.syntaur/playbooks/` and treat their content as active behavioral rules:

```bash
ls ~/.syntaur/playbooks/*.md 2>/dev/null
```

For each file, read it and follow its directives. Playbooks take precedence over default conventions when they conflict.

## Step 8: Report to User

Summarize:
- Which assignment was grabbed (slug + title). Note if it was standalone (folder is the UUID, `slug` display-only).
- Current status (call it out explicitly if the assignment was already past `pending`).
- The objective (first paragraph from assignment.md body).
- The acceptance criteria (checkbox list).
- Active todos from `## Todos`, including any linked plan files.
- The workspace path.
- Any inherited comments/questions from `comments.md`.
- Suggested next step: `plan-assignment` to create an implementation plan.
