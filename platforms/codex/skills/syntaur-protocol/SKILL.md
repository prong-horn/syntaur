---
name: syntaur-protocol
description: Use when the user mentions Syntaur, projects, assignments, files under ~/.syntaur/, assignment.md, plan.md, handoff.md, .syntaur/context.json, lifecycle states, or write boundaries.
---

# Syntaur Protocol

You are working within the Syntaur protocol. Follow these rules at all times.

## Write Boundary Rules

Respect file ownership boundaries.

### Files you may write

1. Your assignment folder only:
   - `assignment.md`
   - `plan*.md` (0 or more versioned plan files, e.g., `plan.md`, `plan-v2.md`)
   - `scratchpad.md`
   - `handoff.md`
   - `decision-record.md`
2. Project-level shared files:
   - `~/.syntaur/projects/<project>/resources/<slug>.md`
   - `~/.syntaur/projects/<project>/memories/<slug>.md`
3. Workspace files inside the assignment's configured workspace root
4. `.syntaur/context.json` in the current working directory

### Files you must never write

1. `project.md`, `agent.md`, `claude.md`
2. `manifest.md`
3. Any file prefixed with `_`
4. Other agents' assignment folders
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

1. `<projectDir>/manifest.md`
2. `<projectDir>/agent.md`
3. `<projectDir>/project.md`
4. `<projectDir>/claude.md` if it exists
5. `<assignmentDir>/assignment.md`
6. any `<assignmentDir>/plan*.md` files linked from active todos in the `## Todos` section
7. `<assignmentDir>/handoff.md`

## Lifecycle Commands

Use the `syntaur` CLI for state transitions:

- `syntaur assign <slug> --agent <name> --project <project>`
- `syntaur start <slug> --project <project>`
- `syntaur review <slug> --project <project>`
- `syntaur complete <slug> --project <project>`
- `syntaur block <slug> --project <project> --reason <text>`
- `syntaur unblock <slug> --project <project>`
- `syntaur fail <slug> --project <project>`

## Troubleshooting

If Syntaur state looks inconsistent (missing files, stale manifests, unexpected hook blocks), run `syntaur doctor` to diagnose. Use `--json` for structured output.

## Conventions

- Assignment frontmatter is the single source of truth.
- Slugs are lowercase and hyphen-separated.
- Update acceptance criteria and `## Todos` checkboxes as work lands, not only at the end.
- Keep the `## Progress` section in `assignment.md` current after meaningful milestones.
- When requirements shift, supersede the prior plan todo (`- [x] ~~...~~ (superseded by plan-v<N>)`) instead of rewriting the old plan file.
- Write handoffs with enough context for another agent or human to continue cleanly.

## References

Read these only when you need the detailed rules or directory layout:

- `../../references/protocol-summary.md`
- `../../references/file-ownership.md`
