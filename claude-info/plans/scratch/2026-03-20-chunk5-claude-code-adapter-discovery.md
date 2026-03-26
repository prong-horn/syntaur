# Chunk 5: Claude Code Adapter Plugin — Discovery Findings

## Metadata
- **Date:** 2026-03-20
- **Complexity:** large
- **Tech Stack:** TypeScript, Node.js 20+, Commander.js, tsup, ESM, vitest (Syntaur side); Claude Code Plugin System with markdown skills/commands and hooks (plugin side)

## Objective
Build a Claude Code plugin that teaches Claude how to follow the Syntaur protocol — discovering, planning, executing, and completing assignments — while enforcing write boundaries through hooks and providing mission-specific CLAUDE.md instructions.

## User's Request
Chunk 5 from the high-level plan: "Plugin with skills (`/grab-assignment`, `/plan-assignment`, `/complete-assignment`), hooks (enforce write boundaries), and CLAUDE.md instructions. Primary agent framework for initial release."

This bridges the Syntaur protocol (filesystem-based markdown task management) with Claude Code's plugin system (skills, hooks, commands). The adapter makes Claude a first-class Syntaur agent.

## Codebase Overview

### Syntaur Side (TypeScript CLI)
The project at `/Users/brennen/syntaur` is a TypeScript ESM project using Commander.js for CLI, tsup for bundling, and vitest for tests. It has:

- **3 existing CLI commands** (init, create-mission, create-assignment) in `src/commands/`
- **Lifecycle engine** (chunk 4, currently being implemented in a worktree): types, state machine, frontmatter parsing, transitions in `src/lifecycle/`. The state machine defines 6 statuses (pending, in_progress, blocked, review, completed, failed) and 7 CLI commands (assign, start, complete, block, unblock, review, fail).
- **Templates** in `src/templates/` for generating protocol files including `claude.ts` which renders the mission-level `claude.md`
- **Utils** in `src/utils/` for paths, slugs, timestamps, config, filesystem operations
- **Protocol docs** in `docs/protocol/spec.md` and `docs/protocol/file-formats.md`
- **Example mission** in `examples/sample-mission/` showing the complete folder structure

### Claude Code Plugin Side
Plugins live under `~/.claude/plugins/` (user plugins) or can be project-local. A plugin has:

- `.claude-plugin/plugin.json` — metadata (name, description, author, version)
- `skills/<name>/SKILL.md` — skills/commands with YAML frontmatter (name, description, argument-hint, allowed-tools, etc.)
- `commands/<name>.md` — legacy command format (same as skills, different layout)
- `.mcp.json` — optional MCP server config
- `agents/<name>.md` — agent definitions for subagents (optional)
- Hooks go in `.claude/settings.json` or `.claude/settings.local.json` (not inside the plugin itself)

