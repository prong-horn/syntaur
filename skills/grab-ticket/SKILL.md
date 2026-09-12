---
name: grab-ticket
description: >-
  Discover and claim a pending Syntaur ticket from a project (or a
  standalone one-off). Use when the user wants to start working on a Syntaur
  ticket, claim a task, or set up their working context.
license: MIT
metadata:
  author: prong-horn
  version: "1.1.0"
---

# Grab Ticket

Claim a pending Syntaur ticket and set up the current workspace.

## Input

Expects up to two arguments from the user:

- First (required): the project slug (e.g., `build-auth-system`), OR `--id <uuid>` to claim a standalone ticket at `~/.syntaur/tickets/<uuid>/`.
- Second (optional, project-nested only): a specific ticket slug to grab. If omitted, list available pending tickets and pick one.

## Pre-flight Check

`.syntaur/context.json` is a WORKSPACE MARKER (repository/branch/worktree/workspaceRoot plus legacy session fields) — it is NOT the active-ticket source of truth. The active ticket binds via the session's open engagement (established by `track-session` in Step 6).

Check whether this session already has an open engagement — i.e., a different ticket is already active:

```bash
syntaur session resume --json 2>/dev/null
```

- If it reports an active ticket, warn the user: "You already have an active ticket: `<ticketSlug>` in project `<projectSlug>`. Grabbing t new one will rebind this session. Proceed?" — stop if the user says no.
- If there is no open engagement (no active ticket), proceed. A `.syntaur/context.json` that holds only workspace-marker / session fields is expected — it does not represent an active ticket.

## Step 1: Discover the Project (project-nested path)

For a project-nested grab, read the project entry files:

- `~/.syntaur/projects/<project-slug>/manifest.md`
- `~/.syntaur/projects/<project-slug>/project.md`

Note the `workspace` field in `project.md` frontmatter if present. Per-project `agent.md` / `claude.md` were removed in protocol v2.0 — repo-level `CLAUDE.md` / `AGENTS.md` and user playbooks under `~/.syntaur/playbooks/` take their place. Step 7 loads playbooks.

For a standalone grab (`--id <uuid>`), skip this step — there is no parent project.

## Step 2: Find Tickets

List ticket directories:

- Project-nested: `~/.syntaur/projects/<project-slug>/tickets/`
- Standalone: the single directory at `~/.syntaur/tickets/<uuid>/`

Do NOT filter by status — every ticket is grabbable. If a slug was provided, verify the directory exists. If no specific ticket was requested, read each `ticket.md` frontmatter and present the list with title, priority, and current status (highlighting `pending` as the likely default). Ask the user to choose unless there is exactly one obvious candidate.

## Step 3: Claim the Ticket

```bash
# Always safe at any status; does not transition state:
syntaur assign <ticket-slug> --agent <your-agent-name> --project <project-slug>
```

If the current status is `pending`, also run:

```bash
syntaur start <ticket-slug> --project <project-slug>
```

Skip `start` for any non-`pending` status — grabbing must never rewind a `review`, `completed`, or `failed` ticket.

> **Agent identity:** Use an identifier for your agent platform — e.g., `claude`, `cursor`, `codex`, `opencode`.

If either command fails, report the error and stop.

## Step 4: Read Ticket Context and Backfill Workspace

Read the full ticket file. Also read `comments.md` if present (inherited questions / notes). For each `dependsOn` entry, read the dependency's `handoff.md` AND `decision-record.md` so upstream decisions carry forward.

From the ticket frontmatter extract: `title`, `workspace.repository`, `workspace.worktreePath`, `workspace.branch`, `dependsOn`, `priority`.

If `workspace.repository` and `workspace.worktreePath` are both null, set them to the current working directory. Write boundaries use this path, so it must never be null while an agent is writing code.

## Step 5: Create or Merge the Workspace Marker

`.syntaur/context.json` is a WORKSPACE MARKER — it records the repository/branch/worktree so tooling can recognize this directory as a Syntaur workspace. It is NOT the active-ticket source of truth: the ticket binds via the session's open engagement (Step 6, `track-session`). Do NOT write `projectSlug` / `ticketSlug` / `ticketDir` / `projectDir` / `title` — those scalars are non-authoritative.

Merge workspace markers into `.syntaur/context.json`. Never overwrite — if the file already exists (e.g., platform SessionStart hook populated `sessionId` / `transcriptPath`), preserve those fields.

```bash
mkdir -p .syntaur
```

Prepare the workspace-marker payload:

```json
{
  "repository": "<workspace.repository or null>",
  "branch": "<workspace.branch or null>",
  "worktreePath": "<workspace.worktreePath or null>",
  "workspaceRoot": "<workspace path or current working directory>",
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

`syntaur track-session` requires a `--session-id` from the agent runtime. Synthetic UUIDs are rejected. Source the real per-process id in this order:

1. Prefer the env var your runtime injects: `$CLAUDE_CODE_SESSION_ID` (or the peer `OPENCODE_SESSION_ID` / `PI_SESSION_ID`).
2. Otherwise, fall back to the per-agent lookup:
   - **Claude Code**: the most-recently-modified `~/.claude/sessions/<pid>.json` whose `cwd` matches `$(pwd)` — read its `sessionId`. The transcript path is `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (omit if the file is absent).
   - **Codex**: the most-recently-modified file under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` whose first-line `session_meta.payload.cwd` matches `$(pwd)`. Use `payload.id` as the session id and the full rollout path as the transcript path.
   - **Other agents**: use whatever real session identifier the runtime exposes. Do not invent one.
3. Only as a last resort, fall back to the `sessionId` scalar already in `.syntaur/context.json` (and the companion `transcriptPath` if present). That scalar is a shared, legacy hint a co-tenant sharing this workspace can clobber — never treat it as authoritative.
4. If no real id can be resolved, stop and tell the user to restart the session so the platform hook can populate it, or to run `/rename <ticket-slug>` (Claude Code) and retry.

After resolving, merge `sessionId` + `transcriptPath` back into context.json. Then register:

```bash
syntaur track-session \
  --project <project-slug> --ticket <ticket-slug> \
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
- Which ticket was grabbed (slug + title). Note if it was standalone (folder is the UUID, `slug` display-only).
- Current status (call it out explicitly if the ticket was already past `pending`).
- The objective (first paragraph from ticket.md body).
- The acceptance criteria (checkbox list).
- The workspace path.
- Any inherited comments/questions from `comments.md`.
- Suggested next step: `plan-ticket` to create an implementation plan.
