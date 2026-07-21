# Platform-Specific Plugin/Skill Setup System -- Discovery Findings

## Metadata
- **Date:** 2026-04-10
- **Complexity:** medium
- **Tech Stack:** TypeScript / Node.js 20 / Commander.js CLI / ESM / tsup build / Vitest tests

## Objective
Create a platform-specific plugin/skill setup system for Syntaur that supports dedicated directory structures and install flows for Claude Code, Codex, Cursor, and OpenCode platforms.

## User's Request
Create a platform-specific plugin/skill setup system for Syntaur with directories for Claude Code, Codex, Cursor, and OpenCode platforms. The system needs to understand how `syntaur setup` currently works, existing plugin install infrastructure, adapter patterns, and how to extend support for Cursor and OpenCode as first-class plugin platforms alongside Claude Code and Codex.

## Codebase Overview

### Project Structure
Single npm package (not a monorepo). Key directories:
- `src/` -- TypeScript source (CLI commands, utils, templates, dashboard, TUI, tests)
- `plugin/` -- Claude Code plugin source (skills, hooks, commands, agents, references)
- `plugins/syntaur/` -- Codex plugin source (skills, hooks, commands, agents, references)
- `adapters/` -- Human-readable adapter reference templates (codex, cursor, opencode)
- `dashboard/` -- Vite/React web dashboard
- `bin/syntaur.js` -- CLI entry point
- `dist/` -- Build output

### Current Plugin System
Two plugin kinds exist: `claude` and `codex` (defined as `PluginKind = 'claude' | 'codex'`).

**Claude Code plugin** (`plugin/`):
- `.claude-plugin/plugin.json` manifest
- `skills/` with 6 skills (SKILL.md files)
- `hooks/hooks.json` with PostToolUse and SessionEnd hooks
- `commands/` with track-session and track-server
- `agents/syntaur-expert.md`
- `references/` with protocol-summary.md and file-ownership.md

**Codex plugin** (`plugins/syntaur/`):
- `.codex-plugin/plugin.json` manifest
- `skills/` with 7 skills (SKILL.md files)
- `hooks.json` with PreToolUse and SessionEnd hooks
- `commands/track-session.md`
- `agents/syntaur-operator.md` and `agents/openai.yaml`
- `scripts/` for hook shell scripts
- `references/` with protocol-summary.md and file-ownership.md

### Adapter System (Cursor/OpenCode)
Adapters are a *different* concept from plugins. They generate per-assignment instruction files into the working directory:
- Cursor: `.cursor/rules/syntaur-protocol.mdc` + `.cursor/rules/syntaur-assignment.mdc`
- Codex: `AGENTS.md` at repo root
- OpenCode: `AGENTS.md` + `opencode.json`

Generated via `syntaur setup-adapter <framework>` command. Templates live in `src/templates/` (cursor-rules.ts, codex-agents.ts, opencode-config.ts).

### Setup Flow
1. `syntaur setup` -- main entry point, calls `initCommand()` then prompts for Claude and Codex plugin installs, and optionally launches dashboard
2. `syntaur install-plugin` -- installs Claude Code plugin (copies `plugin/` to target dir, registers in marketplace)
3. `syntaur install-codex-plugin` -- installs Codex plugin (copies `plugins/syntaur/` to target dir, adds marketplace entry)
4. `syntaur setup-adapter <framework>` -- generates adapter files for cursor/codex/opencode
5. `syntaur uninstall` -- removes plugins, optionally data

### Key Utility: `src/utils/install.ts`
Central installation logic. Contains:
- `PluginKind` type (`'claude' | 'codex'`)
- `installManagedPlugin()` -- copies or symlinks plugin source to target
- `resolvePluginPaths()` -- finds package root and source directory
- Marketplace entry management for both Claude and Codex
- Config persistence for installed paths
- `recommendPluginTargetDir()` -- auto-detects best install location

### Config System
`~/.syntaur/config.md` with YAML frontmatter stores:
- `integrations.claudePluginDir` -- installed Claude plugin path
- `integrations.codexPluginDir` -- installed Codex plugin path
- `integrations.codexMarketplacePath` -- Codex marketplace file path
- `onboarding.completed` -- whether setup finished

