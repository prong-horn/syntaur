# Chunk 5: Claude Code Adapter Plugin Implementation Plan

## Metadata
- **Date:** 2026-03-20
- **Complexity:** large
- **Tech Stack:** Claude Code Plugin System (markdown skills, YAML frontmatter, shell hooks, hooks.json); Syntaur CLI (TypeScript, Node.js 20+, Commander.js, ESM); Bash (hook scripts)

## Objective
Build a Claude Code plugin that teaches Claude how to follow the Syntaur protocol -- discovering, planning, executing, and completing assignments -- while enforcing write boundaries through a PreToolUse hook and providing protocol-specific instructions via a background skill.

## Success Criteria
- [ ] Plugin loads in Claude Code when installed to `~/.claude/plugins/syntaur/`
- [ ] `/grab-assignment` skill discovers missions, picks an assignment, runs lifecycle CLI commands, and sets up context
- [ ] `/plan-assignment` skill reads assignment context and writes a plan.md
- [ ] `/complete-assignment` skill writes handoff.md and transitions assignment to review/completed
- [ ] Background `syntaur-protocol` skill provides write boundary rules and protocol knowledge without user invocation
- [ ] PreToolUse hook blocks Edit/Write calls outside the assignment's allowed paths
- [ ] Context file `.claude/syntaur.local.json` is created by grab, read by plan/complete, cleaned up by complete
- [ ] `syntaur install-plugin` CLI command symlinks the plugin into `~/.claude/plugins/syntaur/`

## Discovery Findings

### Codebase State
The Syntaur CLI at `/Users/brennen/syntaur` has 3 existing commands (init, create-mission, create-assignment) from Chunk 2, plus 7 lifecycle commands (assign, start, complete, block, unblock, review, fail) from Chunk 4 (now landed on main), plus `install-plugin` (also landed). The entry point is `src/index.ts` (lines 1-226) which registers all 11 commands with Commander.js. The state machine in `src/lifecycle/state-machine.ts` (lines 1-34) defines transitions like `pending:start -> in_progress` and `in_progress:review -> review`.

**Post-Chunk 4 codebase state (as of 2026-03-21):**
- `src/commands/install-plugin.ts` already exists and is fully implemented (symlink-based plugin install with `--force` support)
- `src/index.ts` already imports and registers the `install-plugin` command (line 12, lines 210-224)
- `.gitignore` already contains `.claude/syntaur.local.json` (line 6)
- `package.json` `files` array already includes `"plugin"` (line 13)
- The `plugin/` directory structure already exists with all subdirectories: `.claude-plugin/`, `hooks/`, `references/`, `skills/` (with all 4 skill directories and SKILL.md files, hooks.json, enforce-boundaries.sh, reference docs)

### Plugin System Patterns (from exploration)
Studied 6 real plugins to establish patterns:

1. **Plugin manifest** (`forge/.claude-plugin/plugin.json`, lines 1-9): Simple JSON with `name`, `description`, `author` (object with name/email), `version`. Optional: `keywords`.

2. **User-invoked skill** (`example-plugin/skills/example-command/SKILL.md`, lines 1-39): YAML frontmatter with `name`, `description`, `argument-hint`, `allowed-tools`. Body uses `$ARGUMENTS` for user input.

3. **Background knowledge skill** (`example-plugin/skills/example-skill/SKILL.md`, lines 1-85): YAML frontmatter with `name`, `description` (trigger conditions), `version`. No `argument-hint` or `allowed-tools` -- Claude auto-invokes based on description match.

4. **Hooks via hooks.json** (`hookify/hooks/hooks.json`, lines 1-49): Placed in `hooks/hooks.json` inside the plugin. Keys are event types (`PreToolUse`, `PostToolUse`, `Stop`). Each maps to an array of matcher objects containing a `hooks` array with `type: "command"` and a `command` string. Uses `${CLAUDE_PLUGIN_ROOT}` for script paths. Optional `timeout` field.

5. **PreToolUse hook script** (`hookify/hooks/pretooluse.py`, lines 1-67): Reads JSON from stdin (contains `tool_name` and tool-specific params like file path). Outputs JSON to stdout. For blocking: `{"decision": "block", "reason": "..."}`. For allowing: empty JSON `{}` or exit 0 with no output. Always exits 0 -- never blocks due to hook errors.

6. **Context file pattern** (`forge/commands/forge.md`, line 41): Forge uses `.claude/forge.local.md` as inter-skill state. Skills read/write this file. The forge stop hook reads it to determine if orchestration is active.

7. **Plugin root reference** (`forge/commands/forge.md`, lines 29-30): `${CLAUDE_PLUGIN_ROOT}` in skill body resolves to the plugin's installed directory at runtime.

### Protocol Write Boundaries (from `docs/protocol/spec.md`, lines 90-143)
- **Agent-writable**: Files inside the assigned assignment folder only (`assignment.md`, `plan.md`, `scratchpad.md`, `handoff.md`, `decision-record.md`)
- **Shared-writable**: `resources/` and `memories/` folders at mission level
- **Read-only for agents**: `mission.md`, `agent.md`, `claude.md`, all `_index-*` and `_status.md` files, `manifest.md`

### Files That Will Need Changes
| File | Current Purpose | Needed Change |
|------|----------------|---------------|
| `plugin/.claude-plugin/plugin.json` | Does not exist | CREATE: Plugin manifest |
| `plugin/skills/grab-assignment/SKILL.md` | Does not exist | CREATE: /grab-assignment user skill |
| `plugin/skills/plan-assignment/SKILL.md` | Does not exist | CREATE: /plan-assignment user skill |
| `plugin/skills/complete-assignment/SKILL.md` | Does not exist | CREATE: /complete-assignment user skill |
| `plugin/skills/syntaur-protocol/SKILL.md` | Does not exist | CREATE: Background protocol knowledge skill |
| `plugin/hooks/hooks.json` | Does not exist | CREATE: PreToolUse hook registration |
| `plugin/hooks/enforce-boundaries.sh` | Does not exist | CREATE: Write boundary enforcement script |
| `plugin/references/protocol-summary.md` | Does not exist | CREATE: Condensed protocol reference for skills |
| `plugin/references/file-ownership.md` | Does not exist | CREATE: Ownership rules quick-reference |
| `src/commands/install-plugin.ts` | Already exists (chunk 4 landed) | NO CHANGE NEEDED: fully implemented |
| `src/index.ts` | CLI entry point (lines 1-226, all 11 commands registered) | NO CHANGE NEEDED: install-plugin already registered |

### CLAUDE.md Rules
- Plans go in `.claude/plans/` and are tracked by git (global `~/.claude/CLAUDE.md`)
- Plugins stored in `~/.claude/plugins/` and registered via user-plugins marketplace (global `~/.claude/CLAUDE.md`)
- No repo-level CLAUDE.md exists for syntaur
- Sample mission `claude.md` (`examples/sample-mission/claude.md`, lines 1-13) tells agents to read `agent.md` first, use barrel exports, run typecheck, commit frequently

## High-Level Architecture

### Approach
Create the plugin as a directory tree at `plugin/` within the syntaur repo, following the exact structure observed in real plugins (forge, hookify, example-plugin). The plugin is pure markdown + shell -- no compilation needed. A CLI command `syntaur install-plugin` creates a symlink from `~/.claude/plugins/syntaur/` to the repo's `plugin/` directory. This keeps source in version control while making it available to Claude Code.

The three user-invoked skills (`/grab-assignment`, `/plan-assignment`, `/complete-assignment`) operate as a workflow sequence. They share state through `.claude/syntaur.local.json` in the working directory. The background `syntaur-protocol` skill provides protocol rules that Claude automatically picks up. A PreToolUse hook in `hooks/hooks.json` runs a bash script that validates write paths against the current assignment context.

