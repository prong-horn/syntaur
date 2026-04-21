---
name: track-session
description: Register this Claude Code session as an agent session in the Syntaur dashboard
arguments:
  - name: args
    description: "Optional flags: --description, --project, --assignment"
    required: false
---

# /track-session

Register the current Claude Code session as an agent session in the Syntaur dashboard. Works standalone or linked to a project/assignment.

Only real Claude Code session IDs are accepted — no synthesis. The real id is written to `.syntaur/context.json` by the SessionStart hook, with `~/.claude/sessions/<pid>.json` as the fallback source.

## Usage

- `/track-session` — register a standalone session
- `/track-session --description "exploring auth patterns"` — with a description
- `/track-session --project <slug> --assignment <slug>` — linked to a project
- `/track-session --description "auth work" --project <slug> --assignment <slug>` — both

## Instructions

When the user runs this command:

### Step 1: Parse arguments

Extract optional flags from the argument string:
- `--description "<text>"` or `--description <text>` — session description
- `--project <slug>` — project to link to
- `--assignment <slug>` — assignment to link to

### Step 2: Source the real session id + transcript path

In priority order:

1. Read `.syntaur/context.json` if present. If it contains `sessionId`, use it. Also pick up `transcriptPath` if present.
2. Otherwise, read the most-recently-modified file under `~/.claude/sessions/*.json` whose `cwd` matches `$(pwd)` and use its `sessionId` field. The transcript path is conventionally `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`; include it if the file exists, otherwise omit.
3. If neither source yields an id, abort with: "Could not resolve a real Claude Code session id. Restart the Claude session so the SessionStart hook can populate `.syntaur/context.json`, or run `/rename <slug>` then try again."

DO NOT generate a UUID. `syntaur track-session` rejects missing session IDs.

### Step 3: Run the CLI command

Run the track-session CLI via Bash (use `dangerouslyDisableSandbox: true` since it writes to `~/.syntaur/`):

```bash
syntaur track-session \
  --agent claude \
  --session-id "$SESSION_ID" \
  --transcript-path "$TRANSCRIPT_PATH" \
  --path "$(pwd)" \
  [--description "<text>"] \
  [--project <slug>] \
  [--assignment <slug>]
```

Omit `--transcript-path` entirely (don't pass an empty string) if no transcript path could be resolved.

The CLI prints one of:
- `Registered standalone agent session <sessionId>.`
- `Registered agent session <sessionId> for <assignment> in <project>.`

Registration is idempotent — re-running the command with the same session id safely upserts project/assignment/description onto the existing row.

### Step 4: Merge context.json

Ensure `.syntaur/context.json` has the session fields (so SessionEnd and future `/track-session` runs find them). Merge, don't overwrite:

```bash
mkdir -p .syntaur
if [ -f .syntaur/context.json ]; then
  jq --arg sid "$SESSION_ID" --arg tp "$TRANSCRIPT_PATH" \
    '. + {sessionId: $sid} + (if ($tp | length) > 0 then {transcriptPath: $tp} else {} end)' \
    .syntaur/context.json > .syntaur/context.json.tmp \
    && mv .syntaur/context.json.tmp .syntaur/context.json
else
  jq -n --arg sid "$SESSION_ID" --arg tp "$TRANSCRIPT_PATH" \
    '{sessionId: $sid} + (if ($tp | length) > 0 then {transcriptPath: $tp} else {} end)' \
    > .syntaur/context.json
fi
```

### Step 5: Confirm

Tell the user:
- The session was registered (include the short session id).
- It will be auto-stopped when this conversation ends via the SessionEnd hook.
- If linked to a project, mention which project/assignment.