## Files That Will Need Changes

| File | Current Purpose | Needed Change |
|------|----------------|---------------|
| `src/utils/install.ts` | Plugin install logic for claude/codex | Extend `PluginKind` to include cursor/opencode, add install paths and logic |
| `src/commands/setup.ts` | Setup flow prompting for claude/codex | Add prompts for Cursor and OpenCode plugin installation |
| `src/commands/uninstall.ts` | Uninstall claude/codex plugins | Add cursor/opencode uninstall support |
| `src/index.ts` | CLI command registration | Add new install commands for cursor/opencode if separate commands are used |
| `src/utils/config.ts` | Config types and persistence | Add cursorPluginDir/openCodePluginDir to IntegrationConfig |
| `src/commands/install-plugin.ts` | Claude-specific install | May need generalization or new parallel commands |
| `src/cli-default-command.ts` | Checks if setup is complete | Add cursor/opencode plugin dir checks |
| `src/__tests__/setup-install.test.ts` | Tests for setup/install | Add tests for new platforms |
| `plugin/` | Claude Code plugin source | Already exists |
| `plugins/syntaur/` | Codex plugin source | Already exists |
| New: `adapters/cursor/` plugin? | Currently only adapter templates | May need a full plugin structure for Cursor |
| New: `adapters/opencode/` plugin? | Currently only adapter templates | May need a full plugin structure for OpenCode |

## Patterns Discovered

| Pattern | Reference File | Description |
|---------|---------------|-------------|
| Plugin source layout | `plugin/` and `plugins/syntaur/` | Each plugin kind has a dedicated source directory with .{platform}-plugin/plugin.json, skills/, hooks, commands, agents, references |
| PluginKind type | `src/utils/install.ts:20` | Union type driving all install logic branching |
| Managed install with marker | `src/utils/install.ts:27` | .syntaur-install.json marker tracks managed installs |
| Config persistence | `src/utils/config.ts:380-410` | `updateIntegrationConfig()` writes installed paths to config.md frontmatter |
| Setup prompt flow | `src/commands/setup.ts:47-57` | Interactive Y/N prompts for each platform, non-interactive with --yes |
| Default path resolution | `src/utils/install.ts:169-174` | Each plugin kind maps to a default home-dir target path |
| Plugin manifest | `plugin/.claude-plugin/plugin.json` | JSON manifest with name, description, version, author |
| Adapter vs Plugin | `adapters/README.md` | Adapters generate per-project instruction files; plugins install as reusable platform extensions |
| Test pattern | `src/__tests__/setup-install.test.ts` | Tests use temp HOME dirs, seed marketplace, test install/uninstall flows |
| Command pattern | `src/index.ts` | Commands use Commander.js `.command()` with `.option()` and `.action(async)` |

## CLAUDE.md Rules Found
No CLAUDE.md files exist in this repo. Instead, AGENTS.md serves as the project guidance file:
- Claude plugin source in `plugin/`, Codex plugin source in `plugins/syntaur/`
- Run `npm run typecheck` for TypeScript changes
- Run adapter template tests with `npx vitest run src/__tests__/adapter-templates.test.ts`
- Run `bash -n` on hook scripts
- Keep Codex plugin, Claude plugin, and generated Codex adapter aligned when protocol behavior changes

## Questions Asked & Answers

| Question | Answer |
|----------|--------|
| (None asked yet -- see Questions section below) | |

## Exploration Log

| Explorer | Focus Area | Key Findings |
|----------|-----------|--------------|
| Manual exploration | CLI commands, setup flow, install utils | Complete setup/install/uninstall pipeline mapped. Two plugin kinds (claude/codex) with dedicated source dirs. Adapters are a separate concept generating per-project files. |
| Manual exploration | Plugin structures | Claude plugin at `plugin/` with .claude-plugin manifest. Codex plugin at `plugins/syntaur/` with .codex-plugin manifest. Both have skills, hooks, commands, agents, references. |
| Manual exploration | Config and patterns | IntegrationConfig tracks installed paths. PluginKind union type is the main extension point. Tests use temp HOME dirs with marketplace seeding. |
