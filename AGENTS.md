# Syntaur Repo

This repo contains the Syntaur CLI, dashboard, protocol skills, and Claude Code hook scripts.

## Important Paths

- `skills/<name>/SKILL.md` — canonical source of all Syntaur protocol skills (single source of truth; six skills)
- `hooks/` — session hook shell scripts installed by `syntaur hooks install`
- `src/templates/` — config and ticket template renderers
- `.syntaur/context.json` — a WORKSPACE MARKER (repository/branch/worktree) identifying a Syntaur workspace directory. It is NOT the active-ticket source of truth — the active ticket resolves from the session's open engagement, not from context.json.

## Skill distribution

One install path, one source (`<repo>/skills/`):

1. `npx skills add prong-horn/syntaur -g -a claude-code` — primary (skills.sh). Optional `-a codex` / `-a cursor` for other harnesses.

When editing a skill, edit it ONLY at `<repo>/skills/<name>/SKILL.md`. Upgrade installed copies with `npx skills update`.

Session hooks ship in `hooks/` and are copied to `~/.syntaur/hooks/` by `syntaur hooks install`.

## Ticket files

Do not hardcode ticket sidecar filenames (`progress.md`, `journal.md`, `plan.md`, etc.). Run `syntaur show <id>` (or `syntaur show` with an open engagement) and follow the **Files**, **Stage**, and **Next** lines — edit only paths listed with `writer: agent`.

## Codex + Syntaur

- When the task is about Syntaur tickets or files under `~/.syntaur/`, use the six skills: `syntaur-protocol`, `grab`, `plan`, `done`, `log`, `worktree` (install via `npx skills add` above).
- Respect the workspace boundary marked by `.syntaur/context.json` whenever that file exists. The active ticket itself is resolved from the session's open engagement, not from context.json.

## Validation

- Run `npm run typecheck` for TypeScript changes.
- Run `npx vitest run src/__tests__/skills-pack.test.ts` for skill pack / CLI reference guard changes.
- Run `npx vitest run src/__tests__/hooks-install.test.ts` for hooks install behavior.
- Run `npx vitest run src/__tests__/package-files.test.ts` for npm pack contents.
- Run `bash -n` on any shell hook scripts you touch.
