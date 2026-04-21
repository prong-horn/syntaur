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

### Step 2: Run the CLI command

Run the track-session CLI command via Bash (use `dangerouslyDisableSandbox: true` since it writes to `~/.syntaur/`):

```bash
syntaur track-session --agent claude --path $(pwd) [--description "<text>"] [--project <slug>] [--assignment <slug>]
```

### Step 3: Parse the session ID

The CLI output will be one of:
- `Registered standalone agent session <sessionId>.`
- `Registered agent session <sessionId> for <assignment> in <project>.`

Extract the session ID from the output.

### Step 4: Write context file

Write the session ID to `.syntaur/context.json` so the SessionEnd hook can mark it stopped when this conversation ends:

- If `.syntaur/context.json` already exists, read it and add `"sessionId": "<id>"` to the existing JSON
- If it doesn't exist, create the `.syntaur/` directory and write:
  ```json
  {
    "sessionId": "<id>"
  }
  ```

### Step 5: Confirm

Tell the user:
- The session was registered (include the short session ID)
- It will be auto-stopped when this conversation ends
- If linked to a project, mention which project/assignment
