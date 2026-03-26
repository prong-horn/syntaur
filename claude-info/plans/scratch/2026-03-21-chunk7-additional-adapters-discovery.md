# Chunk 7: Additional Adapters — Discovery Findings

## Metadata
- **Date:** 2026-03-21
- **Complexity:** medium
- **Tech Stack:** TypeScript/Node.js 20+ (CLI), Commander.js (CLI framework), Markdown/YAML frontmatter (protocol files), Cursor .mdc format, Codex AGENTS.md format, OpenCode AGENTS.md format

## Objective
Create adapter instruction files for Cursor, Codex (OpenAI), and OpenCode that teach those agent frameworks how to follow the Syntaur protocol — the same protocol rules the Claude Code adapter (chunk 5) teaches, but in each framework's native instruction format.

## User's Request
Build adapters for three additional agent frameworks: Cursor rules, Codex AGENTS.md, and OpenCode config. These should follow the same protocol as the Claude Code adapter (chunk 5) but use each framework's native instruction format. They should be community-contributable.

## Codebase Overview

### Current State
The Syntaur codebase is a TypeScript CLI tool (`syntaur`) built with Commander.js and ESM modules. It has:
- **Chunks 1-4 (core):** Protocol spec, CLI scaffolding (init, create-mission, create-assignment), index rebuild, lifecycle engine (assign, start, complete, block, unblock, review, fail)
- **Chunk 5 (Claude Code adapter, in progress):** A Claude Code plugin at `plugin/` with skills (`/grab-assignment`, `/plan-assignment`, `/complete-assignment`), a background protocol knowledge skill, PreToolUse write boundary hook, and reference materials. Installed via `syntaur install-plugin` which symlinks to `~/.claude/plugins/syntaur/`.
- **Templates:** `src/templates/` has renderers for all protocol file types including `agent.ts` (renders `agent.md`) and `claude.ts` (renders `claude.md`).

### Key Architectural Insight: Where Adapter Files Live

The Syntaur protocol has a clear separation:
- **Mission folder** (`~/.syntaur/missions/<slug>/`): Contains `agent.md` (universal instructions) and `claude.md` (Claude Code-specific instructions). These are human-authored and read-only for agents.
- **Workspace** (the code repository): Where agents actually do their work. This is where framework-specific config files need to exist because each framework discovers its instructions from the project directory.

The Claude Code adapter (chunk 5) solved this differently: it's a **global plugin** installed to `~/.claude/plugins/syntaur/`. Claude Code's plugin system auto-loads it everywhere. The plugin reads the mission context from `.claude/syntaur.local.json` in the working directory.

Cursor, Codex, and OpenCode do NOT have a global plugin system equivalent. Instead, they discover instructions from files in the project directory:
- **Cursor:** Reads `.cursor/rules/*.mdc` files (or `.cursorrules` at project root)
- **Codex:** Reads `AGENTS.md` (or `AGENTS.override.md`) from repo root, walking down to cwd
- **OpenCode:** Reads `AGENTS.md` from project root (also reads `CLAUDE.md` as fallback)

This means chunk 7 adapters need a **generation mechanism** that places instruction files in the workspace when an agent starts working on an assignment. This parallels how the Claude Code adapter creates `.claude/syntaur.local.json` in the working directory via the `/grab-assignment` skill.

### Adapter Content: What Each File Needs to Teach

All three adapters need to convey the same protocol knowledge, adapted to each format:

1. **Protocol overview:** What Syntaur is, how missions and assignments work
2. **Write boundary rules:** Which files the agent may write (assignment folder, shared resources/memories, workspace code), which are read-only (mission.md, agent.md, derived files)
3. **Lifecycle states:** pending, in_progress, blocked, review, completed, failed — and valid transitions
4. **CLI commands:** How to use `syntaur assign`, `syntaur start`, `syntaur complete`, etc.
5. **File reading order:** Read manifest.md first, then mission.md, agent.md, assignment.md
6. **Assignment context:** The specific mission slug, assignment slug, workspace path
7. **Conventions:** Frontmatter as source of truth, slug naming, timestamps, path normalization

## Target Adapter Formats

### Cursor Rules (.mdc format)
- **Location:** `.cursor/rules/` directory in the workspace
- **File format:** `.mdc` extension with YAML frontmatter
- **Frontmatter fields:**
  - `description` (string): Rule purpose, used for "Apply Intelligently" matching
  - `globs` (string or array): File patterns that trigger the rule (e.g., `**/*.md`)
  - `alwaysApply` (boolean): Whether rule is always included in context
- **Rule types:** Always Apply, Apply Intelligently, Apply to Specific Files, Apply Manually
- **Content:** Markdown body after frontmatter
- **Guidelines:** Rules should be under 500 lines, split large rules into composable pieces
- **Legacy:** `.cursorrules` file at project root still works but is deprecated