Key plugin features:
- `$ARGUMENTS` in skill body gets replaced with user's arguments
- `!`command`` in skill body injects dynamic command output
- `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin's directory
- `allowed-tools` pre-approves tools without permission prompts
- `disable-model-invocation: true` means only the user can invoke (no auto-triggering)
- `context: fork` runs in an isolated subagent

User plugins are registered in `~/.claude/settings.json` under `enabledPlugins` with `"name@user-plugins": true`.

## Files That Will Need Changes

### New Files (Plugin Structure)
| File | Purpose | Needed Change |
|------|---------|---------------|
| `plugin/.claude-plugin/plugin.json` | Plugin metadata | Create with name "syntaur", description, author, version |
| `plugin/skills/grab-assignment/SKILL.md` | `/grab-assignment` skill | Discovers available assignments, picks one, runs `syntaur assign` + `syntaur start` |
| `plugin/skills/plan-assignment/SKILL.md` | `/plan-assignment` skill | Reads assignment.md, creates implementation plan in plan.md |
| `plugin/skills/complete-assignment/SKILL.md` | `/complete-assignment` skill | Writes handoff, runs `syntaur review` or `syntaur complete` |
| `plugin/skills/syntaur-protocol/SKILL.md` | Background knowledge skill | Protocol rules, write boundaries, file ownership — auto-invoked by Claude |
| `plugin/skills/grab-assignment/references/` | Reference material for grab-assignment | Protocol excerpts, workflow steps |
| `plugin/skills/plan-assignment/references/` | Reference material for plan-assignment | Planning patterns, plan.md format |
| `plugin/skills/complete-assignment/references/` | Reference material for complete-assignment | Completion checklist, handoff format |

### Existing Files That May Change
| File | Current Purpose | Needed Change |
|------|----------------|---------------|
| `src/templates/claude.ts` | Renders boilerplate claude.md per mission | May need enhancement to include adapter-specific instructions (plugin availability, skill invocations) |
| `examples/sample-mission/claude.md` | Example claude.md | Update to reference the plugin skills |
| `package.json` | Project metadata | Possibly add a `postinstall` or `setup` script for plugin registration |

### Hook Configuration (Not Plugin Files — Project or User Settings)
| File | Purpose | Needed Change |
|------|---------|---------------|
| `.claude/settings.json` (project-level, in target repo) | Hook configuration | PreToolUse hooks to enforce write boundaries — block writes outside the assignment folder + resources/memories |

## Patterns Discovered

| Pattern | Reference File | Description |
|---------|---------------|-------------|
| Plugin structure | `~/.claude/plugins/forge/.claude-plugin/plugin.json` | Simple JSON with name, description, author, version. Skills in `commands/` or `skills/` dirs. |
| Skill with allowed-tools | `~/.claude/plugins/forge/commands/forge.md` | Frontmatter with description, argument-hint, allowed-tools list. Body contains instructions. `$ARGUMENTS` placeholder. |
| Background knowledge skill | Skills reference doc | `user-invocable: false` makes a skill that Claude auto-invokes for context but users can't directly call. |
| User-invoked skill | Example plugin `skills/example-command/SKILL.md` | Frontmatter with name, description, argument-hint, allowed-tools. Works as `/skill-name` slash command. |
| Dynamic context injection | Skills reference doc | `!`command`` syntax in skill body runs a command and injects output before Claude sees the skill. |
| Plugin root reference | Forge plugin `commands/forge.md` | `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin directory at runtime. |
| PreToolUse hooks for blocking | Hooks reference doc | Hooks in `.claude/settings.json` with `PreToolUse` event type can block specific tool invocations matching patterns. |
| CLI command pattern | `src/commands/create-assignment.ts` | Async exported function, validates inputs, calls readConfig() for base dir, resolves paths, read/write files, console output. |
| State machine transitions | `src/lifecycle/state-machine.ts` | Map-based transition table with `canTransition()` and `getTargetStatus()`. |
| Assignment frontmatter | `examples/sample-mission/assignments/implement-jwt-middleware/assignment.md` | Full YAML frontmatter with id, slug, title, status, priority, assignee, dependsOn, workspace, tags. |
| Mission entry point | `examples/sample-mission/manifest.md` | Agent reads manifest.md first to discover all files in a mission. |
| Write ownership rules | `docs/protocol/spec.md` section 4 | Agents only write to their assignment folder. Resources/memories are shared-writable. Human-authored and derived files are read-only for agents. |

## CLAUDE.md Rules Found

- **Global `~/.claude/CLAUDE.md`**: Avoid preamble; plans in `.claude/plans/`; tracked by git; env vars managed via GCP Secret Manager; plugins stored in `~/.claude/plugins/` and registered via user-plugins marketplace.
- **No repo-level CLAUDE.md** exists at `/Users/brennen/syntaur/CLAUDE.md`.
- **Sample mission claude.md** (`examples/sample-mission/claude.md`): Read `agent.md` first; add files to barrel exports; run typecheck; use test watch; prefer explicit type annotations; commit frequently; use Q&A for questions not `blocked` status.

## Key Design Questions and Decisions

### Where should the plugin live?
**Option A:** Inside the syntaur repo at `plugin/` — ships with the npm package, installed via setup command.
**Option B:** Separate repo at `~/.claude/plugins/syntaur/` — user-level plugin.
**Option C:** Inside the syntaur repo at `plugin/` with a CLI command `syntaur install-plugin` that symlinks or copies to `~/.claude/plugins/syntaur/`.

