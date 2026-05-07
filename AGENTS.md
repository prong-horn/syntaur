# Syntaur Repo

This repo contains the Syntaur CLI, dashboard, protocol skills, and platform-specific plugin/adapter sources.

## Important Paths

- `skills/<name>/SKILL.md` - canonical source of all Syntaur protocol skills (single source of truth)
- `.claude-plugin/plugin.json` - top-level plugin manifest declaring the syntaur skills (used by skills.sh discovery)
- `platforms/claude-code/` - Claude Code plugin source (commands, hooks, agents, references)
- `platforms/codex/` - Codex plugin source
- `platforms/cursor/` - Cursor integration reference and adapter templates
- `platforms/opencode/` - OpenCode integration reference and adapter templates
- `platforms/<kind>/skills/` - **build artifact** (gitignored) populated by `npm run mirror-skills` from `<repo>/skills/`. The plugin manifests' `./skills/<name>` paths resolve to these.
- `src/templates/` - generated adapter content
- `.syntaur/context.json` - active local assignment context when working inside a Syntaur assignment

## Skill distribution

Three install paths, one source (`<repo>/skills/`):

1. `npx skills add prong-horn/syntaur` — primary, cross-agent (skills.sh).
2. Claude Code plugin via `/plugin` — manifests declare skills inline.
3. `syntaur install-plugin` — CLI path; mirrors `<repo>/skills/` into the plugin target dir at install time.

When editing a skill, edit it ONLY at `<repo>/skills/<name>/SKILL.md`. Run `npm run mirror-skills` to re-mirror into `platforms/<kind>/skills/` for local link-mode plugin testing. The `prepack` script does it automatically before `npm pack`/`npm publish`.

## Codex + Syntaur

- When the task is about Syntaur missions, assignments, or files under `~/.syntaur/`, use the Syntaur Codex workflows first: `syntaur-protocol`, `create-project`, `create-assignment`, `grab-assignment`, `plan-assignment`, `complete-assignment`, `track-session`, `track-server`.
- For broad Syntaur protocol work in Codex, prefer the dedicated `syntaur-operator` agent from `platforms/codex/agents/syntaur-operator.md`.
- Keep the Codex plugin text in `platforms/codex/`, the Claude plugin text in `platforms/claude-code/`, the canonical skill text in `<repo>/skills/`, and the generated Codex adapter in `src/templates/codex-agents.ts` aligned when protocol behavior changes.
- `agent.md` is universal per-mission guidance and stays human-authored and read-only. `claude.md` may still hold mission-specific context worth reading, but Codex-only behavior should live in the Codex plugin or `AGENTS.md`.
- Respect `.syntaur/context.json` and the assignment workspace boundary whenever that file exists.

## Validation

- Run `npm run typecheck` for TypeScript changes.
- Run `npx vitest run src/__tests__/adapter-templates.test.ts` for Codex adapter text changes.
- Run `npx vitest run src/__tests__/install-plugin-marketplace.test.ts` for plugin install / marketplace integration changes.
- Run `npx vitest run src/__tests__/install-skills.test.ts` for skill install behavior changes.
- Run `bash -n` on any shell hook scripts you touch.