**Proposed structure for Syntaur Cursor adapter:**
```
.cursor/rules/
  syntaur-protocol.mdc      # alwaysApply: true — core protocol rules, write boundaries
  syntaur-assignment.mdc     # alwaysApply: true — current assignment context (generated per-assignment)
```

### Codex AGENTS.md
- **Location:** `AGENTS.md` at repo root (or nested directories)
- **Discovery order:** `AGENTS.override.md` > `AGENTS.md` > fallback names (configurable)
- **Format:** Standard Markdown, no frontmatter required
- **Layering:** Files concatenate root-to-leaf, later files override earlier guidance
- **Size limit:** 32 KiB default (`project_doc_max_bytes`)
- **Injection:** Each file becomes a user-role message starting with `# AGENTS.md instructions for <directory>`

**Proposed structure for Syntaur Codex adapter:**
```
AGENTS.md                    # Syntaur protocol rules + current assignment context
```

### OpenCode Rules
- **Location:** `AGENTS.md` at project root (same as Codex)
- **Discovery:** Project root `AGENTS.md`, global `~/.config/opencode/AGENTS.md`
- **Format:** Standard Markdown, no frontmatter
- **Compatibility:** Also reads `CLAUDE.md` as fallback (can be disabled)
- **Extra:** `opencode.json` `instructions` field can reference additional files and globs

**Proposed structure for Syntaur OpenCode adapter:**
Since OpenCode reads `AGENTS.md` (same as Codex), the Codex adapter file serves double duty. If the user is using OpenCode instead of Codex, the same `AGENTS.md` works. An optional `opencode.json` could reference the mission's `agent.md` as additional instructions.

## Files That Will Need Changes

| File | Current Purpose | Needed Change |
|------|----------------|---------------|
| `adapters/cursor/syntaur-protocol.mdc` | Does not exist | CREATE: Template Cursor rule for protocol knowledge (alwaysApply) |
| `adapters/cursor/syntaur-assignment.mdc.template` | Does not exist | CREATE: Template Cursor rule for assignment context (generated per-assignment) |
| `adapters/codex/AGENTS.md.template` | Does not exist | CREATE: Template AGENTS.md for Codex/OpenCode with protocol rules |
| `adapters/opencode/opencode.json.template` | Does not exist | CREATE: Optional OpenCode config referencing mission agent.md |
| `adapters/README.md` | Does not exist | CREATE: Documentation on how to use each adapter, how to contribute new ones |
| `src/templates/cursor-rules.ts` | Does not exist | CREATE: Renderer for Cursor .mdc files with assignment context |
| `src/templates/codex-agents.ts` | Does not exist | CREATE: Renderer for AGENTS.md with assignment context |
| `src/templates/opencode-config.ts` | Does not exist | CREATE: Renderer for opencode.json |
| `src/commands/setup-adapter.ts` | Does not exist | CREATE: CLI command `syntaur setup-adapter <framework>` to generate adapter files in workspace |
| `src/index.ts` | CLI entry point with 11 commands | MODIFY: Register `setup-adapter` command |
| `src/templates/manifest.ts` | Renders manifest.md with Claude Code link | MODIFY: Add links to additional adapter instructions in Config section |
| `examples/sample-mission/manifest.md` | Sample manifest | MODIFY: Add links to additional adapter examples |
| `docs/protocol/spec.md` | Protocol specification | MODIFY: Add section on adapter instruction files |

## Patterns Discovered

| Pattern | Reference File | Description |
|---------|---------------|-------------|
| Template renderer | `/Users/brennen/syntaur/src/templates/claude.ts` | TypeScript function that takes params (slug) and returns rendered markdown string. Interface for params, exported render function. |
| Template renderer (with frontmatter) | `/Users/brennen/syntaur/src/templates/agent.ts` | Same pattern but includes YAML frontmatter in the template string. Params include slug and timestamp. |
| CLI command registration | `/Users/brennen/syntaur/src/index.ts` | Commander.js pattern: `.command()` -> `.description()` -> `.argument()` -> `.option()` -> `.action(async () => { try/catch })` |
| Human-authored instruction file | `/Users/brennen/syntaur/examples/sample-mission/agent.md` | Universal agent instructions with Conventions, Boundaries, Resources sections. All adapters should tell agents to read this file. |
| Claude-specific instruction file | `/Users/brennen/syntaur/examples/sample-mission/claude.md` | Framework-specific instructions that supplement agent.md. Pattern: "Read agent.md first, then these additional rules." |
| Plugin reference materials | `/Users/brennen/syntaur/plugin/references/protocol-summary.md` | Condensed protocol summary with directory structure, lifecycle states, key rules. Chunk 7 adapters should embed equivalent content. |
| Write boundary rules | `/Users/brennen/syntaur/plugin/references/file-ownership.md` | File ownership rules organized by category. All adapters need equivalent content. |
| Protocol skill | `/Users/brennen/syntaur/plugin/skills/syntaur-protocol/SKILL.md` | Full protocol knowledge including write rules, context file, lifecycle commands, conventions. This is the content model for all adapters. |

