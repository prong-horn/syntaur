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
   - Path: `~/.syntaur/missions/<mission>/assignments/<your-assignment>/`
2. **Shared resources and memories** at the mission level:
   - `~/.syntaur/missions/<mission>/resources/<slug>.md`
   - `~/.syntaur/missions/<mission>/memories/<slug>.md`
3. **Your workspace** -- source code files within the workspace defined in your assignment's frontmatter (`workspace.worktreePath` or `workspace.repository`)
4. **Context file** -- `.syntaur/context.json` in the current working directory

### Files you must NEVER write:
1. `mission.md`, `agent.md`, `claude.md` -- human-authored, read-only
2. `manifest.md` -- derived, rebuilt by tooling
3. Any file prefixed with `_` (`_index-*.md`, `_status.md`) -- derived
4. Other agents' assignment folders
5. Any files outside your workspace boundary

## Current Assignment Context

If `.syntaur/context.json` exists in the current working directory, read it to determine:
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
