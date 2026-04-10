---
name: create-mission
description: Create a new Syntaur mission with all scaffolding files (manifest, agent instructions, indexes)
argument-hint: <title> [--slug <slug>] [--dir <path>] [--workspace <workspace>]
allowed-tools:
  - Bash
  - Read
---

# Create Mission

Create a new Syntaur mission from within Claude Code.

## Arguments

The user provided: $ARGUMENTS

Parse the arguments:
- First argument (required): the mission title (e.g., `"Build Auth System"`)
- `--slug` (optional): override the auto-generated slug
- `--dir` (optional): override the default mission directory
- `--workspace` (optional): workspace grouping label (e.g., `syntaur`, `reeva`)

If no title was provided, ask the user what the mission should be called.

## Step 1: Run the CLI

Build the command from the parsed arguments. Use `dangerouslyDisableSandbox: true` since the CLI writes to `~/.syntaur/` which is outside the project sandbox.

```bash
syntaur create-mission "<title>" [--slug <slug>] [--dir <path>] [--workspace <workspace>]
```

If the command fails (e.g., slug collision, empty title), report the error and suggest fixes.

## Step 2: Read the Created Mission

After successful creation, extract the mission slug and directory from the CLI output. Read the generated `mission.md` to confirm the structure:

```bash
cat ~/.syntaur/missions/<slug>/mission.md
```

## Step 3: Guide Next Steps

Tell the user:
- The mission was created with its slug and location
- List the key files created (manifest.md, mission.md, agent.md, claude.md)
- Suggest they edit `mission.md` to fill in the goal, scope, and context sections
- Suggest they edit `agent.md` to set conventions and boundaries for agents
- Suggest running `/create-assignment` to add assignments to this mission