## CLAUDE.md Rules Found
- No repo-level CLAUDE.md exists for the syntaur project
- Global `~/.claude/CLAUDE.md` rules:
  - Plans go in `claude-info/plans/` (NOT `.claude/plans/`)
  - Plugins stored in `~/.claude/plugins/`
  - All env vars managed via GCP Secret Manager (not relevant here)
- Sample mission `examples/sample-mission/CLAUDE.md` demonstrates the framework-specific instruction pattern: "Read agent.md first" then Claude-specific rules

## Questions Asked & Answers
No questions asked -- proceeding with reasonable defaults based on the protocol spec and chunk 5 reference adapter.

## Key Design Decisions to Make in Planning

### 1. Static templates vs. generated-per-assignment
The Cursor `.mdc` format supports `alwaysApply: true` for always-on rules. The protocol rules are static (same for every assignment). The assignment context (which mission, which assignment, workspace path) is dynamic. Two approaches:
- **Option A:** Two files per adapter -- a static protocol rules file + a dynamically generated assignment context file
- **Option B:** One file per adapter, fully generated with both protocol rules and assignment context embedded

Recommendation: **Option A** -- matches how the Claude Code adapter separates the background protocol skill (static) from `.claude/syntaur.local.json` (dynamic). Static protocol rules can be committed to the repo; only the assignment context file is gitignored.

### 2. Where static adapter templates live in the repo
- **Option A:** `adapters/` directory at repo root (parallel to `plugin/` for Claude Code)
- **Option B:** Inside `src/templates/` alongside other templates

Recommendation: **Option A** -- `adapters/cursor/`, `adapters/codex/`, `adapters/opencode/`. These contain the actual template files (markdown/mdc) that get copied/rendered to workspaces. Keeps them discoverable for community contributors. The `plugin/` directory is the precedent for adapter assets living at repo root.

### 3. CLI command for generating adapter files
A `syntaur setup-adapter <framework> --mission <slug> --assignment <slug>` command that:
1. Reads the assignment context (mission slug, assignment slug, workspace path)
2. Copies/renders the adapter template files into the workspace directory
3. Supports `cursor`, `codex`, `opencode` as framework arguments

This parallels how `/grab-assignment` creates `.claude/syntaur.local.json`. Non-Claude agents would run `syntaur setup-adapter cursor` after `syntaur assign` + `syntaur start`.

### 4. Codex and OpenCode sharing AGENTS.md
Since both Codex and OpenCode read `AGENTS.md`, they can share the same template. The `adapters/codex/` template works for both. The `adapters/opencode/` directory would only contain the optional `opencode.json` additions.

### 5. Community contribution pattern
The `adapters/README.md` should document:
- How to create a new adapter (file structure, required content sections)
- How the template rendering works
- How to register a new framework in the CLI

## Exploration Log

| Explorer | Focus Area | Key Findings |
|----------|-----------|--------------|
| Direct read | Protocol spec & file formats | Mission folder structure with `agent.md` (universal) and `claude.md` (framework-specific) as human-authored instruction files. Assignment frontmatter is source of truth. Write boundaries are critical. |
| Direct read | Chunk 5 Claude Code adapter | Plugin at `plugin/` with skills, hooks, references. Pattern: static protocol knowledge (background skill) + dynamic context (`.claude/syntaur.local.json`). Context file created in workspace on grab, deleted on complete. |
| Direct read | Existing templates | `src/templates/agent.ts` and `src/templates/claude.ts` show the renderer pattern: interface for params, exported function returning template string. |
| Web research | Cursor rules format | `.cursor/rules/*.mdc` files with YAML frontmatter (`description`, `globs`, `alwaysApply`). Supports Always Apply, Apply Intelligently, glob-matched, and manual invocation modes. Under 500 lines recommended. |
| Web research | Codex AGENTS.md format | Standard markdown at `AGENTS.md` in repo root or nested dirs. Discovery: `AGENTS.override.md` > `AGENTS.md` > fallbacks. Layered root-to-leaf. 32 KiB limit. No frontmatter needed. |
| Web research | OpenCode rules format | Also reads `AGENTS.md` from project root. Has `CLAUDE.md` fallback compatibility. `opencode.json` `instructions` field can reference additional files and globs. No special frontmatter. |
| Direct read | Sample mission files | `examples/sample-mission/manifest.md` Config section links to `agent.md` and `claude.md`. New adapters would add links here. `agent.md` has Conventions/Boundaries/Resources sections. |
| Direct read | Plugin structure | `plugin/.claude-plugin/plugin.json` manifest, `plugin/skills/` with 4 skills, `plugin/hooks/` with boundary enforcement, `plugin/references/` with condensed protocol docs. |
