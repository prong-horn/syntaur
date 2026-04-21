---
name: syntaur-protocol
description: Use when the user mentions Syntaur, projects, assignments, files under ~/.syntaur/, assignment.md, plan.md, handoff.md, .syntaur/context.json, lifecycle states, or write boundaries.
---

# Syntaur Protocol

You are working within the Syntaur protocol. Follow these rules at all times.

## Write Boundary Rules

Respect file ownership boundaries.

### Files you may write directly

1. Your assignment folder only:
   - `assignment.md`
   - `plan*.md` (0 or more versioned plan files, e.g., `plan.md`, `plan-v2.md`)
   - `progress.md` (append timestamped entries, newest first; replaces the old `## Progress` body section)
   - `scratchpad.md`
   - `handoff.md`
   - `decision-record.md`
   - Path (project-nested): `~/.syntaur/projects/<project>/assignments/<your-assignment>/`
   - Path (standalone): `~/.syntaur/assignments/<your-assignment-uuid>/` — folder named by UUID, `project: null`, `slug` display-only
2. Project-level shared files:
   - `~/.syntaur/projects/<project>/resources/<slug>.md`
   - `~/.syntaur/projects/<project>/memories/<slug>.md`
3. Workspace files inside the assignment's configured workspace root
4. `.syntaur/context.json` in the current working directory

### Files written only via CLI

- `comments.md` (any assignment) — use `syntaur comment <slug-or-uuid> "body" --type question|note|feedback [--reply-to <id>]`. Never edit directly.
- Another assignment's `## Todos` section — use `syntaur request <target> "text"` to append a todo annotated `(from: <source>)`.

### Files you must never write

1. `project.md`
2. `manifest.md`
3. Any file prefixed with `_`
4. Other agents' assignment folders (except via the CLI-mediated channels above)
5. Anything outside the current workspace boundary

## Current Assignment Context

If `.syntaur/context.json` exists in the current working directory, read it before making changes. Use it to determine:

- `projectSlug`
- `assignmentSlug`
- `projectDir`
- `assignmentDir`
- `workspaceRoot`
- `sessionId` if present

## Required Reading Order

When you are working on an existing assignment, read these in order:

1. `<projectDir>/manifest.md` (project-nested assignments only)
2. `<projectDir>/project.md` (project-nested assignments only)
3. `<assignmentDir>/assignment.md` — frontmatter now includes `project: <slug> | null` and `type: <classification> | null`
4. any `<assignmentDir>/plan*.md` files linked from active todos in the `## Todos` section
5. `<assignmentDir>/progress.md` (if present)
6. `<assignmentDir>/comments.md` (if present)
7. `<assignmentDir>/handoff.md`

## Lifecycle Commands

Use the `syntaur` CLI for state transitions and coordination:

- `syntaur assign <slug> --agent <name> --project <project>`
- `syntaur start <slug> --project <project>`
- `syntaur review <slug> --project <project>`
- `syntaur complete <slug> --project <project>`
- `syntaur block <slug> --project <project> --reason <text>`
- `syntaur unblock <slug> --project <project>`
- `syntaur fail <slug> --project <project>`
- `syntaur create-assignment "<title>" [--type <type>] [--project <slug> | --one-off]`
- `syntaur comment <slug-or-uuid> "body" --type question|note|feedback [--reply-to <id>]`
- `syntaur request <target> "text" [--from <source>]`

## Troubleshooting

If Syntaur state looks inconsistent (missing files, stale manifests, unexpected hook blocks), run `syntaur doctor` to diagnose. Use `--json` for structured output.

## Conventions

- Assignment frontmatter is the single source of truth. `project` is the containing project slug (`null` for standalone); `type` is a classification validated against `config.md` `types.definitions` when present.
- Slugs are lowercase and hyphen-separated. For standalone assignments the folder is named by UUID; `slug` is display-only.
- Update acceptance criteria and `## Todos` checkboxes as work lands, not only at the end.
- Append timestamped entries to `progress.md` after meaningful milestones. Do NOT add a `## Progress` section to `assignment.md`.
- Record questions/notes/feedback via `syntaur comment` — never edit `comments.md` directly. Do NOT set status to blocked for questions.
- When requirements shift, supersede the prior plan todo (`- [x] ~~...~~ (superseded by plan-v<N>)`) instead of rewriting the old plan file.
- Write handoffs with enough context for another agent or human to continue cleanly.
- Use `syntaur request` to route work to another assignment.

## References

Read these only when you need the detailed rules or directory layout:

- `../../references/protocol-summary.md`
- `../../references/file-ownership.md`
