# Syntaur Repo

This repo contains the Syntaur CLI, dashboard, Claude plugin source, Codex plugin source, and adapter generators.

## Important Paths

- `plugin/` - Claude Code plugin source
- `plugins/syntaur/` - Codex plugin source
- `src/templates/` - generated adapter content
- `adapters/` - human-readable adapter reference templates
- `.syntaur/context.json` - active local assignment context when working inside a Syntaur assignment

## Codex + Syntaur

- When the task is about Syntaur missions, assignments, or files under `~/.syntaur/`, use the Syntaur Codex workflows first: `syntaur-protocol`, `create-mission`, `create-assignment`, `grab-assignment`, `plan-assignment`, `complete-assignment`, and `track-session`.
- For broad Syntaur protocol work in Codex, prefer the dedicated `syntaur-operator` agent from `plugins/syntaur/agents/syntaur-operator.md`.
- Keep the Codex plugin text in `plugins/syntaur/`, the Claude plugin text in `plugin/`, and the generated Codex adapter in `src/templates/codex-agents.ts` aligned when protocol behavior changes.
- `agent.md` is universal per-mission guidance and stays human-authored and read-only. `claude.md` may still hold mission-specific context worth reading, but Codex-only behavior should live in the Codex plugin or `AGENTS.md`.
- Respect `.syntaur/context.json` and the assignment workspace boundary whenever that file exists.

## Validation

- Run `npm run typecheck` for TypeScript changes.
- Run `npx vitest run src/__tests__/adapter-templates.test.ts` for Codex adapter text changes.
- Run `bash -n` on any shell hook scripts you touch.
