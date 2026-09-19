---
name: grab-ticket
description: >-
  Discover and claim a backlog Syntaur ticket by id. Use when the user wants to start working on a Syntaur
  ticket, claim a task, or set up their working context.
license: MIT
metadata:
  author: prong-horn
  version: "1.2.0"
---

# Grab Ticket

Claim a Syntaur ticket and set up the current workspace.

## Input

Expects up to two arguments from the user:

- First (required): the project slug (e.g., `build-auth-system`), or a ticket id (`<PREFIX>-<n>`) when globally unique.
- Second (optional): a specific ticket id or slug to grab. If omitted, list available tickets and pick one.

## Pre-flight Check

`.syntaur/context.json` is a WORKSPACE MARKER — it is NOT the active-ticket source of truth. The active ticket binds via the session's open engagement (established by `track-session` in Step 6).

Check whether this session already has an open engagement:

```bash
syntaur session resume --json 2>/dev/null
```

- If it reports an active ticket, warn the user: "You already have an active ticket: `<ticketId>` in project `<projectSlug>`. Grabbing a new one will rebind this session. Proceed?" — stop if the user says no.
- If there is no open engagement, proceed.

## Step 1: Discover the Project

Read the project entry files:

- `~/.syntaur/projects/<project-slug>/manifest.md`
- `~/.syntaur/projects/<project-slug>/project.md`

Repo-level `CLAUDE.md` / `AGENTS.md` provide agent conventions. Cross-template
playbooks are injected by the prompt hook when enabled.

## Step 2: Find Tickets

List ticket directories under `~/.syntaur/projects/<project-slug>/tickets/`.

If a ticket id was provided, verify the folder exists. Otherwise, read each `ticket.md` frontmatter and present the list with title, priority, stage, and flags. Highlight `backlog` tickets as the likely default.

## Step 3: Claim the Ticket

```bash
syntaur assign <ticket-id> --agent <your-agent-name> --project <project-slug>
```

If the current stage is `backlog` or `ready` (pre-`in_progress`), also run:

```bash
syntaur start <ticket-id> --project <project-slug>
```

Optional one-use dispatch recipient on start (not audit attribution):

```bash
syntaur start <ticket-id> --project <project-slug> --agent <agent-id>
```

Use `--by <name>` on lifecycle verbs when you need a specific audit attribution in the event log.

For `planning` stage, run `syntaur plan` first if no plan file exists, then `syntaur approve` and `start` when gates pass. Skip `start` for `in_progress`, `review`, `done`, or `dropped` — grabbing must never rewind terminal or in-flight work.

> **Agent identity:** Use an identifier for your agent platform — e.g., `claude`, `cursor`, `codex`, `opencode`.

If any command fails, report the error and the **Next** hint from `syntaur show`.

## Step 4: Read Ticket Context and Backfill Workspace

Run `syntaur show <ticket-id> --project <project-slug>` for the authoritative file list, stage instructions, and **Next** line.

Read dependency context from tickets listed in `depends_on`.

From the ticket frontmatter extract: `title`, `workspace.repository`, `workspace.worktree`, `workspace.branch`, `depends_on`, `priority`.

If `workspace.repository` and `workspace.worktree` are both null, set them to the current working directory when writing workspace fields.

## Step 5: Create or Merge the Workspace Marker

`.syntaur/context.json` is a WORKSPACE MARKER. Write `ticketId` and `ticketDir` for doctor and the statusline. Do NOT write `projectSlug` / `ticketSlug` / `projectDir` / `title`.

Merge workspace markers into `.syntaur/context.json`. Preserve existing `sessionId` / `transcriptPath` fields.

```json
{
  "repository": "<workspace.repository or null>",
  "branch": "<workspace.branch or null>",
  "worktree": "<workspace.worktree or null>",
  "workspaceRoot": "<workspace path or current working directory>",
  "ticketId": "<ticket id from frontmatter>",
  "ticketDir": "<absolute path to the ticket folder>",
  "grabbedAt": "<ISO 8601 timestamp>"
}
```

## Step 6: Register Agent Session (real IDs only)

Follow the same session-id resolution as the prior skill version, then:

```bash
syntaur track-session \
  --project <project-slug> --ticket <ticket-id> \
  --agent <your-agent-name> \
  --session-id <real-id> \
  --transcript-path <path-if-known> \
  --path $(pwd)
```

## Step 7: Confirm stage context

Run `syntaur show` again and read **Stage**, **Next**, and **Commands** so the
session starts with the template's stage instructions in mind.

## Step 8: Report to User

Summarize:
- Which ticket was grabbed (id + title)
- Current stage and any flags (`blocked`, `parked`)
- The objective and acceptance criteria from `show`
- The workspace path
- Suggested next step from the **Next** line (often `plan-ticket` or implementation)
