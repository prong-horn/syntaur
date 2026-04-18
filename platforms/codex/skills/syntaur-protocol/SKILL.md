---
name: syntaur-protocol
description: Use when the user mentions Syntaur, missions, assignments, files under ~/.syntaur/, assignment.md, plan.md, handoff.md, .syntaur/context.json, lifecycle states, or write boundaries.
---

# Syntaur Protocol

You are working within the Syntaur protocol. Follow these rules at all times.

## Write Boundary Rules

Respect file ownership boundaries.

### Files you may write

1. Your assignment folder only:
   - `assignment.md`
   - `plan.md`
   - `scratchpad.md`
   - `handoff.md`
   - `decision-record.md`
2. Mission-level shared files:
   - `~/.syntaur/missions/<mission>/resources/<slug>.md`
   - `~/.syntaur/missions/<mission>/memories/<slug>.md`
3. Workspace files inside the assignment's configured workspace root
4. `.syntaur/context.json` in the current working directory

### Files you must never write

1. `mission.md`, `agent.md`, `claude.md`
2. `manifest.md`
3. Any file prefixed with `_`
4. Other agents' assignment folders
5. Anything outside the current workspace boundary

## Current Assignment Context

If `.syntaur/context.json` exists in the current working directory, read it before making changes. Use it to determine:

- `missionSlug`
- `assignmentSlug`
- `missionDir`
- `assignmentDir`
- `workspaceRoot`
- `sessionId` if present

## Required Reading Order

When you are working on an existing assignment, read these in order:

1. `<missionDir>/manifest.md`
2. `<missionDir>/agent.md`
3. `<missionDir>/mission.md`
4. `<missionDir>/claude.md` if it exists
5. `<assignmentDir>/assignment.md`
6. `<assignmentDir>/plan.md`
7. `<assignmentDir>/handoff.md`

## Lifecycle Commands

Use the `syntaur` CLI for state transitions:

- `syntaur assign <slug> --agent <name> --mission <mission>`
- `syntaur start <slug> --mission <mission>`
- `syntaur review <slug> --mission <mission>`
- `syntaur complete <slug> --mission <mission>`
- `syntaur block <slug> --mission <mission> --reason <text>`
- `syntaur unblock <slug> --mission <mission>`
- `syntaur fail <slug> --mission <mission>`

## Troubleshooting

If Syntaur state looks inconsistent (missing files, stale manifests, unexpected hook blocks), run `syntaur doctor` to diagnose. Use `--json` for structured output.

## Conventions

- Assignment frontmatter is the single source of truth.
- Slugs are lowercase and hyphen-separated.
- Update acceptance criteria checkboxes as work lands, not only at the end.
- Keep the `## Progress` section in `assignment.md` current after meaningful milestones.
- Write handoffs with enough context for another agent or human to continue cleanly.

## References

Read these only when you need the detailed rules or directory layout:

- `../../references/protocol-summary.md`
- `../../references/file-ownership.md`
