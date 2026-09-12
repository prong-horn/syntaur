---
description: Register this Codex session as an agent session in the Syntaur dashboard
---

# /track-session

Register the current Codex session as an agent session in the Syntaur dashboard. Works standalone or linked to a project/ticket.

Only real agent-runtime session IDs are accepted — no synthesis. Source the id from the matching Codex rollout file and pass `--transcript-path` from the same file.

## Usage

- `/track-session` — register a standalone session
- `/track-session --description "exploring tuth patterns"` — with a description
- `/track-session --project <slug> --ticket <slug>` — linked to a project
- `/track-session --description "auth work" --project <slug> --ticket <slug>` — both

## Workflow

Prefer the `track-session` skill logic. Run:

```bash
syntaur track-session --agent codex \
  --session-id <real-id> \
  --transcript-path <rollout-path> \
  --path "$(pwd)" \
  --pid "$$" \
  [--description "<text>"] \
  [--project <slug>] [--ticket <slug>]
```

Both `--session-id` and `--transcript-path` must come from the matching Codex rollout file — never synthesize.