**Recommendation:** Option C. Keep the source in the repo (`plugin/`) for version control, provide `syntaur install-plugin` to set it up. This matches how the forge and deep-plan plugins work (they're in `~/.claude/plugins/` but were developed somewhere and copied there).

### How do skills invoke the CLI?
Skills use `allowed-tools: [Bash]` and instruct Claude to run `syntaur <command>` via Bash. The instructions in each skill tell Claude what CLI commands to run and in what order. This is the standard pattern (see forge plugin which runs bash scripts).

### How do write boundary hooks work?
PreToolUse hooks in `.claude/settings.json` can intercept Edit/Write tool calls and check if the path is within the allowed boundary. The hook needs to know:
1. The mission directory path
2. The current assignment slug
3. Allowed write paths: `<mission>/<assignment>/`, `<mission>/resources/`, `<mission>/memories/`

This is the trickiest part. Options:
- **A:** A shell script hook that reads a `.claude/syntaur.local.json` config file (set by `/grab-assignment`) containing the current mission path and assignment slug, then validates the write target.
- **B:** Instructions in the protocol skill (background knowledge) that tell Claude not to write outside its boundaries — enforcement by instruction only, no hook.
- **C:** Both — instructions as primary guidance, hook as safety net.

**Recommendation:** Option C. The background knowledge skill provides rules; a PreToolUse hook script provides enforcement. The hook script checks write paths against the assignment context stored in `.claude/syntaur.local.json`.

### What does each skill do?

**`/grab-assignment [mission-slug]`:**
1. Lists available missions (reads `~/.syntaur/missions/`)
2. If mission specified, reads that mission's `_index-assignments.md` or scans assignment folders
3. Shows pending/unblocked assignments
4. User picks one (or auto-picks first available)
5. Runs `syntaur assign <slug> --agent claude --mission <mission>`
6. Runs `syntaur start <slug> --mission <mission>`
7. Reads assignment.md, agent.md, claude.md, relevant resources/memories
8. Sets up `.claude/syntaur.local.json` with current context (for hooks)
9. Reports assignment details to the user

**`/plan-assignment`:**
1. Reads current assignment context from `.claude/syntaur.local.json`
2. Reads assignment.md for objective and acceptance criteria
3. Explores the codebase (if workspace.worktreePath is set)
4. Writes implementation plan to plan.md
5. Updates assignment.md progress section

**`/complete-assignment`:**
1. Reads current assignment context
2. Verifies acceptance criteria are met (reads assignment.md)
3. Writes handoff.md with summary of what was done
4. Runs `syntaur review <slug> --mission <mission>` (or `syntaur complete` if auto-complete mode)
5. Cleans up `.claude/syntaur.local.json`

### What about a context file for inter-skill state?
The skills need shared state (which mission, which assignment, the paths). A `.claude/syntaur.local.json` file in the working directory serves this purpose. The `/grab-assignment` skill creates it; other skills read it; `/complete-assignment` cleans it up. This is the same pattern as forge's `.claude/forge.local.md`.

## Questions Asked & Answers

| Question | Answer |
|----------|--------|
| None asked yet — this discovery was conducted from codebase and docs analysis | — |

## Exploration Log

| Explorer | Focus Area | Key Findings |
|----------|-----------|--------------|
| Manual exploration 1 | Syntaur codebase structure | TypeScript ESM project with Commander.js CLI, 3 commands, lifecycle engine (chunk 4 in progress), templates, utils. ~30 source files. |
| Manual exploration 2 | Claude Code plugin system | Plugins have `.claude-plugin/plugin.json` + `skills/` + `commands/` dirs. Skills use YAML frontmatter with allowed-tools. `$ARGUMENTS`, `!`command``, `${CLAUDE_PLUGIN_ROOT}` are available. Hooks go in settings.json, not in plugins. |
| Manual exploration 3 | Existing plugin examples | Studied forge (commands with scripts), deep-plan (multi-phase with agents), example-plugin (reference implementation), stripe (commands + skills). Pattern: commands call bash scripts or provide instructions. |
| Manual exploration 4 | Protocol spec & file formats | Assignment frontmatter is source of truth. 6 statuses, lifecycle transitions. Write boundaries: agents write only to own assignment folder + shared resources/memories. Manifest.md is the entry point. |
| Manual exploration 5 | Chunk 4 lifecycle plan | 7 CLI commands being built: assign, start, complete, block, unblock, review, fail. State machine in `src/lifecycle/state-machine.ts`. Frontmatter round-trip in `src/lifecycle/frontmatter.ts`. |

## Dependency Analysis

### What Chunk 5 Depends On
- **Chunk 2 (CLI scaffolding):** Done. Commands `init`, `create-mission`, `create-assignment` exist.
- **Chunk 4 (Lifecycle engine):** In progress. The adapter skills need `syntaur assign`, `syntaur start`, `syntaur complete`, `syntaur review`, etc. These commands must exist for the adapter to function. **The plugin can be built now but will only be fully functional after chunk 4 is merged.**
- **Chunk 3 (Index rebuild):** Not yet built. The adapter doesn't strictly depend on it, but `syntaur rebuild` would be nice to run after completing an assignment. The skills can include a "run rebuild if available" instruction.

### What Depends on Chunk 5
- Nothing blocks on chunk 5. It's a consumer of the CLI, not a producer.

## Remaining Concerns / Risks

1. **Chunk 4 dependency:** The plugin's skills invoke lifecycle CLI commands that may not be merged yet. The plugin can be built and tested with stubs, but won't be end-to-end testable until chunk 4 lands.

2. **Write boundary hook complexity:** PreToolUse hooks need a shell script that reads context and validates paths. This requires careful implementation to avoid false positives (blocking legitimate writes) or false negatives (allowing writes outside boundaries). Edge cases: creating new files in resources/, writing to scratchpad.md, etc.

3. **Plugin installation/registration:** The user needs to run a setup command to install the plugin into `~/.claude/plugins/`. Need to decide the exact mechanism (symlink vs copy, CLI command vs manual).

4. **Context file management:** `.claude/syntaur.local.json` needs to be created by `/grab-assignment` and read by other skills. If Claude is used in a different directory than expected, the context file path may be wrong. Need to use absolute paths.

5. **Multiple concurrent assignments:** The current design assumes one assignment per Claude session. If a user wants to work on multiple assignments, the context file approach needs extending (or we just enforce one-at-a-time).

6. **Testing strategy:** Plugin skills are markdown files — they can't be unit-tested in the traditional sense. Integration testing would require actually running Claude Code with the plugin installed. The hook shell script can be unit-tested separately.
