---
name: log-progress
description: >-
  Append a timestamped entry to the active assignment's `progress.md`,
  bumping `entryCount` and `updated` in its frontmatter. Use after every
  meaningful action — completing an acceptance criterion, finishing a plan
  task, hitting a blocker, deciding on an approach — per the Keep Records
  Updated playbook. Triggers on "log progress", "note progress", "record
  this in progress", or whenever the playbook says to update records.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Log Progress

Append a structured timestamped entry to the active assignment's
`<assignmentDir>/progress.md`, and update its frontmatter. CLI-mediated via
`syntaur progress log "<text>"` — the command stamps the timestamp, inserts the
entry reverse-chronologically (newest right after the `# Progress` H1), replaces
the `No progress yet.` placeholder, bumps `entryCount` + `updated`, and preserves
the `assignment`/`generated` frontmatter. Re-running with the same body produces a
duplicate entry, which is intentional (timestamps differ).

This skill implements the **Keep Records Updated** playbook: agents must keep
records current in real-time, especially after every meaningful action.

## When NOT to use this skill

- The action belongs in `decision-record.md` (architecturally significant
  decisions with rationale) — write to that file, not progress.md.
- The information is for the next session of the SAME assignment — that's
  `/save-session-summary`.
- The information is a question for the user — write to `comments.md` via
  `syntaur comment` (CLI-mediated).
- The information is a follow-up assignment idea — open a new assignment
  via `/create-assignment`.

## Step 1: Verify there is an active assignment

The active assignment is resolved from the session's open engagement — `syntaur
progress log` (Step 3) targets it automatically. `.syntaur/context.json` is only
a workspace marker; do not read the assignment from it. If there is no open
engagement (no active assignment), the CLI aborts with "No active assignment for
this session — grab one first." Run `grab-assignment` first.

## Step 2: Compose the entry

The entry should be concise, factual, and link-rich. Suggested structure:

```markdown
## <ISO 8601 UTC timestamp> — <one-line summary>

- What changed (action verbs).
- Files touched: `path/to/file.ts:line`, `another.ts`.
- Commits: `<short-sha>` (one per logical change).
- Verification: `npm test src/...`, `node dist/index.js x --help`, etc.

Optional notes paragraph.
```

The CLI stamps the ISO 8601 `Z` timestamp for you. Use absolute file paths or
repo-relative paths consistently in the body.

## Step 3: Log the entry via the CLI

Run:

```bash
syntaur progress log "<your composed entry body>"
```

The command resolves the active assignment from the session's open engagement
(or pass `--assignment <slug> [--project <slug>]` to target one explicitly),
then atomically:

- Inserts the entry immediately after the `# Progress` H1 (newest first,
  reverse-chronological), replacing the `No progress yet.` placeholder on the
  first real entry.
- Increments `entryCount` and bumps `updated`, preserving `assignment` and
  `generated`.

Quote the body so the shell passes it as a single argument. Multi-line bodies
are fine inside the quotes. The resulting layout is:

```markdown
# Progress

## <new ISO timestamp>

<new entry body>

## <prior ISO timestamp>

<prior entry body>
```

> **Why the CLI:** the insert/ordering/`entryCount`/placeholder rules used to be
> hand-applied (and easy to get subtly wrong). `syntaur progress log` is the
> single, validated writer — the dashboard and downstream readers expect the
> most recent entry first, the convention documented in
> `~/.syntaur/playbooks/keep-records-updated.md`.

## Step 4: Report to User

Summarize:

- Path of the modified `progress.md`.
- New `entryCount`.
- One-line summary of the entry that was logged.
