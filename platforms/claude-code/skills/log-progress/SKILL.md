---
name: log-progress
description: >-
  Append a typed progress entry to the active ticket's log role via
  `syntaur log -t progress` (alias: `syntaur progress log`). Use after every
  meaningful action per the active ticket's stage instructions. Triggers on "log progress", "note progress", "record this in progress", or
  whenever stage instructions say to update records.
license: MIT
metadata:
  author: prong-horn
  version: "2.0.0"
---

# Log Progress

Append a `progress` entry to the active ticket's log-role file (`journal.md` on
modern templates, `progress.md` on `legacy`). CLI-mediated — never edit the log
file directly.

## When NOT to use this skill

- Architecturally significant decisions → `syntaur log -t decision "..."`.
- Baton-pass / completion summary → `syntaur log -t handoff "..."` (see
  `complete-ticket`).
- Questions for the human → `syntaur log -t question "..."`.
- Follow-up ticket ideas → open a new ticket via `create-ticket`.

## Step 1: Verify there is an active ticket

The active ticket resolves from the session's open engagement. `.syntaur/context.json`
is only a workspace marker. With no open engagement, the CLI aborts — run
`grab-ticket` first.

## Step 2: Compose the entry

Concise, factual, link-rich body (the CLI stamps the heading):

- What changed (action verbs).
- Files touched: `path/to/file.ts`, commits, verification commands.

## Step 3: Log via CLI

```bash
syntaur log <ticket-id> -t progress "<body>" [--project <slug>]
```

Alias (same behaviour when the ticket has a log role):

```bash
syntaur progress log "<body>" [--ticket <id> [--project <slug>]]
```

Run `syntaur show` to confirm the log path and **Commands** line.

## Step 4: Report to User

Summarize the log path, one-line summary, and that a `progress` entry was appended.