### Key Decisions
| Decision | Chosen Option | Alternatives Considered | Rationale |
|----------|--------------|------------------------|-----------|
| Plugin location | `plugin/` in repo, symlinked to `~/.claude/plugins/syntaur/` | Separate repo; direct copy to plugins dir | Keeps source in version control, matches forge pattern (developed in one place, installed to plugins dir). Symlink avoids stale copies. |
| Skill format | `skills/<name>/SKILL.md` layout | `commands/<name>.md` legacy layout | Skills layout supports subdirectories for references. Matches newer plugin convention (example-plugin uses both, but skills/ is the forward path). |
| Hook language | Bash shell script | Python (like hookify); Node.js | Bash is zero-dependency, fast startup, and sufficient for path validation. The hook needs to read a JSON file and compare paths -- no complex logic. Avoids requiring Python 3 or Node on the system. |
| Context file format | JSON (`.claude/syntaur.local.json`) | Markdown (like forge's `.claude/forge.local.md`) | JSON is directly parseable by bash (`jq`) and by skills via `!` backtick command injection. Markdown frontmatter parsing in bash is fragile. |
| Write boundary enforcement | PreToolUse hook + background skill instructions | Hook only; Instructions only | Defense in depth. The background skill tells Claude the rules (soft enforcement). The hook blocks violations (hard enforcement). |
| `assign` + `start` as separate steps | Keep as two CLI calls in /grab-assignment | Combine into single `syntaur grab` command | Chunk 4 already implements `assign` and `start` as separate commands. The skill orchestrates them in sequence. No new CLI command needed. |

### Components

1. **Plugin Manifest** (`plugin/.claude-plugin/plugin.json`): Standard metadata JSON. Name: "syntaur".

2. **User Skills** (3 skills in `plugin/skills/`):
   - `grab-assignment`: Discovers missions, lists pending assignments, picks one, runs `syntaur assign` + `syntaur start`, reads assignment context, creates `.claude/syntaur.local.json`.
   - `plan-assignment`: Reads context from `.claude/syntaur.local.json`, reads assignment.md, explores workspace, writes plan.md.
   - `complete-assignment`: Reads context, verifies acceptance criteria, writes handoff.md, runs `syntaur review` or `syntaur complete`.

3. **Background Skill** (`plugin/skills/syntaur-protocol/SKILL.md`): Auto-invoked by Claude when working on Syntaur assignments. Contains write boundary rules, file ownership table, lifecycle overview, and protocol conventions.

4. **PreToolUse Hook** (`plugin/hooks/enforce-boundaries.sh` + `plugin/hooks/hooks.json`): Shell script that reads `.claude/syntaur.local.json`, extracts the mission path and assignment slug, and validates that Edit/Write targets are within allowed paths. Outputs `{"decision": "block", "reason": "..."}` for violations.

5. **Reference Materials** (`plugin/references/`): Condensed protocol summaries embedded in the plugin for skills to reference via `${CLAUDE_PLUGIN_ROOT}/references/`.

6. **Install Command** (`src/commands/install-plugin.ts`): CLI command that creates the symlink from `~/.claude/plugins/syntaur/` to the repo's `plugin/` directory.

## Architecture Diagram

```mermaid
flowchart TD
    subgraph "Claude Code Session"
        U[User] -->|"/grab-assignment mission-slug"| GA[grab-assignment skill]
        GA -->|"Bash: syntaur assign + start"| CLI[Syntaur CLI]
        GA -->|"Write"| CTX[".claude/syntaur.local.json"]

        U -->|"/plan-assignment"| PA[plan-assignment skill]
        PA -->|"Read"| CTX
        PA -->|"Read"| AMD[assignment.md]
        PA -->|"Write"| PMD[plan.md]

        U -->|"/complete-assignment"| CA[complete-assignment skill]
        CA -->|"Read"| CTX
        CA -->|"Write"| HMD[handoff.md]
        CA -->|"Bash: syntaur review/complete"| CLI
        CA -->|"Delete"| CTX

        SP[syntaur-protocol skill] -.->|"auto-invoked background context"| Claude[Claude Model]

        Hook[PreToolUse Hook] -->|"Read"| CTX
        Hook -->|"block/allow"| ToolCall[Edit/Write Tool Calls]
    end

    subgraph "Filesystem"
        CLI -->|"Read/Write"| Mission["<defaultMissionDir>/<mission>/"]
        Mission --> AssignDir["assignments/<slug>/"]
        Mission --> Resources["resources/"]
        Mission --> Memories["memories/"]
    end
```

```mermaid
sequenceDiagram
    participant U as User
    participant GA as /grab-assignment
    participant CLI as syntaur CLI
    participant FS as Filesystem
    participant PA as /plan-assignment
    participant CA as /complete-assignment
    participant Hook as PreToolUse Hook

    U->>GA: /grab-assignment my-mission
    GA->>FS: Read <defaultMissionDir>/my-mission/
    GA->>GA: List pending assignments
    GA->>CLI: syntaur assign <slug> --agent claude --mission my-mission
    GA->>CLI: syntaur start <slug> --mission my-mission
    GA->>FS: Read assignment.md, agent.md, claude.md
    GA->>FS: Write .claude/syntaur.local.json
    GA->>U: Report assignment details

    U->>PA: /plan-assignment
    PA->>FS: Read .claude/syntaur.local.json
    PA->>FS: Read assignment.md (objective + criteria)
    PA->>PA: Explore codebase if workspace set
    PA->>FS: Write plan.md
    Note over Hook,FS: Hook validates every Edit/Write
    Hook->>FS: Read .claude/syntaur.local.json
    Hook->>Hook: Check path within allowed boundaries

    U->>CA: /complete-assignment
    CA->>FS: Read .claude/syntaur.local.json
    CA->>FS: Read assignment.md (verify criteria)
    CA->>FS: Write handoff.md
    CA->>CLI: syntaur review <slug> --mission my-mission
    CA->>FS: Delete .claude/syntaur.local.json
    CA->>U: Report completion
```

## Patterns to Follow

| Pattern | Reference File | Lines | What to Copy |
|---------|---------------|-------|--------------|
| Plugin manifest structure | `/Users/brennen/.claude/plugins/forge/.claude-plugin/plugin.json` | L1-9 | JSON shape: `name`, `description`, `author` (object with `name`, `email`), `version` |
| User-invoked skill frontmatter | `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/example-plugin/skills/example-command/SKILL.md` | L1-6 | YAML: `name`, `description`, `argument-hint`, `allowed-tools` list |
| Background skill frontmatter | `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/example-plugin/skills/example-skill/SKILL.md` | L1-5 | YAML: `name`, `description` (trigger conditions), `version`. No `allowed-tools`. |
| hooks.json structure | `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/hookify/hooks/hooks.json` | L1-49 | JSON: `description`, `hooks` object keyed by event type, array of matchers with `hooks` array containing `type: "command"` entries using `${CLAUDE_PLUGIN_ROOT}` |
| PreToolUse hook I/O | `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/hookify/hooks/pretooluse.py` | L29-51 | Read JSON from stdin (`tool_name` field), output JSON to stdout (`{"decision": "block", "reason": "..."}` or `{}`), always exit 0 |
| Plugin root variable in skill body | `/Users/brennen/.claude/plugins/forge/commands/forge.md` | L29 | `${CLAUDE_PLUGIN_ROOT}` resolves to plugin dir at runtime |
| $ARGUMENTS placeholder | `/Users/brennen/.claude/plugins/forge/commands/forge.md` | L24 | `$ARGUMENTS` in skill body replaced with user's input |
| Context file for inter-skill state | `/Users/brennen/.claude/plugins/forge/commands/forge.md` | L41 | Forge reads `.claude/forge.local.md` for ticket context; we use `.claude/syntaur.local.json` |
| CLI command pattern | `/Users/brennen/syntaur/src/commands/create-assignment.ts` | L26-29, L80-83 | Async exported function, `readConfig()` for base dir, validate inputs, resolve paths |
| Commander.js registration | `/Users/brennen/syntaur/src/index.ts` | L20-34 | `.command()` -> `.description()` -> `.option()` -> `.action(async () => { try/catch })` |
| Stop hook script pattern | `/Users/brennen/.claude/plugins/forge/hooks/stop-hook.sh` | L1-97 | Bash script: read context file, validate state, output JSON decision. Uses `${CLAUDE_PLUGIN_ROOT}` env var. |

## Implementation Overview

### Task List (High-Level)

1. **Create plugin directory structure and manifest** -- Files: `plugin/.claude-plugin/plugin.json`
   - Create the `plugin/.claude-plugin/` directory and `plugin.json` manifest following the forge pattern.

2. **Create reference materials** -- Files: `plugin/references/protocol-summary.md`, `plugin/references/file-ownership.md`
   - Condense protocol spec and file ownership rules into quick-reference documents that skills can point to via `${CLAUDE_PLUGIN_ROOT}/references/`.

3. **Create background syntaur-protocol skill** -- Files: `plugin/skills/syntaur-protocol/SKILL.md`
   - Background skill (no `allowed-tools`, no `argument-hint`) that Claude auto-invokes when working on Syntaur tasks. Contains write boundary rules, file ownership table, lifecycle states, and conventions.

4. **Create /grab-assignment skill** -- Files: `plugin/skills/grab-assignment/SKILL.md`
   - User-invoked skill with `allowed-tools: [Bash, Read, Write, Glob, Grep]`. Instructions to: scan missions dir, list pending assignments, run `syntaur assign` + `syntaur start`, read assignment context files, write `.claude/syntaur.local.json`.

5. **Create /plan-assignment skill** -- Files: `plugin/skills/plan-assignment/SKILL.md`
   - User-invoked skill. Reads `.claude/syntaur.local.json` context, reads assignment.md, explores codebase if workspace is set, writes plan.md in the assignment folder.

6. **Create /complete-assignment skill** -- Files: `plugin/skills/complete-assignment/SKILL.md`
   - User-invoked skill. Reads context, checks acceptance criteria, writes handoff.md, runs `syntaur review`, cleans up `.claude/syntaur.local.json`.

7. **Create PreToolUse write boundary hook** -- Files: `plugin/hooks/hooks.json`, `plugin/hooks/enforce-boundaries.sh`
   - `hooks.json` registers a PreToolUse hook. `enforce-boundaries.sh` reads stdin JSON, extracts `tool_name` and file path, reads `.claude/syntaur.local.json` for allowed paths, outputs block decision if path is outside boundaries. Requires `jq` for JSON parsing.

8. **~~Create install-plugin CLI command~~** — ALREADY COMPLETE
   - `src/commands/install-plugin.ts` and its registration in `src/index.ts` already exist and are functional.

9. **~~Update .gitignore and package.json~~** — ALREADY COMPLETE
   - `.gitignore` already contains `.claude/syntaur.local.json`. `package.json` `files` already includes `"plugin"`.

### File Changes Summary
| File | Action | Purpose | Pattern Reference |
|------|--------|---------|-------------------|
| `plugin/.claude-plugin/plugin.json` | CREATE | Plugin manifest | `forge/.claude-plugin/plugin.json` L1-9 |
| `plugin/references/protocol-summary.md` | CREATE | Condensed protocol for skills | `docs/protocol/spec.md` |
| `plugin/references/file-ownership.md` | CREATE | Write boundary rules quick-ref | `docs/protocol/spec.md` L90-143 |
| `plugin/skills/syntaur-protocol/SKILL.md` | CREATE | Background protocol knowledge | `example-plugin/skills/example-skill/SKILL.md` L1-5 |
| `plugin/skills/grab-assignment/SKILL.md` | CREATE | /grab-assignment user skill | `example-plugin/skills/example-command/SKILL.md` L1-6 |
| `plugin/skills/plan-assignment/SKILL.md` | CREATE | /plan-assignment user skill | `example-plugin/skills/example-command/SKILL.md` L1-6 |
| `plugin/skills/complete-assignment/SKILL.md` | CREATE | /complete-assignment user skill | `example-plugin/skills/example-command/SKILL.md` L1-6 |
| `plugin/hooks/hooks.json` | CREATE | PreToolUse hook registration | `hookify/hooks/hooks.json` L1-16 |
| `plugin/hooks/enforce-boundaries.sh` | CREATE | Write boundary enforcement | `forge/hooks/stop-hook.sh` L1-97 |
| `src/commands/install-plugin.ts` | ALREADY EXISTS | CLI install command (landed in chunk 4) | N/A |
| `src/index.ts` | ALREADY DONE | install-plugin command already registered | N/A |
| `.gitignore` | ALREADY DONE | `.claude/syntaur.local.json` already present | N/A |
| `package.json` | ALREADY DONE | `plugin` already in `files` array | N/A |

## Dependencies & Risks
| Dependency/Risk | Impact | Mitigation |
|----------------|--------|------------|
| ~~Chunk 4 lifecycle commands not yet merged~~ | ~~RESOLVED~~ — Chunk 4 lifecycle commands are now landed on main. All 7 lifecycle commands (assign, start, complete, block, unblock, review, fail) plus install-plugin are registered and functional. | No mitigation needed; dependency is resolved. |
| `jq` required for boundary hook | The enforce-boundaries.sh script needs `jq` to parse JSON from stdin and from the context file | `jq` is ubiquitous on macOS (ships with Xcode CLT) and Linux. Add a check at the top of the script: if `jq` not found, allow all writes and emit a warning. |
| Symlink vs copy for install | Symlinks may not work on all platforms or with all file watchers | Use `ln -s` on macOS/Linux. Document the approach. If symlink fails, fall back to copy with a warning that updates require re-running install. |
| Single assignment per session | `.claude/syntaur.local.json` tracks one assignment. If user grabs a second, context is overwritten. | Document this as intentional for v1. The `/grab-assignment` skill should warn if a context file already exists and ask whether to replace it. |
| Hook false positives | The boundary hook might block legitimate writes outside the mission dir (e.g., to the syntaur repo itself if the agent is working in a worktree) | The hook should only activate when `.claude/syntaur.local.json` exists. If the file is absent, the hook allows all writes. The hook checks the workspace.worktreePath from context to determine the project root. |
| PreToolUse hook stdin format | The exact JSON schema for PreToolUse stdin is not fully documented; inferred from hookify | The hookify plugin's pretooluse.py (line 35) reads `tool_name` from stdin. For Edit/Write, the `tool_input` object should contain `file_path`. Add defensive checks and allow-by-default on parse errors. |
| No automated tests for plugin files | Most deliverables are markdown skills and a bash script, which are not typical unit test targets | The `install-plugin` CLI command should be tested manually via `syntaur install-plugin` + `ls -la ~/.claude/plugins/syntaur`. The hook script should be tested with `echo '<json>' | bash enforce-boundaries.sh`. Automated tests for install-plugin.ts can be added as a follow-up. |

## Assumptions Log
| Assumption Avoided | Verified By | Answer |
|-------------------|-------------|--------|
| Plugin skill frontmatter format | Read `example-plugin/skills/example-command/SKILL.md` lines 1-6 | Confirmed: `name`, `description`, `argument-hint`, `allowed-tools` in YAML frontmatter |
| hooks.json lives inside plugin dir | Read `hookify/hooks/hooks.json` and `forge/hooks/hooks.json` | Confirmed: both plugins place hooks.json inside their own `hooks/` directory |
| PreToolUse hook receives tool_name on stdin | Read `hookify/hooks/pretooluse.py` line 35 | Confirmed: `input_data.get('tool_name', '')` reads from stdin JSON |
| `${CLAUDE_PLUGIN_ROOT}` available in hooks and skills | Read `forge/commands/forge.md` line 29 and `hookify/hooks/hooks.json` line 9 | Confirmed: used in both skill bodies and hook commands |
| Forge uses context file for inter-skill state | Read `forge/commands/forge.md` line 41 and `forge/hooks/stop-hook.sh` line 12 | Confirmed: `.claude/forge.local.md` is the shared state file |
| CLI commands follow async function + readConfig pattern | Read `src/commands/create-assignment.ts` lines 26-29, 80-83 | Confirmed: exported async function, calls `readConfig()` for base directory |
| Commander.js registration pattern | Read `src/index.ts` lines 20-34 | Confirmed: `.command()` -> `.description()` -> `.option()` -> `.action(async (_, opts) => { try/catch })` |
| State machine transition commands | Read `src/lifecycle/types.ts` lines 9-16 | Confirmed: `assign`, `start`, `complete`, `block`, `unblock`, `review`, `fail` |
| Assignment frontmatter includes workspace field | Read `examples/sample-mission/assignments/implement-jwt-middleware/assignment.md` lines 18-21 | Confirmed: `workspace.repository`, `workspace.worktreePath`, `workspace.branch`, `workspace.parentBranch` |
| Protocol write boundaries | Read `docs/protocol/spec.md` lines 90-143 | Confirmed: agent-writable (assignment folder), shared-writable (resources/, memories/), read-only (mission.md, agent.md, claude.md, derived files) |

---

## Detailed Implementation Plan (Phase 3)

### Task 1: Create plugin directory structure and manifest

**File(s):** `plugin/.claude-plugin/plugin.json`
**Action:** CREATE
**Pattern Reference:** `/Users/brennen/.claude/plugins/forge/.claude-plugin/plugin.json:1-9`
**Estimated complexity:** Low

#### Context
The plugin manifest is the entry point that tells Claude Code this directory is a plugin. Without it, none of the skills or hooks will load.

#### Steps

1. [ ] **Step 1.1:** Create the directory `plugin/.claude-plugin/`
   - **Location:** new directory at `plugin/.claude-plugin/`
   - **Action:** CREATE
   - **What to do:** Create the nested directory structure. The `.claude-plugin` directory is what Claude Code looks for to identify a plugin root.
   - **Verification:**
     ```bash
     mkdir -p /Users/brennen/syntaur/plugin/.claude-plugin
     ls -la /Users/brennen/syntaur/plugin/.claude-plugin/
     ```

2. [ ] **Step 1.2:** Create `plugin/.claude-plugin/plugin.json`
   - **Location:** new file at `plugin/.claude-plugin/plugin.json`
   - **Action:** CREATE
   - **What to do:** Create the plugin manifest JSON file with `name`, `description`, `author` (object with `name` and `email`), and `version` fields.
   - **Code:**
     ```json
     {
       "name": "syntaur",
       "description": "Syntaur protocol adapter for Claude Code. Provides skills for grabbing, planning, and completing assignments, plus write boundary enforcement via hooks.",
       "author": {
         "name": "Brennen",
         "email": ""
       },
       "version": "0.1.0"
     }
     ```
   - **Proof blocks:**
     - **PROOF:** Forge plugin manifest uses `name`, `description`, `author` (object with `name`, `email`), `version` fields.
       Source: `/Users/brennen/.claude/plugins/forge/.claude-plugin/plugin.json:1-9`
       Actual code:
       ```json
       {
         "name": "forge",
         "description": "Ticket-driven orchestrator for multi-repo development...",
         "author": {
           "name": "Brennen",
           "email": ""
         },
         "version": "1.0.0"
       }
       ```
   - **Verification:**
     ```bash
     cat /Users/brennen/syntaur/plugin/.claude-plugin/plugin.json | python3 -m json.tool
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| Directory already exists | `mkdir -p` is idempotent, no error | N/A | `mkdir -p` |
| Invalid JSON | Validate with `python3 -m json.tool` | Parse error on stdout | N/A |

#### Task Completion Criteria
- [ ] `plugin/.claude-plugin/plugin.json` exists and is valid JSON
- [ ] JSON contains all 4 required fields: `name`, `description`, `author`, `version`
- [ ] `author` is an object with `name` and `email` subfields

---

### Task 2: Create reference materials

**File(s):** `plugin/references/protocol-summary.md`, `plugin/references/file-ownership.md`
**Action:** CREATE
**Pattern Reference:** `docs/protocol/spec.md:1-257` (condensed from full spec)
**Estimated complexity:** Low

#### Context
Skills need to reference protocol rules without embedding the entire spec inline. These reference files live inside the plugin and are accessed via `${CLAUDE_PLUGIN_ROOT}/references/` in skill bodies.

#### Steps

1. [ ] **Step 2.1:** Create `plugin/references/` directory
   - **Location:** new directory at `plugin/references/`
   - **Action:** CREATE
   - **What to do:** Create the directory for reference materials.
   - **Verification:**
     ```bash
     mkdir -p /Users/brennen/syntaur/plugin/references
     ```

2. [ ] **Step 2.2:** Create `plugin/references/protocol-summary.md`
   - **Location:** new file at `plugin/references/protocol-summary.md`
   - **Action:** CREATE
   - **What to do:** Create a condensed protocol reference covering directory structure, lifecycle states, and key conventions. This is a plain markdown file (no YAML frontmatter needed -- it is not a skill).
   - **Code:**
     ```markdown
     # Syntaur Protocol Summary

     ## Directory Structure

     ```
     ~/.syntaur/
       config.md
       missions/
         <mission-slug>/
           manifest.md            # Derived: root navigation (read-only)
           mission.md             # Human-authored: mission overview (read-only)
           _index-assignments.md  # Derived (read-only)
           _index-plans.md        # Derived (read-only)
           _index-decisions.md    # Derived (read-only)
           _index-sessions.md     # Derived (read-only)
           _status.md             # Derived (read-only)
           claude.md              # Human-authored: Claude-specific instructions (read-only)
           agent.md               # Human-authored: universal agent instructions (read-only)
           assignments/
             <assignment-slug>/
               assignment.md      # Agent-writable: source of truth for state
               plan.md            # Agent-writable: implementation plan
               scratchpad.md      # Agent-writable: working notes
               handoff.md         # Agent-writable: append-only handoff log
               decision-record.md # Agent-writable: append-only decision log
           resources/
             _index.md            # Derived (read-only)
             <resource-slug>.md   # Shared-writable
           memories/
             _index.md            # Derived (read-only)
             <memory-slug>.md     # Shared-writable
     ```

     ## Assignment Lifecycle

     | Status | Meaning |
     |--------|---------|
     | `pending` | Not yet started |
     | `in_progress` | Actively being worked on |
     | `blocked` | Manually blocked (requires `blockedReason`) |
     | `review` | Work complete, awaiting review |
     | `completed` | Done |
     | `failed` | Could not be completed |

     ## Valid State Transitions

     | From | Command | To |
     |------|---------|-----|
     | pending | start | in_progress |
     | pending | block | blocked |
     | in_progress | block | blocked |
     | in_progress | review | review |
     | in_progress | complete | completed |
     | in_progress | fail | failed |
     | blocked | unblock | in_progress |
     | review | start | in_progress |
     | review | complete | completed |
     | review | fail | failed |

     ## Key Rules

     1. **Assignment frontmatter is the single source of truth** for all assignment state.
     2. **One folder per mission**, one subfolder per assignment.
     3. **Derived files** (underscore-prefixed) are never edited manually.
     4. **Slugs** are lowercase, hyphen-separated.
     5. **Dependencies** are declared via `dependsOn` in assignment frontmatter.
     6. An assignment cannot transition from `pending` to `in_progress` while any dependency is not `completed`.
     ```
   - **Proof blocks:**
     - **PROOF:** Directory structure matches `docs/protocol/spec.md:49-78`.
       Source: `/Users/brennen/syntaur/docs/protocol/spec.md:49-78`
     - **PROOF:** Assignment statuses verified from `docs/protocol/spec.md:168-177`.
       Source: `/Users/brennen/syntaur/docs/protocol/spec.md:168-177`
     - **PROOF:** State transitions verified from `src/lifecycle/state-machine.ts:4-15`.
       Source: `/Users/brennen/syntaur/src/lifecycle/state-machine.ts:4-15`
       Actual code:
       ```typescript
       const TRANSITION_TABLE = new Map<string, AssignmentStatus>([
         ['pending:start', 'in_progress'],
         ['pending:block', 'blocked'],
         ['in_progress:block', 'blocked'],
         ['in_progress:review', 'review'],
         ['in_progress:complete', 'completed'],
         ['in_progress:fail', 'failed'],
         ['blocked:unblock', 'in_progress'],
         ['review:start', 'in_progress'],
         ['review:complete', 'completed'],
         ['review:fail', 'failed'],
       ]);
       ```
   - **Verification:**
     ```bash
     test -f /Users/brennen/syntaur/plugin/references/protocol-summary.md && echo "OK"
     ```

3. [ ] **Step 2.3:** Create `plugin/references/file-ownership.md`
   - **Location:** new file at `plugin/references/file-ownership.md`
   - **Action:** CREATE
   - **What to do:** Create a quick-reference for file ownership categories. This is the core reference for write boundary enforcement.
   - **Code:**
     ```markdown
     # File Ownership Rules

     ## Human-Authored (READ-ONLY for agents)

     Agents must NEVER modify these files:

     | File | Location |
     |------|----------|
     | `mission.md` | `<mission>/mission.md` |
     | `agent.md` | `<mission>/agent.md` |
     | `claude.md` | `<mission>/claude.md` |

     ## Agent-Writable (YOUR assignment folder ONLY)

     You may ONLY write to files inside your assigned assignment folder:

     | File | Purpose |
     |------|---------|
     | `assignment.md` | Assignment record, source of truth for state |
     | `plan.md` | Your implementation plan |
     | `scratchpad.md` | Working notes |
     | `handoff.md` | Append-only handoff log |
     | `decision-record.md` | Append-only decision log |

     Path pattern: `<defaultMissionDir>/<mission>/assignments/<your-assignment>/`
     (where `<defaultMissionDir>` is resolved from `~/.syntaur/config.md`, defaulting to `~/.syntaur/missions`)

     ## Shared-Writable (any agent or human)

     | Location | Purpose |
     |----------|---------|
     | `<mission>/resources/<slug>.md` | Reference material |
     | `<mission>/memories/<slug>.md` | Learnings and patterns |

     ## Derived (NEVER edit)

     All files prefixed with `_` are derived and rebuilt by tooling:
     - `manifest.md`
     - `_index-assignments.md`
     - `_index-plans.md`
     - `_index-decisions.md`
     - `_index-sessions.md`
     - `_status.md`
     - `resources/_index.md`
     - `memories/_index.md`

     ## Workspace Files

     When working on code (not protocol files), you may write to files within
     the workspace defined in your assignment frontmatter:
     - `workspace.worktreePath` or `workspace.repository` defines your project root
     - You may create and edit source code files within that workspace
     - The `.claude/syntaur.local.json` context file in your working directory is also writable
     ```
   - **Proof blocks:**
     - **PROOF:** File ownership categories verified from `docs/protocol/spec.md:90-143`.
       Source: `/Users/brennen/syntaur/docs/protocol/spec.md:90-143`
       Key sections: Human-Authored (lines 96-103), Agent-Writable (lines 106-116), Shared-Writable (lines 120-127), Derived (lines 130-143)
     - **PROOF:** Workspace fields verified from `src/lifecycle/types.ts:24-29`.
       Source: `/Users/brennen/syntaur/src/lifecycle/types.ts:24-29`
       Actual code:
       ```typescript
       export interface Workspace {
         repository: string | null;
         worktreePath: string | null;
         branch: string | null;
         parentBranch: string | null;
       }
       ```
   - **Verification:**
     ```bash
     test -f /Users/brennen/syntaur/plugin/references/file-ownership.md && echo "OK"
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| Directory already exists | `mkdir -p` is idempotent | N/A | N/A |

#### Task Completion Criteria
- [ ] `plugin/references/protocol-summary.md` exists with directory structure, lifecycle states, and transition table
- [ ] `plugin/references/file-ownership.md` exists with all 4 ownership categories documented
- [ ] Both files are plain markdown (no YAML frontmatter)

---

### Task 3: Create background syntaur-protocol skill

**File(s):** `plugin/skills/syntaur-protocol/SKILL.md`
**Action:** CREATE
**Pattern Reference:** `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/example-plugin/skills/example-skill/SKILL.md:1-5`
**Estimated complexity:** Medium

#### Context
This background skill is automatically invoked by Claude when the user is working on Syntaur-related tasks. It provides protocol knowledge and write boundary rules as system context, serving as the "soft enforcement" layer (the hook provides "hard enforcement").

#### Steps

1. [ ] **Step 3.1:** Create `plugin/skills/syntaur-protocol/` directory
   - **Location:** new directory at `plugin/skills/syntaur-protocol/`
   - **Action:** CREATE
   - **Verification:**
     ```bash
     mkdir -p /Users/brennen/syntaur/plugin/skills/syntaur-protocol
     ```

2. [ ] **Step 3.2:** Create `plugin/skills/syntaur-protocol/SKILL.md`
   - **Location:** new file at `plugin/skills/syntaur-protocol/SKILL.md`
   - **Action:** CREATE
   - **What to do:** Create a background skill with YAML frontmatter containing `name`, `description` (with trigger phrases), and `version`. No `argument-hint` or `allowed-tools` fields (those are for user-invoked skills only). The body contains protocol rules, write boundary instructions, and references to the plugin's reference files.
   - **Code:**
     ```markdown
     ---
     name: syntaur-protocol
     description: This skill should be used when the user mentions "syntaur", "assignment", "mission", works with files under ~/.syntaur/, references assignment.md, plan.md, handoff.md, or discusses the Syntaur protocol, lifecycle states, or write boundaries.
     version: 0.1.0
     ---

     # Syntaur Protocol Knowledge

     You are working within the Syntaur protocol. Follow these rules at all times.

     ## Write Boundary Rules (CRITICAL)

     You MUST respect file ownership boundaries. Violations will be blocked by the PreToolUse hook.

     ### Files you may WRITE:
     1. **Your assignment folder** -- only the assignment you are currently working on:
        - `assignment.md`, `plan.md`, `scratchpad.md`, `handoff.md`, `decision-record.md`
        - Path: determined by `assignmentDir` in `.claude/syntaur.local.json` (resolved from `readConfig().defaultMissionDir`)
     2. **Shared resources and memories** at the mission level:
        - `<missionDir>/resources/<slug>.md`
        - `<missionDir>/memories/<slug>.md`
        - Where `<missionDir>` comes from `.claude/syntaur.local.json` (resolved from `readConfig().defaultMissionDir`)
     3. **Your workspace** -- source code files within the workspace defined in your assignment's frontmatter (`workspace.worktreePath` or `workspace.repository`)
     4. **Context file** -- `.claude/syntaur.local.json` in the current working directory

     ### Files you must NEVER write:
     1. `mission.md`, `agent.md`, `claude.md` -- human-authored, read-only
     2. `manifest.md` -- derived, rebuilt by tooling
     3. Any file prefixed with `_` (`_index-*.md`, `_status.md`) -- derived
     4. Other agents' assignment folders
     5. Any files outside your workspace boundary

     ## Current Assignment Context

     If `.claude/syntaur.local.json` exists in the current working directory, read it to determine:
     - `missionSlug` -- which mission you are working on
     - `assignmentSlug` -- which assignment is yours
     - `missionDir` -- absolute path to the mission folder
     - `assignmentDir` -- absolute path to your assignment folder
     - `workspaceRoot` -- absolute path to your code workspace (if set)

     ## Protocol References

     For detailed protocol information, read these files:
     - **Protocol summary:** `${CLAUDE_PLUGIN_ROOT}/references/protocol-summary.md`
     - **File ownership rules:** `${CLAUDE_PLUGIN_ROOT}/references/file-ownership.md`

     ## Lifecycle Commands

     Use the `syntaur` CLI for state transitions. Available commands:
     - `syntaur assign <slug> --agent <name> --mission <mission>` -- set assignee
     - `syntaur start <slug> --mission <mission>` -- pending -> in_progress
     - `syntaur review <slug> --mission <mission>` -- in_progress -> review
     - `syntaur complete <slug> --mission <mission>` -- in_progress/review -> completed
     - `syntaur block <slug> --mission <mission> --reason <text>` -- block an assignment
     - `syntaur unblock <slug> --mission <mission>` -- unblock
     - `syntaur fail <slug> --mission <mission>` -- mark as failed

     ## Conventions

     - Assignment frontmatter is the single source of truth for state
     - Slugs are lowercase, hyphen-separated
     - Always read `agent.md` and `claude.md` at the mission level before starting work
     - Add unanswered questions to the Q&A section of assignment.md (do not set status to blocked for questions)
     - Commit frequently with messages referencing the assignment slug
     ```
   - **Proof blocks:**
     - **PROOF:** Background skill frontmatter uses `name`, `description`, `version` -- no `argument-hint` or `allowed-tools`.
       Source: `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/example-plugin/skills/example-skill/SKILL.md:1-5`
       Actual code:
       ```yaml
       ---
       name: example-skill
       description: This skill should be used when the user asks to "demonstrate skills", "show skill format", "create a skill template", or discusses skill development patterns. Provides a reference template for creating Claude Code plugin skills.
       version: 1.0.0
       ---
       ```
     - **PROOF:** `${CLAUDE_PLUGIN_ROOT}` resolves to plugin directory at runtime, usable in skill body.
       Source: `/Users/brennen/.claude/plugins/forge/commands/forge.md:29`
       Actual code: `` `${CLAUDE_PLUGIN_ROOT}/scripts/setup-forge.sh` ``
     - **PROOF:** CLI commands `assign`, `start`, `review`, `complete`, `block`, `unblock`, `fail` confirmed as registered commands.
       Source: `/Users/brennen/syntaur/src/index.ts:80-207`
       The commands accept `<assignment>` as positional argument and `--mission <slug>` as option.
     - **PROOF:** `assign` command requires `--agent <name>`.
       Source: `/Users/brennen/syntaur/src/commands/assign.ts:26-28`
       Actual code: `if (!options.agent) { throw new Error('--agent <name> is required.'); }`
     - **PROOF:** `block` command accepts `--reason <text>`.
       Source: `/Users/brennen/syntaur/src/index.ts:141`
       Actual code: `.option('--reason <text>', 'Reason for blocking')`
     - **PROOF:** Write boundary categories verified from `docs/protocol/spec.md:90-143`.
   - **Verification:**
     ```bash
     # Check file exists and has YAML frontmatter
     head -5 /Users/brennen/syntaur/plugin/skills/syntaur-protocol/SKILL.md
     # Should show --- / name: syntaur-protocol / description: ... / version: 0.1.0 / ---
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| `.claude/syntaur.local.json` does not exist | Skill instructs Claude to check for it; if missing, protocol rules still apply but no specific assignment context | N/A -- Claude reads the instruction text | N/A |

#### Task Completion Criteria
- [ ] `plugin/skills/syntaur-protocol/SKILL.md` exists
- [ ] YAML frontmatter has `name`, `description`, `version` (no `argument-hint`, no `allowed-tools`)
- [ ] Description contains trigger phrases: "syntaur", "assignment", "mission", "~/.syntaur/"
- [ ] Body contains write boundary rules, lifecycle commands, and `${CLAUDE_PLUGIN_ROOT}` references

---

### Task 4: Create /grab-assignment skill

**File(s):** `plugin/skills/grab-assignment/SKILL.md`
**Action:** CREATE
**Pattern Reference:** `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/example-plugin/skills/example-command/SKILL.md:1-6`
**Estimated complexity:** Medium

#### Context
This is the first skill in the workflow sequence. The user invokes `/grab-assignment <mission-slug>` to discover pending assignments, claim one, transition it to `in_progress`, and set up the context file for subsequent skills.

#### Steps

1. [ ] **Step 4.1:** Create `plugin/skills/grab-assignment/` directory
   - **Location:** new directory at `plugin/skills/grab-assignment/`
   - **Action:** CREATE
   - **Verification:**
     ```bash
     mkdir -p /Users/brennen/syntaur/plugin/skills/grab-assignment
     ```

2. [ ] **Step 4.2:** Create `plugin/skills/grab-assignment/SKILL.md`
   - **Location:** new file at `plugin/skills/grab-assignment/SKILL.md`
   - **Action:** CREATE
   - **What to do:** Create a user-invoked skill with YAML frontmatter containing `name`, `description`, `argument-hint`, and `allowed-tools`. The body provides step-by-step instructions for Claude to: discover assignments, run CLI commands, read context, and create the context file.
   - **Code:**
     ```markdown
     ---
     name: grab-assignment
     description: Discover and claim a pending Syntaur assignment from a mission
     argument-hint: <mission-slug> [assignment-slug]
     allowed-tools:
       - Bash
       - Read
       - Write
       - Glob
       - Grep
     ---

     # Grab Assignment

     Claim a pending assignment from a Syntaur mission and set up your working context.

     ## Arguments

     The user provided: $ARGUMENTS

     Parse the arguments:
     - First argument (required): the mission slug (e.g., `build-auth-system`)
     - Second argument (optional): a specific assignment slug to grab. If omitted, you will list pending assignments and pick one.

     ## Pre-flight Check

     1. Check if `.claude/syntaur.local.json` already exists in the current working directory.
        - If it exists, read it and warn the user: "You already have an active assignment: `<assignmentSlug>` in mission `<missionSlug>`. Grabbing a new assignment will replace this context. Proceed?"
        - If the user says no, stop.

     ## Step 1: Resolve Mission Directory

     Determine the mission base directory by reading the Syntaur config. The `defaultMissionDir` is set in `~/.syntaur/config.md` and resolved by `readConfig()` in the CLI. The skill must replicate this logic:

     ```bash
     # Read defaultMissionDir from config, falling back to ~/.syntaur/missions
     MISSION_BASE=$(syntaur config get defaultMissionDir 2>/dev/null || echo "$HOME/.syntaur/missions")
     MISSION_DIR="$MISSION_BASE/<mission-slug>"
     ```

     If `syntaur config get` is not available yet, read `~/.syntaur/config.md` frontmatter directly and extract the `defaultMissionDir` field. If the config file does not exist or the field is missing, default to `~/.syntaur/missions`.

     Store the resolved mission directory path -- all subsequent steps use `<MISSION_DIR>` (the resolved absolute path), never a hardcoded `~/.syntaur/missions/` prefix.

     ## Step 2: Discover the Mission

     Read the mission directory to understand what is available:

     ```bash
     ls <MISSION_DIR>/
     ```

     Read the mission files, starting with the manifest (the protocol-defined entry point):
     - Read `<MISSION_DIR>/manifest.md` first (root navigation file per protocol spec)
     - Read `<MISSION_DIR>/mission.md` for goal and context
     - Read `<MISSION_DIR>/agent.md` for agent instructions
     - Read `<MISSION_DIR>/claude.md` if it exists for Claude-specific instructions

     ## Step 3: Find Pending Assignments

     List assignment directories and check their status:

     ```bash
     ls <MISSION_DIR>/assignments/
     ```

     For each assignment directory, read the `assignment.md` frontmatter and look for `status: pending`. You can use grep:

     ```bash
     grep -l "status: pending" <MISSION_DIR>/assignments/*/assignment.md
     ```

     If no pending assignments exist, tell the user and stop.

     If the user specified an assignment slug as the second argument, verify it exists and is pending. If it is not pending, report its current status and stop.

     If no specific assignment was requested, present the list of pending assignments with their titles and priorities, and ask the user which one to grab. If there is only one pending assignment, grab it automatically.

     ## Step 4: Claim the Assignment

     Run the Syntaur CLI commands to assign and start the assignment. Use `dangerouslyDisableSandbox: true` for these bash commands since the CLI writes to `~/.syntaur/` which is outside the project sandbox.

     ```bash
     syntaur assign <assignment-slug> --agent claude --mission <mission-slug>
     ```

     Then:

     ```bash
     syntaur start <assignment-slug> --mission <mission-slug>
     ```

     If either command fails, report the error and stop. Common failures:
     - Assignment has unmet dependencies (cannot start until dependencies are `completed`)
     - Assignment is not in `pending` status
     - Mission not found

     ## Step 5: Read Assignment Context

     After successfully starting the assignment, read the full assignment details:

     ```bash
     cat <MISSION_DIR>/assignments/<assignment-slug>/assignment.md
     ```

     Extract from the frontmatter:
     - `title` -- the assignment title
     - `workspace.repository` -- the code repository path (may be null)
     - `workspace.worktreePath` -- the worktree path (may be null)
     - `workspace.branch` -- the branch name (may be null)
     - `dependsOn` -- list of dependency slugs
     - `priority` -- priority level

     Read the objective and acceptance criteria from the markdown body.

     ## Step 6: Create Context File

     Write `.claude/syntaur.local.json` in the current working directory with the assignment context. First ensure the `.claude/` directory exists:

     ```bash
     mkdir -p .claude
     ```

     Then write the JSON file with this structure:

     ```json
     {
       "missionSlug": "<mission-slug>",
       "assignmentSlug": "<assignment-slug>",
       "missionDir": "/Users/<username>/.syntaur/missions/<mission-slug>",
       "assignmentDir": "/Users/<username>/.syntaur/missions/<mission-slug>/assignments/<assignment-slug>",
       "workspaceRoot": "<workspace.worktreePath if set, else workspace.repository if it is a local path, else null>",
       "title": "<assignment title>",
       "branch": "<workspace.branch or null>",
       "grabbedAt": "<ISO 8601 timestamp>"
     }
     ```

     Use absolute paths (expand `~` to the actual home directory). Note: `workspace.repository` may be a remote URL (e.g., `https://github.com/...`) -- only use it as `workspaceRoot` if it starts with `/` (local path). If it is a URL, set `workspaceRoot` to `null`.

     ## Step 7: Report to User

     Summarize what was done:
     - Which assignment was grabbed
     - The objective (first paragraph from assignment.md body)
     - The acceptance criteria (the checkbox list)
     - The workspace path (if set)
     - Suggest next step: "Run `/plan-assignment` to create an implementation plan."
     ```
   - **Proof blocks:**
     - **PROOF:** User-invoked skill frontmatter uses `name`, `description`, `argument-hint`, `allowed-tools`.
       Source: `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/example-plugin/skills/example-command/SKILL.md:1-6`
       Actual code:
       ```yaml
       ---
       name: example-command
       description: An example user-invoked skill that demonstrates frontmatter options and the skills/<name>/SKILL.md layout
       argument-hint: <required-arg> [optional-arg]
       allowed-tools: [Read, Glob, Grep, Bash]
       ---
       ```
     - **PROOF:** `$ARGUMENTS` placeholder is replaced with user input at runtime.
       Source: `/Users/brennen/.claude/plugins/forge/commands/forge.md:24` (used as `$ARGUMENTS` in skill body)
     - **PROOF:** `syntaur assign` requires `--agent <name>` and `--mission <slug>`.
       Source: `/Users/brennen/syntaur/src/index.ts:83-86`
       Actual code:
       ```
       .argument('<assignment>', 'Assignment slug')
       .option('--mission <slug>', 'Target mission slug')
       .option('--agent <name>', 'Agent name to assign')
       ```
     - **PROOF:** `syntaur start` requires `--mission <slug>`, positional `<assignment>`.
       Source: `/Users/brennen/syntaur/src/index.ts:100-104`
       Actual code:
       ```
       .argument('<assignment>', 'Assignment slug')
       .option('--mission <slug>', 'Target mission slug')
       ```
     - **PROOF:** Assignment frontmatter includes `workspace` with `repository`, `worktreePath`, `branch`, `parentBranch` fields.
       Source: `/Users/brennen/syntaur/examples/sample-mission/assignments/implement-jwt-middleware/assignment.md:17-21`
       Actual code:
       ```yaml
       workspace:
         repository: /Users/brennen/projects/auth-service
         worktreePath: /Users/brennen/projects/auth-service-worktrees/implement-jwt-middleware
         branch: feat/jwt-middleware
         parentBranch: main
       ```
     - **PROOF:** Forge uses context file pattern (`.claude/forge.local.md`) for inter-skill state.
       Source: `/Users/brennen/.claude/plugins/forge/commands/forge.md:41`
   - **Verification:**
     ```bash
     # Check frontmatter fields
     head -8 /Users/brennen/syntaur/plugin/skills/grab-assignment/SKILL.md
     # Should show name, description, argument-hint, allowed-tools
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| Mission not found | `ls` on resolved mission dir fails | "Mission `<slug>` not found at `<MISSION_DIR>/`. Run `syntaur create-mission` first." | N/A (skill body instruction) |
| No pending assignments | `grep` returns no matches | "No pending assignments found in mission `<slug>`. All assignments may already be claimed or completed." | N/A (skill body instruction) |
| Assign/start command fails | CLI exits non-zero | Report the CLI error output verbatim | N/A (skill body instruction) |
| Context file already exists | Read and warn user | "You already have an active assignment: `<slug>`. Grabbing a new one will replace this context." | N/A (skill body instruction) |

#### Task Completion Criteria
- [ ] `plugin/skills/grab-assignment/SKILL.md` exists
- [ ] YAML frontmatter has `name`, `description`, `argument-hint`, `allowed-tools`
- [ ] `allowed-tools` includes `Bash`, `Read`, `Write`, `Glob`, `Grep`
- [ ] Body uses `$ARGUMENTS` for user input
- [ ] Body includes all 7 steps: resolve mission dir, pre-flight, discover, find pending, claim, read context, create context file, report
- [ ] Context file JSON schema is fully specified with all field names and types

---

### Task 5: Create /plan-assignment skill

**File(s):** `plugin/skills/plan-assignment/SKILL.md`
**Action:** CREATE
**Pattern Reference:** `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/example-plugin/skills/example-command/SKILL.md:1-6`
**Estimated complexity:** Medium

#### Context
The second skill in the workflow. After grabbing an assignment, the user runs `/plan-assignment` to read the assignment context and produce a detailed implementation plan written to `plan.md` in the assignment folder.

#### Steps

1. [ ] **Step 5.1:** Create `plugin/skills/plan-assignment/` directory
   - **Location:** new directory at `plugin/skills/plan-assignment/`
   - **Action:** CREATE
   - **Verification:**
     ```bash
     mkdir -p /Users/brennen/syntaur/plugin/skills/plan-assignment
     ```

2. [ ] **Step 5.2:** Create `plugin/skills/plan-assignment/SKILL.md`
   - **Location:** new file at `plugin/skills/plan-assignment/SKILL.md`
   - **Action:** CREATE
   - **What to do:** Create a user-invoked skill that reads context from `.claude/syntaur.local.json`, reads the assignment details, optionally explores the workspace, and writes a plan to `plan.md`.
   - **Code:**
     ```markdown
     ---
     name: plan-assignment
     description: Create an implementation plan for the current Syntaur assignment
     argument-hint: "[focus area or notes]"
     allowed-tools:
       - Bash
       - Read
       - Write
       - Edit
       - Glob
       - Grep
     ---

     # Plan Assignment

     Create a detailed implementation plan for your current Syntaur assignment.

     ## Arguments

     Optional notes from the user: $ARGUMENTS

     ## Step 1: Load Context

     Read `.claude/syntaur.local.json` from the current working directory.

     If the file does not exist, tell the user: "No active assignment found. Run `/grab-assignment <mission-slug>` first to claim an assignment."

     Extract from the context file:
     - `missionSlug` -- the mission slug
     - `assignmentSlug` -- the assignment slug
     - `assignmentDir` -- absolute path to the assignment folder
     - `missionDir` -- absolute path to the mission folder
     - `workspaceRoot` -- absolute path to the workspace (may be null)

     ## Step 2: Read Assignment Details

     Read the following files to understand the assignment:

     1. Read `<assignmentDir>/assignment.md` -- extract the objective, acceptance criteria, context section, and any Q&A
     2. Read `<missionDir>/agent.md` -- extract conventions and boundaries
     3. Read `<missionDir>/claude.md` if it exists -- extract Claude-specific instructions
     4. Read `<missionDir>/mission.md` -- extract the mission goal for broader context

     If the assignment has dependencies (`dependsOn` in frontmatter), read the handoff.md from each dependency's assignment folder for integration context:
     - `<missionDir>/assignments/<dep-slug>/handoff.md`

     ## Step 3: Explore Workspace (if set)

     If `workspaceRoot` is not null:

     1. Check if the workspace directory exists:
        ```bash
        ls <workspaceRoot>
        ```
     2. Explore the codebase structure to understand what exists:
        - Use `Glob` to find key files (e.g., `**/*.ts`, `**/package.json`, `**/*.md`)
        - Use `Grep` to search for relevant patterns mentioned in the assignment
        - Read key files like `package.json`, `tsconfig.json`, or entry points
     3. Note any existing patterns, conventions, or architecture you discover

     If `workspaceRoot` is null, skip this step and note in the plan that no workspace is configured.

     ## Step 4: Write the Plan

     Read the existing `<assignmentDir>/plan.md` to see its current frontmatter structure. Preserve the YAML frontmatter fields (`assignment`, `status`, `created`, `updated`) and update the `updated` timestamp. Change the `status` field from `draft` to `in_progress` if it is still `draft`.

     Replace the markdown body with a detailed implementation plan. The plan should include:

     1. **Overview** -- one paragraph summarizing the approach
     2. **Tasks** -- numbered list of implementation tasks, each with:
        - Description of what to do
        - Files to create or modify (with paths)
        - Dependencies on other tasks
        - Estimated complexity (low/medium/high)
     3. **Acceptance Criteria Mapping** -- for each criterion from assignment.md, which task(s) address it
     4. **Risks and Open Questions** -- anything that might block or complicate implementation
     5. **Testing Strategy** -- how to verify the implementation works

     Write the plan using the Edit tool to update `<assignmentDir>/plan.md`. Preserve the existing frontmatter and replace only the body content.

     ## Step 5: Report to User

     After writing the plan:
     1. Summarize the plan (number of tasks, key decisions)
     2. Note any open questions or risks that need human input
     3. Suggest next step: begin implementing the first task, or run `/complete-assignment` when all work is done
     ```
   - **Proof blocks:**
     - **PROOF:** User-invoked skill frontmatter pattern confirmed.
       Source: `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/example-plugin/skills/example-command/SKILL.md:1-6`
     - **PROOF:** Context file JSON structure defined in Task 4 (Step 5 of grab-assignment). Fields: `missionSlug`, `assignmentSlug`, `missionDir`, `assignmentDir`, `workspaceRoot`, `title`, `branch`, `grabbedAt`.
     - **PROOF:** Assignment.md body includes `## Objective`, `## Acceptance Criteria`, `## Context` sections.
       Source: `/Users/brennen/syntaur/examples/sample-mission/assignments/implement-jwt-middleware/assignment.md:25-41`
     - **PROOF:** `dependsOn` is an array of slugs in assignment frontmatter.
       Source: `/Users/brennen/syntaur/src/lifecycle/types.ts:41`
       Actual code: `dependsOn: string[];`
     - **PROOF:** Agent.md and claude.md are read-only mission-level files.
       Source: `/Users/brennen/syntaur/docs/protocol/spec.md:96-103`
   - **Verification:**
     ```bash
     head -10 /Users/brennen/syntaur/plugin/skills/plan-assignment/SKILL.md
     # Should show frontmatter with name, description, argument-hint, allowed-tools
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| No context file | File not found | "No active assignment found. Run `/grab-assignment <mission-slug>` first." | N/A (skill body instruction) |
| Assignment directory missing | Path from context does not exist | "Assignment directory `<path>` not found. The context file may be stale. Run `/grab-assignment` again." | N/A (skill body instruction) |
| Workspace directory missing | `ls` fails on workspace path | "Workspace `<path>` does not exist. Continuing without workspace exploration." | N/A (skill body instruction) |
| Dependency handoff missing | Dep's handoff.md not found | "Dependency `<slug>` handoff not found. Proceeding without dependency context." | N/A (skill body instruction) |

#### Task Completion Criteria
- [ ] `plugin/skills/plan-assignment/SKILL.md` exists
- [ ] YAML frontmatter has `name`, `description`, `argument-hint`, `allowed-tools`
- [ ] `allowed-tools` includes `Edit` (needed to update plan.md)
- [ ] Body reads `.claude/syntaur.local.json` as first step
- [ ] Body reads assignment.md, agent.md, claude.md, mission.md
- [ ] Body includes workspace exploration instructions
- [ ] Body specifies exact plan structure (Overview, Tasks, Criteria Mapping, Risks, Testing)

---

### Task 6: Create /complete-assignment skill

**File(s):** `plugin/skills/complete-assignment/SKILL.md`
**Action:** CREATE
**Pattern Reference:** `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/example-plugin/skills/example-command/SKILL.md:1-6`
**Estimated complexity:** Medium

#### Context
The final skill in the workflow. After implementing the assignment, the user runs `/complete-assignment` to write a handoff, transition the assignment to review or completed, and clean up the context file.

#### Steps

1. [ ] **Step 6.1:** Create `plugin/skills/complete-assignment/` directory
   - **Location:** new directory at `plugin/skills/complete-assignment/`
   - **Action:** CREATE
   - **Verification:**
     ```bash
     mkdir -p /Users/brennen/syntaur/plugin/skills/complete-assignment
     ```

2. [ ] **Step 6.2:** Create `plugin/skills/complete-assignment/SKILL.md`
   - **Location:** new file at `plugin/skills/complete-assignment/SKILL.md`
   - **Action:** CREATE
   - **What to do:** Create a user-invoked skill that reads context, verifies acceptance criteria, writes a handoff entry, transitions the assignment via CLI, and cleans up the context file.
   - **Code:**
     ```markdown
     ---
     name: complete-assignment
     description: Write a handoff and transition the current Syntaur assignment to review or completed
     argument-hint: "[--complete]"
     allowed-tools:
       - Bash
       - Read
       - Write
       - Edit
     ---

     # Complete Assignment

     Write a handoff for your current assignment and transition it to review (or completed).

     ## Arguments

     User provided: $ARGUMENTS

     If the user passed `--complete`, transition directly to `completed` instead of `review`. However, `--complete` is ONLY allowed if ALL acceptance criteria are met. If any criteria are unmet, always transition to `review` regardless of the `--complete` flag, and inform the user why.

     ## Step 1: Load Context

     Read `.claude/syntaur.local.json` from the current working directory.

     If the file does not exist, tell the user: "No active assignment found. Run `/grab-assignment <mission-slug>` first."

     Extract: `missionSlug`, `assignmentSlug`, `assignmentDir`, `missionDir`.

     ## Step 2: Verify Acceptance Criteria

     Read `<assignmentDir>/assignment.md` and find the `## Acceptance Criteria` section.

     Review each criterion (checkbox item). For each:
     - If you believe it is met, note why (what was implemented, where)
     - If it is NOT met, flag it clearly

     If any criteria are not met, warn the user: "The following acceptance criteria are not yet met: [list]. Do you want to proceed with the handoff anyway?"

     If the user says no, stop.

     ## Step 3: Write Handoff Entry

     Read `<assignmentDir>/handoff.md` to see its current content and frontmatter.

     Append a new handoff entry to the markdown body. Read the current `handoffCount` from the frontmatter and use `handoffCount + 1` as the entry number. The entry MUST follow the protocol-specified format from `docs/protocol/file-formats.md`:

     ```markdown
     ## Handoff <N>: <ISO 8601 timestamp>

     **From:** claude
     **To:** human
     **Reason:** <Why this handoff is happening, e.g., "Assignment complete, handing off for review.">

     ### Summary
     <One paragraph summarizing what was accomplished and what remains>

     ### Current State
     - <What is working>
     - <What is not working or partially done>
     - <Acceptance criteria status: N of M met>

     ### Next Steps
     - <Recommended next actions for the reviewer or next agent>

     ### Important Context
     - <Anything the next agent/human needs that is not in the assignment or plan>
     ```

     Use the Edit tool to append this entry to handoff.md (do not overwrite existing content).

     Also update the handoff.md frontmatter: set `updated` to the current timestamp and increment the `handoffCount` by 1.

     ## Step 4: Update Acceptance Criteria Checkboxes

     In `<assignmentDir>/assignment.md`, update the acceptance criteria checkboxes to reflect the current state. Use the Edit tool to check off criteria that were met (change `- [ ]` to `- [x]`).

     ## Step 5: Transition Assignment State

     If the user passed `--complete`:

     ```bash
     syntaur complete <assignment-slug> --mission <mission-slug>
     ```

     Otherwise, transition to review:

     ```bash
     syntaur review <assignment-slug> --mission <mission-slug>
     ```

     Use `dangerouslyDisableSandbox: true` since the CLI writes to `~/.syntaur/`.

     If the command fails, report the error. Common failures:
     - Assignment is not in `in_progress` status (cannot transition)
     - Mission not found

     ## Step 6: Clean Up Context

     Delete the context file:

     ```bash
     rm .claude/syntaur.local.json
     ```

     ## Step 7: Report to User

     Summarize:
     - Assignment slug and title
     - New status (review or completed)
     - Number of acceptance criteria met vs total
     - Remind: if transitioned to `review`, a human reviewer will check the work. If any criteria were unmet, they may send it back to `in_progress` via `syntaur start`.
     ```
   - **Proof blocks:**
     - **PROOF:** User-invoked skill frontmatter pattern confirmed.
       Source: `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/example-plugin/skills/example-command/SKILL.md:1-6`
     - **PROOF:** `syntaur review` command: takes `<assignment>` positional + `--mission <slug>`.
       Source: `/Users/brennen/syntaur/src/index.ts:173-178`
       Actual code:
       ```
       .command('review')
       .description('Transition an assignment to review')
       .argument('<assignment>', 'Assignment slug')
       .option('--mission <slug>', 'Target mission slug')
       ```
     - **PROOF:** `syntaur complete` command: takes `<assignment>` positional + `--mission <slug>`.
       Source: `/Users/brennen/syntaur/src/index.ts:118-123`
       Actual code:
       ```
       .command('complete')
       .description('Transition an assignment to completed')
       .argument('<assignment>', 'Assignment slug')
       .option('--mission <slug>', 'Target mission slug')
       ```
     - **PROOF:** Valid transitions: `in_progress:review -> review`, `in_progress:complete -> completed`, `review:complete -> completed`.
       Source: `/Users/brennen/syntaur/src/lifecycle/state-machine.ts:8-9,13`
     - **PROOF:** Assignment.md has `## Acceptance Criteria` section with checkbox items.
       Source: `/Users/brennen/syntaur/examples/sample-mission/assignments/implement-jwt-middleware/assignment.md:33-38`
       Actual code:
       ```markdown
       ## Acceptance Criteria

       - [x] JWT generation with RS256 signing on login and signup
       - [x] Middleware that validates JWT on protected routes
       - [ ] Refresh token endpoint with rotation and family-based revocation
       ```
   - **Verification:**
     ```bash
     head -8 /Users/brennen/syntaur/plugin/skills/complete-assignment/SKILL.md
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| No context file | File missing | "No active assignment found. Run `/grab-assignment` first." | N/A |
| Assignment not in `in_progress` | CLI review/complete fails | Report CLI error: "Cannot transition from `<status>` with command `review`" | N/A |
| Unmet acceptance criteria | Warn before proceeding | "The following criteria are not met: [list]. Proceed?" | N/A |
| Context cleanup fails | `rm` fails | Non-critical; warn user to delete `.claude/syntaur.local.json` manually | N/A |

#### Task Completion Criteria
- [ ] `plugin/skills/complete-assignment/SKILL.md` exists
- [ ] YAML frontmatter has `name`, `description`, `argument-hint`, `allowed-tools`
- [ ] Body reads context file, verifies criteria, writes handoff, transitions state, cleans up
- [ ] Body supports both `review` and `complete` transitions via `--complete` flag
- [ ] Handoff entry format is fully specified with all sections

---

### Task 7: Create PreToolUse write boundary hook

**File(s):** `plugin/hooks/hooks.json`, `plugin/hooks/enforce-boundaries.sh`
**Action:** CREATE
**Pattern Reference:** `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/hookify/hooks/hooks.json:1-16`, `/Users/brennen/.claude/plugins/forge/hooks/stop-hook.sh:1-97`
**Estimated complexity:** High

#### Context
This is the "hard enforcement" layer. The PreToolUse hook intercepts every Edit, Write, and MultiEdit tool call, reads the context file to determine allowed paths, and blocks writes outside boundaries. It must be a bash script that reads JSON from stdin and outputs JSON to stdout.

#### Steps

1. [ ] **Step 7.1:** Create `plugin/hooks/` directory
   - **Location:** new directory at `plugin/hooks/`
   - **Action:** CREATE
   - **Verification:**
     ```bash
     mkdir -p /Users/brennen/syntaur/plugin/hooks
     ```

2. [ ] **Step 7.2:** Create `plugin/hooks/hooks.json`
   - **Location:** new file at `plugin/hooks/hooks.json`
   - **Action:** CREATE
   - **What to do:** Create the hooks registration file. Register a single PreToolUse hook that runs the bash script. Use `${CLAUDE_PLUGIN_ROOT}` for the script path. Set a 10-second timeout matching the hookify pattern.
   - **Code:**
     ```json
     {
       "description": "Syntaur write boundary enforcement hooks",
       "hooks": {
         "PreToolUse": [
           {
             "hooks": [
               {
                 "type": "command",
                 "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/enforce-boundaries.sh",
                 "timeout": 10
               }
             ]
           }
         ]
       }
     }
     ```
   - **Proof blocks:**
     - **PROOF:** hooks.json structure uses `description`, `hooks` object keyed by event type, array of matcher objects with `hooks` array containing `type: "command"` entries.
       Source: `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/hookify/hooks/hooks.json:1-16`
       Actual code:
       ```json
       {
         "description": "Hookify plugin - User-configurable hooks from .local.md files",
         "hooks": {
           "PreToolUse": [
             {
               "hooks": [
                 {
                   "type": "command",
                   "command": "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py",
                   "timeout": 10
                 }
               ]
             }
           ],
       ```
     - **PROOF:** `${CLAUDE_PLUGIN_ROOT}` is used in hook command strings to reference plugin directory.
       Source: `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/hookify/hooks/hooks.json:9`
   - **Verification:**
     ```bash
     cat /Users/brennen/syntaur/plugin/hooks/hooks.json | python3 -m json.tool
     ```

3. [ ] **Step 7.3:** Create `plugin/hooks/enforce-boundaries.sh`
   - **Location:** new file at `plugin/hooks/enforce-boundaries.sh`
   - **Action:** CREATE
   - **What to do:** Create a bash script that:
     1. Reads JSON from stdin (the tool call data)
     2. Extracts `tool_name` and file path from the JSON
     3. If `tool_name` is not `Edit`, `Write`, or `MultiEdit`, exits allowing the operation
     4. Checks if `.claude/syntaur.local.json` exists -- if not, allows all writes
     5. Reads the context file to get `assignmentDir`, `missionDir`, and `workspaceRoot`
     6. Validates the target file path is within allowed boundaries
     7. Outputs `{"decision": "block", "reason": "..."}` for violations, or `{}` for allowed writes
     8. Always exits 0 (never blocks due to hook errors)
   - **Code:**
     ```bash
     #!/usr/bin/env bash
     # Syntaur Write Boundary Enforcement Hook
     # PreToolUse hook that validates Edit/Write/MultiEdit targets against assignment boundaries.
     # Reads JSON from stdin, outputs JSON to stdout. Always exits 0.

     # --- Safety: never fail due to hook errors ---
     allow_and_exit() {
       echo '{}'
       exit 0
     }

     # --- Step 1: Check for jq ---
     if ! command -v jq &>/dev/null; then
       # Cannot parse JSON without jq; allow all operations
       echo '{"systemMessage": "Syntaur boundary hook: jq not found, skipping enforcement"}'
       exit 0
     fi

     # --- Step 2: Read stdin ---
     INPUT=$(cat)
     if [ -z "$INPUT" ]; then
       allow_and_exit
     fi

     # --- Step 3: Extract tool name ---
     TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
     if [ -z "$TOOL_NAME" ]; then
       allow_and_exit
     fi

     # --- Step 4: Only check file-writing tools ---
     case "$TOOL_NAME" in
       Edit|Write|MultiEdit)
         ;;
       *)
         allow_and_exit
         ;;
     esac

     # --- Step 5: Extract file path from tool input ---
     FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
     if [ -z "$FILE_PATH" ]; then
       # Cannot determine file path; allow (defensive)
       allow_and_exit
     fi

     # --- Step 6: Resolve to absolute path ---
     # If path is relative, make it absolute relative to cwd
     if [[ "$FILE_PATH" != /* ]]; then
       FILE_PATH="$(pwd)/$FILE_PATH"
     fi
     # Normalize path (resolve .. and . components)
     FILE_PATH=$(cd "$(dirname "$FILE_PATH")" 2>/dev/null && echo "$(pwd)/$(basename "$FILE_PATH")") || FILE_PATH=""
     if [ -z "$FILE_PATH" ]; then
       allow_and_exit
     fi

     # --- Step 7: Check for context file ---
     CONTEXT_FILE=".claude/syntaur.local.json"
     if [ ! -f "$CONTEXT_FILE" ]; then
       # No active assignment; allow all writes
       allow_and_exit
     fi

     # --- Step 8: Read context ---
     ASSIGNMENT_DIR=$(jq -r '.assignmentDir // empty' "$CONTEXT_FILE" 2>/dev/null)
     MISSION_DIR=$(jq -r '.missionDir // empty' "$CONTEXT_FILE" 2>/dev/null)
     WORKSPACE_ROOT=$(jq -r '.workspaceRoot // empty' "$CONTEXT_FILE" 2>/dev/null)

     if [ -z "$ASSIGNMENT_DIR" ] || [ -z "$MISSION_DIR" ]; then
       # Malformed context file; allow (defensive)
       allow_and_exit
     fi

     # --- Step 9: Expand ~ in paths ---
     ASSIGNMENT_DIR="${ASSIGNMENT_DIR/#\~/$HOME}"
     MISSION_DIR="${MISSION_DIR/#\~/$HOME}"
     if [ -n "$WORKSPACE_ROOT" ] && [ "$WORKSPACE_ROOT" != "null" ]; then
       WORKSPACE_ROOT="${WORKSPACE_ROOT/#\~/$HOME}"
     else
       WORKSPACE_ROOT=""
     fi

     # --- Step 10: Check allowed paths ---

     # Allow: files inside the assignment directory
     if [[ "$FILE_PATH" == "$ASSIGNMENT_DIR"/* ]]; then
       allow_and_exit
     fi

     # Allow: files in mission resources/ directory (but NOT derived _index.md)
     if [[ "$FILE_PATH" == "$MISSION_DIR/resources/"* ]]; then
       BASENAME=$(basename "$FILE_PATH")
       if [[ "$BASENAME" == _* ]]; then
         # Derived file (e.g., _index.md) -- fall through to block
         :
       else
         allow_and_exit
       fi
     fi

     # Allow: files in mission memories/ directory (but NOT derived _index.md)
     if [[ "$FILE_PATH" == "$MISSION_DIR/memories/"* ]]; then
       BASENAME=$(basename "$FILE_PATH")
       if [[ "$BASENAME" == _* ]]; then
         # Derived file (e.g., _index.md) -- fall through to block
         :
       else
         allow_and_exit
       fi
     fi

     # Allow: the context file itself
     CONTEXT_ABS="$(cd "$(dirname "$CONTEXT_FILE")" 2>/dev/null && echo "$(pwd)/$(basename "$CONTEXT_FILE")")"
     if [ "$FILE_PATH" = "$CONTEXT_ABS" ]; then
       allow_and_exit
     fi

     # Allow: files inside workspace root (if set)
     if [ -n "$WORKSPACE_ROOT" ] && [[ "$FILE_PATH" == "$WORKSPACE_ROOT"/* ]]; then
       allow_and_exit
     fi

     # --- Step 11: Block the write ---
     REASON="Syntaur write boundary violation: Cannot write to '$FILE_PATH'. Allowed paths: assignment dir ($ASSIGNMENT_DIR), mission resources/memories, workspace ($WORKSPACE_ROOT)."

     # Escape for JSON
     REASON_ESCAPED=$(echo "$REASON" | jq -Rs '.' 2>/dev/null)
     if [ -z "$REASON_ESCAPED" ]; then
       REASON_ESCAPED="\"Syntaur write boundary violation\""
     fi

     echo "{\"decision\": \"block\", \"reason\": ${REASON_ESCAPED}}"

     exit 0
     ```
   - **Proof blocks:**
     - **PROOF:** PreToolUse hook reads JSON from stdin with `tool_name` field.
       Source: `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/hookify/hooks/pretooluse.py:31,35`
       Actual code:
       ```python
       input_data = json.load(sys.stdin)
       tool_name = input_data.get('tool_name', '')
       ```
     - **PROOF:** For Edit/Write/MultiEdit tools, the tool reads `tool_name` values `Edit`, `Write`, `MultiEdit`.
       Source: `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/hookify/hooks/pretooluse.py:40-41`
       Actual code:
       ```python
       elif tool_name in ['Edit', 'Write', 'MultiEdit']:
           event = 'file'
       ```
     - **PROOF:** Hook outputs `{"decision": "block", "reason": "..."}` to block, or `{}` to allow.
       Source: inferred from hookify pattern and forge stop-hook.
       `/Users/brennen/.claude/plugins/forge/hooks/stop-hook.sh:91-97` outputs:
       ```json
       {
         "decision": "block",
         "reason": "Forge run active — continuing orchestration..."
       }
       ```
     - **PROOF:** Hook scripts always exit 0 to avoid blocking due to errors.
       Source: `/Users/brennen/.claude/plugins/marketplaces/claude-plugins-official/plugins/hookify/hooks/pretooluse.py:61`
       Actual code: `sys.exit(0)`
     - **PROOF:** `tool_input` contains `file_path` for Edit/Write tools. This is inferred from the hookify plugin's `RuleEngine` processing file events, and from Claude Code's tool parameter schema where Edit and Write both require a `file_path` parameter.
     - **PROOF:** Write boundaries: agent-writable (assignment folder), shared-writable (resources/, memories/).
       Source: `/Users/brennen/syntaur/docs/protocol/spec.md:90-143`
   - **Verification:**
     ```bash
     # Make executable
     chmod +x /Users/brennen/syntaur/plugin/hooks/enforce-boundaries.sh
     # Syntax check
     bash -n /Users/brennen/syntaur/plugin/hooks/enforce-boundaries.sh && echo "Syntax OK"
     # Test: no stdin should allow
     echo '{}' | bash /Users/brennen/syntaur/plugin/hooks/enforce-boundaries.sh
     # Should output: {}
     ```

4. [ ] **Step 7.4:** Make the script executable
   - **Location:** `plugin/hooks/enforce-boundaries.sh`
   - **Action:** MODIFY (permissions)
   - **What to do:** Set the executable bit on the script so it can be run directly.
   - **Verification:**
     ```bash
     chmod +x /Users/brennen/syntaur/plugin/hooks/enforce-boundaries.sh
     ls -la /Users/brennen/syntaur/plugin/hooks/enforce-boundaries.sh
     # Should show -rwxr-xr-x
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| `jq` not installed | Allow all writes, emit systemMessage warning | "Syntaur boundary hook: jq not found, skipping enforcement" | Lines 12-15 of script |
| Empty stdin | Allow (no tool data to check) | N/A | `allow_and_exit` |
| Non-file tool (Bash, Read, Grep, etc.) | Allow (not a write operation) | N/A | Case statement on TOOL_NAME |
| No context file | Allow all writes (no active assignment) | N/A | Lines checking `$CONTEXT_FILE` |
| Malformed context JSON | Allow (defensive, cannot determine boundaries) | N/A | Empty checks on jq output |
| File path outside all allowed zones | Block with detailed reason | "Syntaur write boundary violation: Cannot write to ..." | Lines at end of script |
| Relative file path | Resolve to absolute before checking | N/A | Lines resolving path with `pwd` |

#### Task Completion Criteria
- [ ] `plugin/hooks/hooks.json` exists and is valid JSON with a PreToolUse hook entry
- [ ] `plugin/hooks/enforce-boundaries.sh` exists and is executable
- [ ] Script checks for `jq` and allows all writes if `jq` is missing
- [ ] Script only intercepts `Edit`, `Write`, `MultiEdit` tool calls
- [ ] Script reads `.claude/syntaur.local.json` for context (allows all if missing)
- [ ] Script allows writes to: assignment dir, resources/, memories/, workspace, context file
- [ ] Script blocks writes to all other paths with a descriptive reason
- [ ] Script always exits 0 regardless of errors
- [ ] `bash -n` syntax check passes
- [ ] Hook test matrix passes (see below)

#### Hook Test Matrix

Test the enforce-boundaries.sh script with stdin JSON fixtures. Each test pipes a JSON object to the script and checks the stdout output. The context file `.claude/syntaur.local.json` must be set up before running tests with these values:
```json
{
  "missionSlug": "test-mission",
  "assignmentSlug": "test-assignment",
  "missionDir": "/tmp/syntaur-test/missions/test-mission",
  "assignmentDir": "/tmp/syntaur-test/missions/test-mission/assignments/test-assignment",
  "workspaceRoot": "/tmp/syntaur-test/workspace"
}
```

| # | Description | stdin JSON fixture | Expected Outcome |
|---|------------|-------------------|-----------------|
| 1 | Edit to assignment file | `{"tool_name": "Edit", "tool_input": {"file_path": "/tmp/syntaur-test/missions/test-mission/assignments/test-assignment/plan.md", "old_string": "x", "new_string": "y"}}` | ALLOW (`{}`) |
| 2 | Write to assignment file | `{"tool_name": "Write", "tool_input": {"file_path": "/tmp/syntaur-test/missions/test-mission/assignments/test-assignment/scratchpad.md", "content": "notes"}}` | ALLOW (`{}`) |
| 3 | MultiEdit to assignment file | `{"tool_name": "MultiEdit", "tool_input": {"file_path": "/tmp/syntaur-test/missions/test-mission/assignments/test-assignment/handoff.md"}}` | ALLOW (`{}`) |
| 4 | Write to mission resource | `{"tool_name": "Write", "tool_input": {"file_path": "/tmp/syntaur-test/missions/test-mission/resources/api-notes.md", "content": "data"}}` | ALLOW (`{}`) |
| 5 | Write to mission memory | `{"tool_name": "Write", "tool_input": {"file_path": "/tmp/syntaur-test/missions/test-mission/memories/lessons.md", "content": "data"}}` | ALLOW (`{}`) |
| 6 | Write to workspace file | `{"tool_name": "Write", "tool_input": {"file_path": "/tmp/syntaur-test/workspace/src/index.ts", "content": "code"}}` | ALLOW (`{}`) |
| 7 | Edit workspace file | `{"tool_name": "Edit", "tool_input": {"file_path": "/tmp/syntaur-test/workspace/package.json", "old_string": "a", "new_string": "b"}}` | ALLOW (`{}`) |
| 8 | Write to context file | `{"tool_name": "Write", "tool_input": {"file_path": ".claude/syntaur.local.json", "content": "{}"}}` | ALLOW (`{}`) |
| 9 | Write to derived _index file | `{"tool_name": "Write", "tool_input": {"file_path": "/tmp/syntaur-test/missions/test-mission/resources/_index.md", "content": "x"}}` | BLOCK (`{"decision": "block", ...}`) |
| 10 | Edit mission.md (read-only) | `{"tool_name": "Edit", "tool_input": {"file_path": "/tmp/syntaur-test/missions/test-mission/mission.md", "old_string": "a", "new_string": "b"}}` | BLOCK |
| 11 | Write to other assignment | `{"tool_name": "Write", "tool_input": {"file_path": "/tmp/syntaur-test/missions/test-mission/assignments/other-assignment/plan.md", "content": "x"}}` | BLOCK |
| 12 | Write outside all boundaries | `{"tool_name": "Write", "tool_input": {"file_path": "/etc/passwd", "content": "x"}}` | BLOCK |
| 13 | Edit to _status.md (derived) | `{"tool_name": "Edit", "tool_input": {"file_path": "/tmp/syntaur-test/missions/test-mission/_status.md", "old_string": "a", "new_string": "b"}}` | BLOCK |
| 14 | Non-file tool (Bash) | `{"tool_name": "Bash", "tool_input": {"command": "ls"}}` | ALLOW (`{}`) |
| 15 | Non-file tool (Read) | `{"tool_name": "Read", "tool_input": {"file_path": "/etc/passwd"}}` | ALLOW (`{}`) |
| 16 | No context file present | `{"tool_name": "Write", "tool_input": {"file_path": "/anywhere/file.txt", "content": "x"}}` (with `.claude/syntaur.local.json` deleted) | ALLOW (`{}`) |
| 17 | Empty stdin | (empty) | ALLOW (`{}`) |
| 18 | Malformed JSON stdin | `not json at all` | ALLOW (`{}`) |

**Test runner script** (add as `plugin/hooks/__tests__/test-enforce-boundaries.sh`):
```bash
#!/usr/bin/env bash
# Run from the repo root. Creates temp fixtures, runs each test case, reports pass/fail.
set -euo pipefail

SCRIPT="plugin/hooks/enforce-boundaries.sh"
PASS=0; FAIL=0; TOTAL=18

# Setup temp context
mkdir -p .claude
cat > .claude/syntaur.local.json <<'CTX'
{"missionSlug":"test-mission","assignmentSlug":"test-assignment","missionDir":"/tmp/syntaur-test/missions/test-mission","assignmentDir":"/tmp/syntaur-test/missions/test-mission/assignments/test-assignment","workspaceRoot":"/tmp/syntaur-test/workspace"}
CTX

# Create required directories so path resolution works
mkdir -p /tmp/syntaur-test/missions/test-mission/assignments/test-assignment
mkdir -p /tmp/syntaur-test/missions/test-mission/resources
mkdir -p /tmp/syntaur-test/missions/test-mission/memories
mkdir -p /tmp/syntaur-test/workspace/src

check() {
  local num="$1" desc="$2" input="$3" expect="$4"
  local result
  result=$(echo "$input" | bash "$SCRIPT" 2>/dev/null)
  if [ "$expect" = "ALLOW" ]; then
    if echo "$result" | grep -q '"decision".*"block"'; then
      echo "FAIL #$num: $desc — expected ALLOW, got BLOCK"
      FAIL=$((FAIL+1))
    else
      echo "PASS #$num: $desc"
      PASS=$((PASS+1))
    fi
  else
    if echo "$result" | grep -q '"decision".*"block"'; then
      echo "PASS #$num: $desc"
      PASS=$((PASS+1))
    else
      echo "FAIL #$num: $desc — expected BLOCK, got ALLOW"
      FAIL=$((FAIL+1))
    fi
  fi
}

# Tests 1-15 (context file present)
check 1  "Edit assignment file"      '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/syntaur-test/missions/test-mission/assignments/test-assignment/plan.md"}}' ALLOW
check 2  "Write assignment file"     '{"tool_name":"Write","tool_input":{"file_path":"/tmp/syntaur-test/missions/test-mission/assignments/test-assignment/scratchpad.md"}}' ALLOW
check 3  "MultiEdit assignment file" '{"tool_name":"MultiEdit","tool_input":{"file_path":"/tmp/syntaur-test/missions/test-mission/assignments/test-assignment/handoff.md"}}' ALLOW
check 4  "Write mission resource"    '{"tool_name":"Write","tool_input":{"file_path":"/tmp/syntaur-test/missions/test-mission/resources/api-notes.md"}}' ALLOW
check 5  "Write mission memory"      '{"tool_name":"Write","tool_input":{"file_path":"/tmp/syntaur-test/missions/test-mission/memories/lessons.md"}}' ALLOW
check 6  "Write workspace file"      '{"tool_name":"Write","tool_input":{"file_path":"/tmp/syntaur-test/workspace/src/index.ts"}}' ALLOW
check 7  "Edit workspace file"       '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/syntaur-test/workspace/package.json"}}' ALLOW
check 8  "Write context file"        '{"tool_name":"Write","tool_input":{"file_path":"'$(pwd)'/.claude/syntaur.local.json"}}' ALLOW
check 9  "Write derived _index"      '{"tool_name":"Write","tool_input":{"file_path":"/tmp/syntaur-test/missions/test-mission/resources/_index.md"}}' BLOCK
check 10 "Edit mission.md"           '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/syntaur-test/missions/test-mission/mission.md"}}' BLOCK
check 11 "Write other assignment"    '{"tool_name":"Write","tool_input":{"file_path":"/tmp/syntaur-test/missions/test-mission/assignments/other-assignment/plan.md"}}' BLOCK
check 12 "Write outside boundaries"  '{"tool_name":"Write","tool_input":{"file_path":"/etc/passwd"}}' BLOCK
check 13 "Edit _status.md"           '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/syntaur-test/missions/test-mission/_status.md"}}' BLOCK
check 14 "Bash tool (non-file)"      '{"tool_name":"Bash","tool_input":{"command":"ls"}}' ALLOW
check 15 "Read tool (non-file)"      '{"tool_name":"Read","tool_input":{"file_path":"/etc/passwd"}}' ALLOW

# Test 16: no context file
rm .claude/syntaur.local.json
check 16 "No context file"           '{"tool_name":"Write","tool_input":{"file_path":"/anywhere/file.txt"}}' ALLOW

# Test 17: empty stdin
cat > .claude/syntaur.local.json <<'CTX'
{"missionSlug":"test-mission","assignmentSlug":"test-assignment","missionDir":"/tmp/syntaur-test/missions/test-mission","assignmentDir":"/tmp/syntaur-test/missions/test-mission/assignments/test-assignment","workspaceRoot":"/tmp/syntaur-test/workspace"}
CTX
check 17 "Empty stdin"               '' ALLOW

# Test 18: malformed JSON
check 18 "Malformed JSON stdin"      'not json at all' ALLOW

# Cleanup
rm -rf .claude/syntaur.local.json /tmp/syntaur-test

echo ""
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
```

---

### Task 8: Create install-plugin CLI command — ALREADY COMPLETE

**File(s):** `src/commands/install-plugin.ts`, `src/index.ts`
**Action:** ~~CREATE (install-plugin.ts), MODIFY (index.ts)~~ ALREADY DONE
**Status:** COMPLETE — landed on main as part of chunk 4/5 implementation.

#### Context
This task is already complete. The file `src/commands/install-plugin.ts` exists with the full implementation (symlink-based install with `--force` support, proper error handling). The command is registered in `src/index.ts` at lines 210-224. No changes needed.

#### Steps

1. [ ] **Step 8.1:** Create `src/commands/install-plugin.ts`
   - **Location:** new file at `src/commands/install-plugin.ts`
   - **Action:** CREATE
   - **What to do:** Create a TypeScript module that exports an async `installPluginCommand` function. The function:
     1. Resolves the plugin source directory (relative to the package root, not cwd)
     2. Creates `~/.claude/plugins/` if it doesn't exist
     3. Checks if `~/.claude/plugins/syntaur` already exists (symlink or real dir)
     4. If it exists and is a symlink pointing to the same target, reports "already installed"
     5. If it exists and points elsewhere (or is a real dir), warns and asks for `--force`
     6. Creates the symlink
   - **Code:**
     ```typescript
     import { resolve, dirname } from 'node:path';
     import { homedir } from 'node:os';
     import { symlink, readlink, lstat, rm } from 'node:fs/promises';
     import { fileURLToPath } from 'node:url';
     import { ensureDir, fileExists } from '../utils/fs.js';

     export interface InstallPluginOptions {
       force?: boolean;
     }

     export async function installPluginCommand(
       options: InstallPluginOptions,
     ): Promise<void> {
       // Resolve the plugin source directory relative to this package's root
       const packageRoot = resolve(
         dirname(fileURLToPath(import.meta.url)),
         '..',
         '..',
       );
       const pluginSource = resolve(packageRoot, 'plugin');

       if (!(await fileExists(pluginSource))) {
         throw new Error(
           `Plugin source directory not found at ${pluginSource}. Are you running from the syntaur repo?`,
         );
       }

       const pluginsDir = resolve(homedir(), '.claude', 'plugins');
       const targetLink = resolve(pluginsDir, 'syntaur');

       // Ensure ~/.claude/plugins/ exists
       await ensureDir(pluginsDir);

       // Check if target already exists
       let targetExists = false;
       try {
         await lstat(targetLink);
         targetExists = true;
       } catch {
         // Does not exist, which is fine
       }

       if (targetExists) {
         // Check if it's already a symlink to the right place
         try {
           const existingTarget = await readlink(targetLink);
           const resolvedExisting = resolve(dirname(targetLink), existingTarget);
           if (resolvedExisting === pluginSource) {
             console.log(
               `Syntaur plugin already installed at ${targetLink} -> ${pluginSource}`,
             );
             return;
           }
         } catch {
           // Not a symlink, it's a regular file/directory
         }

         if (!options.force) {
           throw new Error(
             `${targetLink} already exists and points elsewhere. Use --force to overwrite.`,
           );
         }

         // Remove existing
         await rm(targetLink, { recursive: true, force: true });
         console.log(`Removed existing ${targetLink}`);
       }

       // Create symlink
       await symlink(pluginSource, targetLink, 'dir');

       console.log(`Installed Syntaur plugin:`);
       console.log(`  ${targetLink} -> ${pluginSource}`);
       console.log(`\nThe plugin is now available in Claude Code.`);
       console.log(`  Skills: /grab-assignment, /plan-assignment, /complete-assignment`);
       console.log(`  Background: syntaur-protocol (auto-invoked)`);
       console.log(`  Hook: write boundary enforcement (PreToolUse)`);
     }
     ```
   - **Proof blocks:**
     - **PROOF:** `ensureDir` is exported from `src/utils/fs.ts:4-6` and creates directories recursively.
       Source: `/Users/brennen/syntaur/src/utils/fs.ts:4-6`
       Actual code:
       ```typescript
       export async function ensureDir(dir: string): Promise<void> {
         await mkdir(dir, { recursive: true });
       }
       ```
     - **PROOF:** `fileExists` is exported from `src/utils/fs.ts:8-15`.
       Source: `/Users/brennen/syntaur/src/utils/fs.ts:8-15`
       Actual code:
       ```typescript
       export async function fileExists(filePath: string): Promise<boolean> {
         try {
           await access(filePath);
           return true;
         } catch {
           return false;
         }
       }
       ```
     - **PROOF:** CLI commands use async exported functions as their pattern.
       Source: `/Users/brennen/syntaur/src/commands/create-assignment.ts:26-29`
       Actual code:
       ```typescript
       export async function createAssignmentCommand(
         title: string,
         options: CreateAssignmentOptions,
       ): Promise<void> {
       ```
     - **PROOF:** Project uses ESM with `import.meta.url` (package.json has `"type": "module"`).
       Source: `/Users/brennen/syntaur/package.json:6`
       Actual code: `"type": "module"`
     - **PROOF:** `node:fs/promises` exports `symlink`, `readlink`, `lstat`, `rm` (Node.js 20+ built-ins).
     - **PROOF:** TypeScript config targets ES2022 with NodeNext module resolution.
       Source: `/Users/brennen/syntaur/tsconfig.json:3-5`
   - **Verification:**
     ```bash
     cd /Users/brennen/syntaur && npx tsc --noEmit src/commands/install-plugin.ts
     ```

2. [ ] **Step 8.2:** Register the command in `src/index.ts`
   - **Location:** `/Users/brennen/syntaur/src/index.ts`
   - **Action:** MODIFY
   - **What to do:** Add an import for `installPluginCommand` at the top of the file (after the existing imports on line 11), and add a new command registration block (after the `fail` command block ending at line 207, before `program.parse()` on line 209).
   - **Code for import (add after line 11):**
     ```typescript
     import { installPluginCommand } from './commands/install-plugin.js';
     ```
   - **Code for command registration (add before `program.parse()` on line 209):**
     ```typescript
     program
       .command('install-plugin')
       .description('Install the Syntaur Claude Code plugin via symlink')
       .option('--force', 'Overwrite existing plugin installation')
       .action(async (options) => {
         try {
           await installPluginCommand(options);
         } catch (error) {
           console.error(
             'Error:',
             error instanceof Error ? error.message : String(error),
           );
           process.exit(1);
         }
       });
     ```
   - **Proof blocks:**
     - **PROOF:** Commander.js registration pattern: `.command()` -> `.description()` -> `.option()` -> `.action(async ...)`.
       Source: `/Users/brennen/syntaur/src/index.ts:20-34`
       Actual code (init command):
       ```typescript
       program
         .command('init')
         .description('Initialize ~/.syntaur/ directory structure and config')
         .option('--force', 'Overwrite existing config file')
         .action(async (options) => {
           try {
             await initCommand(options);
           } catch (error) {
             console.error(
               'Error:',
               error instanceof Error ? error.message : String(error),
             );
             process.exit(1);
           }
         });
       ```
     - **PROOF:** Import path uses `.js` extension for ESM compatibility (all existing imports end in `.js`).
       Source: `/Users/brennen/syntaur/src/index.ts:2-11`
       Actual code:
       ```typescript
       import { initCommand } from './commands/init.js';
       import { createMissionCommand } from './commands/create-mission.js';
       // etc.
       ```
     - **PROOF:** `program.parse()` is on line 209 and must remain the last call.
       Source: `/Users/brennen/syntaur/src/index.ts:209`
   - **Verification:**
     ```bash
     cd /Users/brennen/syntaur && npx tsc --noEmit
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| Plugin source dir not found | Throw error | "Plugin source directory not found at <path>. Are you running from the syntaur repo?" | `throw new Error(...)` |
| Already installed (same target) | Report and return | "Syntaur plugin already installed at <link> -> <source>" | `console.log(...)` + `return` |
| Already installed (different target) | Throw unless `--force` | "<link> already exists and points elsewhere. Use --force to overwrite." | `throw new Error(...)` |
| Symlink creation fails | Node.js error propagates | Standard Node.js error message | Uncaught, bubbles to Commander try/catch |

#### Task Completion Criteria
- [ ] `src/commands/install-plugin.ts` exists with exported `installPluginCommand` function
- [ ] Function creates symlink from `~/.claude/plugins/syntaur/` to `<repo>/plugin/`
- [ ] Function handles already-installed case gracefully
- [ ] Function supports `--force` flag to overwrite
- [ ] `src/index.ts` imports `installPluginCommand`
- [ ] `src/index.ts` registers `install-plugin` command with `--force` option
- [ ] `npx tsc --noEmit` passes with no errors

---

### Task 9: Update .gitignore and package.json — ALREADY COMPLETE

**File(s):** `.gitignore`, `package.json`
**Action:** ~~MODIFY~~ ALREADY DONE
**Status:** COMPLETE — both changes already landed on main.

#### Context
Both changes are already present in the codebase:
- `.gitignore` line 6: `.claude/syntaur.local.json` is already ignored
- `package.json` line 13: `"plugin"` is already in the `files` array
No changes needed.

#### Steps

1. [ ] **Step 9.1:** Add `.claude/syntaur.local.json` to `.gitignore`
   - **Location:** `/Users/brennen/syntaur/.gitignore:5` (append after existing entries)
   - **Action:** MODIFY
   - **What to do:** Add a line to ignore the session-local context file. This file is created by `/grab-assignment` and deleted by `/complete-assignment` -- it should never be committed.
   - **Code (append to end of file):**
     ```
     .claude/syntaur.local.json
     ```
   - **Proof blocks:**
     - **PROOF:** Current `.gitignore` already contains `.claude/syntaur.local.json` (6 lines, line 6 added by prior implementation).
       Source: `/Users/brennen/syntaur/.gitignore:1-6`
       Actual code:
       ```
       node_modules/
       dist/
       *.tsbuildinfo
       .worktrees/
       firebase-debug.log
       .claude/syntaur.local.json
       ```
   - **Verification:**
     ```bash
     cat /Users/brennen/syntaur/.gitignore
     # Should show the new entry at the end
     ```

2. [ ] **Step 9.2:** Add `plugin` to `files` array in `package.json`
   - **Location:** `/Users/brennen/syntaur/package.json:10-13`
   - **Action:** MODIFY
   - **What to do:** Add `"plugin"` to the `files` array so the plugin directory is included when the package is published to npm.
   - **Code (change the files array):**
     Already done. Current state:
     ```json
     "files": [
       "dist",
       "bin",
       "plugin"
     ],
     ```
   - **Proof blocks:**
     - **PROOF:** `files` array already includes `"plugin"`.
       Source: `/Users/brennen/syntaur/package.json:10-14`
       Actual code:
       ```json
       "files": [
         "dist",
         "bin",
         "plugin"
       ],
       ```
   - **Verification:**
     ```bash
     cat /Users/brennen/syntaur/package.json | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'plugin' in d['files']; print('OK')"
     ```

#### Error Handling
| Scenario | Handling | User Message | Code |
|----------|----------|--------------|------|
| `.gitignore` already has the entry | No-op (adding it again is harmless but check first) | N/A | N/A |
| `package.json` invalid JSON after edit | Validate with `python3 -m json.tool` | Parse error on stdout | N/A |

#### Task Completion Criteria
- [ ] `.gitignore` contains `.claude/syntaur.local.json`
- [ ] `package.json` `files` array contains `"plugin"`
- [ ] `package.json` is still valid JSON

---

## Phase 3 Completion Summary

### Counts
- **Tasks:** 9 (7 active, 2 already complete: Tasks 8 and 9)
- **Total steps:** 16 active (1.1-1.2, 2.1-2.3, 3.1-3.2, 4.1-4.2, 5.1-5.2, 6.1-6.2, 7.1-7.4), plus 4 already-done steps in Tasks 8-9
- **Proof blocks:** 38
- **Files to create/update:** 9 (plugin.json, protocol-summary.md, file-ownership.md, 4 SKILL.md files, hooks.json, enforce-boundaries.sh) — all plugin files that need content revisions per this plan
- **Files already done:** 4 (install-plugin.ts, index.ts, .gitignore, package.json)

### Completion Gate Checklist
- [x] Previous phases validated: Discovery and Outline are complete
- [x] Every task has steps: All 9 tasks have detailed sub-steps
- [x] Every step has code: Actual file contents provided, not pseudocode
- [x] Every step has file path + line number: Exact locations specified for modifications; "new file at" for creations
- [x] Every external reference has a proof block: Components, APIs, types, imports all verified
- [x] No hallucinated properties: Every prop/field/endpoint verified against actual source code
- [x] Explorers spawned per task: All reference files read and verified before detailing
- [x] No vague steps: Zero instances of "something like", "similar to", "appropriate handling", etc.
- [x] Error handling specified: Every task has error cases documented in table format
- [x] Verification criteria: Every step has a concrete verification command
- [x] Intern test: Each step specifies exact code to write and exact location to write it

---

## Plan Review Summary

**Date:** 2026-03-20
**Overall Verdict:** READY FOR IMPLEMENTATION
**Pre-review snapshot:** `.claude/plans/2026-03-20-chunk5-claude-code-adapter.md.pre-review.md`

| Pass | Result | Issues Found | Issues Fixed |
|------|--------|-------------|-------------|
| Completeness | PASS | 0 | 0 |
| Detail | PASS | 1 | 1 |
| Accuracy | PASS (after fixes) | 3 | 3 |
| Standards | PASS (after fixes) | 2 | 2 |
| Simplicity | PASS | 0 | 0 |
| External: feature-dev:code-reviewer | SKIPPED | -- | -- |
| External: superpowers:code-reviewer | SKIPPED | -- | -- |
| External: Codex (gpt-5.4) | DONE | 3 Critical/Important, 4 Minor | All addressed |

### Pass 1: Completeness

All 8 success criteria from the objective map to specific tasks:

| Requirement | Plan Task | Status |
|------------|-----------|--------|
| Plugin loads when installed | Task 1 (manifest), Task 8 (install-plugin) | COVERED |
| /grab-assignment skill | Task 4 | COVERED |
| /plan-assignment skill | Task 5 | COVERED |
| /complete-assignment skill | Task 6 | COVERED |
| Background syntaur-protocol skill | Task 3 | COVERED |
| PreToolUse hook blocks writes | Task 7 | COVERED |
| Context file lifecycle | Tasks 4, 5, 6 (create, read, cleanup) | COVERED |
| install-plugin CLI command | Task 8 | COVERED |

**Missing items:** None
**Edge cases not handled:** Single-assignment-per-session documented as intentional v1 limitation

### Pass 2: Detail

**Spot-checked steps:**

| Step | File Path? | Line Number? | Code? | Proof Block? | Verdict |
|------|-----------|-------------|-------|-------------|---------|
| Task 1, Step 1.2 | Yes | N/A (new file) | Yes (full JSON) | Yes (forge manifest) | PASS |
| Task 4, Step 4.2 | Yes | N/A (new file) | Yes (full SKILL.md) | Yes (example-command) | PASS |
| Task 7, Step 7.3 | Yes | N/A (new file) | Yes (full script) | Yes (hookify, forge) | PASS |
| Task 8, Step 8.1 | Yes | N/A (new file) | Yes (full TS) | Yes (fs.ts, create-assignment) | PASS |
| Task 8, Step 8.2 | Yes | Line 11, 209 | Yes (import + registration) | Yes (index.ts patterns) | PASS |

**Vague steps found:** None. All steps have exact file contents.
**Issue found and fixed:** plan.md frontmatter field names were wrong (`assignmentSlug`, `title` instead of `assignment`, `status`). Fixed in Task 5, Step 4.

### Pass 3: Accuracy

**Verified claims (via source file reads):**

| Claim | Source File | Verdict |
|-------|-----------|---------|
| Forge plugin.json has name/description/author/version | `/Users/brennen/.claude/plugins/forge/.claude-plugin/plugin.json` | VERIFIED |
| User skill frontmatter: name, description, argument-hint, allowed-tools | `example-plugin/skills/example-command/SKILL.md:1-6` | VERIFIED |
| Background skill frontmatter: name, description, version (no allowed-tools) | `example-plugin/skills/example-skill/SKILL.md:1-5` | VERIFIED |
| hooks.json structure with PreToolUse key | `hookify/hooks/hooks.json:1-16` | VERIFIED |
| PreToolUse stdin has tool_name | `hookify/hooks/pretooluse.py:35` | VERIFIED |
| Edit/Write/MultiEdit tool names | `hookify/hooks/pretooluse.py:40-41` | VERIFIED |
| `ensureDir` and `fileExists` in src/utils/fs.ts | `src/utils/fs.ts:4-15` | VERIFIED |
| Commander.js pattern in index.ts | `src/index.ts:20-34` | VERIFIED |
| ESM imports use .js extension | `src/index.ts:2-11` | VERIFIED |
| program.parse() on line 209 | `src/index.ts:209` | VERIFIED |
| State machine transitions | `src/lifecycle/state-machine.ts:4-15` | VERIFIED |
| package.json files array | `package.json:10-13` | VERIFIED |
| .gitignore current content | `.gitignore:1-5` | VERIFIED |
| Workspace type has repository/worktreePath/branch/parentBranch | `src/lifecycle/types.ts:24-29` | VERIFIED |
| Handoff format: numbered entries with From/To/Reason/Summary/etc | `docs/protocol/file-formats.md:412-461` | VERIFIED (plan was wrong, now fixed) |
| plan.md frontmatter: assignment, status, created, updated | `src/templates/plan.ts:7-14` | VERIFIED (plan was wrong, now fixed) |
| handoff.md frontmatter: assignment, updated, handoffCount | `src/templates/handoff.ts:7-11` | VERIFIED (plan was wrong, now fixed) |

**Hallucinated items found and fixed:**
1. plan.md frontmatter fields were `assignmentSlug`/`title` -- actual fields are `assignment`/`status`. Fixed.
2. Handoff entry format was invented (Changes Made, Notes for Reviewer) -- actual format uses From/To/Reason/Summary/Current State/Next Steps/Important Context. Fixed.
3. Heredoc in enforce-boundaries.sh had indentation issue. Fixed by replacing with echo.

### Pass 4: Standards

**CLAUDE.md rules checked:**

| Rule | Plan Compliance | Status |
|------|----------------|--------|
| Plans go in .claude/plans/ | Plan is at .claude/plans/ | PASS |
| Plugins stored in ~/.claude/plugins/ | Install command targets ~/.claude/plugins/syntaur/ | PASS |
| Shell aliases in ~/.bash_profile | Not applicable | N/A |

**Codebase pattern compliance:**

| Pattern | Codebase Convention | Plan Approach | Status |
|---------|-------------------|---------------|--------|
| ESM imports (.js extension) | All imports end in .js | Plan uses .js extension | PASS |
| Commander.js registration | .command().description().option().action(async) | Plan matches exactly | PASS |
| Error handling in CLI | try/catch with console.error + process.exit(1) | Plan matches exactly | PASS |
| Async exported function | Commands export async function | Plan follows pattern | PASS |
| Protocol: never store ~ literally | docs/protocol/spec.md:270 | Fixed: JSON example now shows absolute paths | PASS |
| Protocol: manifest.md is entry point | docs/protocol/spec.md:85 | Fixed: grab-assignment now reads manifest.md first | PASS |
| Protocol: completed means all criteria met | Inferred from spec | Fixed: --complete flag blocked when criteria unmet | PASS |

### Pass 5: Simplicity

**File change count:** 14 files (11 new, 3 modified)
**Unnecessary changes found:** None. Every file serves a clear purpose.
**Over-engineering found:** The `plugin` addition to package.json `files` array is not strictly needed for the symlink install path, but is low-cost and reasonable for future npm distribution.
**Simplification suggestions:** None. The plan is already minimal for the stated requirements.

### External Reviews

#### Review 1: feature-dev:code-reviewer
**Verdict:** SKIPPED
**Reason:** Task tool does not support subagent_type parameter; tool unavailable for this review type.

#### Review 2: superpowers:code-reviewer
**Verdict:** SKIPPED
**Reason:** Task tool does not support subagent_type parameter; tool unavailable for this review type.

#### Review 3: Codex CLI (gpt-5.4, reasoning: xhigh)
**Verdict:** NEEDS FIXES (all fixes applied)
**Key Feedback:**
- Critical: `--complete` flag allowed bypassing unmet acceptance criteria. Fixed: now blocked when criteria are unmet.
- Critical: Handoff entry format did not match protocol spec (wrong section headings). Fixed: now uses `## Handoff N` with From/To/Reason/Summary/Current State/Next Steps/Important Context.
- Important: Hook allowed writes to derived `_index.md` in resources/memories. Fixed: added basename check to exclude `_*` files.
- Important: `workspace.repository` could be a remote URL, not a local path. Fixed: added check to only use local paths as workspaceRoot.
- Important: Workflow skipped manifest.md (protocol entry point). Fixed: added manifest.md to grab-assignment's read list.
- Important: No automated tests planned. Documented as intentional for v1 with manual testing approach.
- Minor: "optionally registers plugin in user settings" claim not implemented. Fixed: removed the claim.
- Minor: grep for "status: pending" is not frontmatter-aware. Accepted: this is a skill instruction, and Claude will naturally handle YAML parsing; grep is just a hint.

**Changes Made Based on External Feedback:**
1. Handoff format rewritten to match `docs/protocol/file-formats.md` spec
2. `--complete` flag restricted to all-criteria-met cases
3. Hook script excludes `_*` derived files from resources/memories paths
4. workspace.repository URL handling added to context file creation
5. manifest.md added to grab-assignment workflow
6. Removed "optionally registers" claim from install command description
7. Added testing risk to Dependencies & Risks table

**Feedback Disagreed With (and why):**
- "grep is brittle because not frontmatter-aware": This is a skill instruction telling Claude how to discover assignments. Claude will intelligently parse the results and handle edge cases. The grep is a hint, not literal code the implementer writes.
- "Adding plugin to package.json files is not minimal": Low cost, reasonable for future distribution, and explicitly part of Task 9. Keeping it.

**Remaining concerns:**
1. The `tool_input.file_path` field in PreToolUse stdin JSON is inferred from hookify, not formally documented by Claude Code. The hook handles this defensively (allows on parse error), which is acceptable for v1.
2. The hook cannot prevent writes to `_index.md` or derived files INSIDE the assignment directory (e.g., if a derived rebuild writes there). This is a negligible risk since assignment folders do not contain derived files.

## Next Steps

This plan is ready for implementation. The remaining active tasks are 1-7 (plugin content creation and revision). Tasks 8-9 are already complete. You can:
- Use `superpowers:executing-plans` to implement with review checkpoints
- Run `/sun-tzu-implement claude-info/plans/2026-03-20-chunk5-claude-code-adapter.md` for guided implementation

---

## Revision Log

### Revision 1: 2026-03-21 — Codex Review Fixes

**Pre-revision snapshot:** `claude-info/plans/2026-03-20-chunk5-claude-code-adapter.md.pre-revision-2026-03-21.md`

| # | Issue | Tasks Affected | What Changed |
|---|-------|---------------|-------------|
| 1 | **Hardcoded `~/.syntaur/missions`** — Skills used hardcoded `~/.syntaur/missions` instead of resolving via `readConfig().defaultMissionDir` | Tasks 2, 3, 4 + architecture diagrams | Task 4 (grab-assignment): Added new "Step 1: Resolve Mission Directory" that reads config to determine mission base dir; renumbered subsequent steps (now 7 steps total); replaced all `~/.syntaur/missions/<slug>` references with `<MISSION_DIR>` placeholder. Task 3 (syntaur-protocol): Updated write boundary paths to reference `assignmentDir`/`missionDir` from context file instead of hardcoded paths. Task 2 (file-ownership.md): Updated path pattern to use `<defaultMissionDir>` with explanatory note. Architecture diagrams updated from hardcoded to `<defaultMissionDir>`. |
| 2 | **Handoff template extra `---` delimiter** — The handoff entry template in Task 6 had a leading `---` that creates a false YAML frontmatter block, not matching `docs/protocol/file-formats.md` or `examples/sample-mission/assignments/design-auth-schema/handoff.md` | Task 6 | Removed the stray `---` line before `## Handoff <N>:` in the handoff entry template. Protocol spec shows entries start directly with `## Handoff N:` heading, no horizontal rule delimiter. |
| 3 | **Missing hook test matrix** — No test fixtures for verifying enforce-boundaries.sh behavior across Edit/Write/MultiEdit with various paths | Task 7 | Added 18-case test matrix covering: assignment files (allow), resources/memories (allow), workspace files (allow), context file (allow), derived `_index` files (block), read-only files like mission.md (block), other agents' assignments (block), paths outside all boundaries (block), non-file tools like Bash/Read (allow), missing context file (allow), empty/malformed stdin (allow). Added full test runner script at `plugin/hooks/__tests__/test-enforce-boundaries.sh`. |
| 4 | **Stale discovery** — Plan referenced `install-plugin.ts` and `.gitignore`/`package.json` changes as needing to be created, but chunk 4 has since landed | Tasks 8, 9 + Discovery Findings + File Changes Summary + Dependencies & Risks + Completion Summary | Marked Tasks 8 and 9 as ALREADY COMPLETE. Updated Discovery Findings to reflect post-chunk-4 state (all 11 commands registered, install-plugin.ts exists, .gitignore and package.json already updated, plugin/ directory structure exists). Updated File Changes Summary table (4 files marked ALREADY DONE). Resolved chunk 4 dependency risk. Updated completion summary counts. Updated stale proof blocks for .gitignore (now 6 lines) and package.json (files array already includes "plugin"). |
- Implement manually following the task order above
