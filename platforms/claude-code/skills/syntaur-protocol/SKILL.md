---
name: syntaur-protocol
description: This skill should be used when the user mentions "syntaur", "assignment", "project", works with files under ~/.syntaur/, references assignment.md, plan.md, handoff.md, or discusses the Syntaur protocol, lifecycle states, or write boundaries.
version: 0.1.0
---

# Syntaur Protocol Knowledge

You are working within the Syntaur protocol. Follow these rules at all times.

## Write Boundary Rules (CRITICAL)

You MUST respect file ownership boundaries. Violations will be blocked by the PreToolUse hook.

### Files you may WRITE:
1. **Your assignment folder** -- only the assignment you are currently working on:
   - `assignment.md`, `plan*.md` (0 or more versioned plan files), `scratchpad.md`, `handoff.md`, `decision-record.md`
   - Path: `~/.syntaur/projects/<project>/assignments/<your-assignment>/`
2. **Shared resources and memories** at the project level:
   - `~/.syntaur/projects/<project>/resources/<slug>.md`
   - `~/.syntaur/projects/<project>/memories/<slug>.md`
3. **Your workspace** -- source code files within the workspace defined in your assignment's frontmatter (`workspace.worktreePath` or `workspace.repository`)
4. **Context file** -- `.syntaur/context.json` in the current working directory

### Files you must NEVER write:
1. `project.md`, `agent.md`, `claude.md` -- human-authored, read-only
2. `manifest.md` -- derived, rebuilt by tooling
3. Any file prefixed with `_` (`_index-*.md`, `_status.md`) -- derived
4. Other agents' assignment folders
5. Any files outside your workspace boundary

## Current Assignment Context

If `.syntaur/context.json` exists in the current working directory, read it to determine:
- `projectSlug` -- which project you are working on
- `assignmentSlug` -- which assignment is yours
- `projectDir` -- absolute path to the project folder
- `assignmentDir` -- absolute path to your assignment folder
- `workspaceRoot` -- absolute path to your code workspace (if set)

## Protocol References

For detailed protocol information, read these files:
- **Protocol summary:** `${CLAUDE_PLUGIN_ROOT}/references/protocol-summary.md`
- **File ownership rules:** `${CLAUDE_PLUGIN_ROOT}/references/file-ownership.md`

## Lifecycle Commands

Use the `syntaur` CLI for state transitions. Available commands:
- `syntaur assign <slug> --agent <name> --project <project>` -- set assignee
- `syntaur start <slug> --project <project>` -- pending -> in_progress
- `syntaur review <slug> --project <project>` -- in_progress -> review
- `syntaur complete <slug> --project <project>` -- in_progress/review -> completed
- `syntaur block <slug> --project <project> --reason <text>` -- block an assignment
- `syntaur unblock <slug> --project <project>` -- unblock
- `syntaur fail <slug> --project <project>` -- mark as failed

## Troubleshooting

If Syntaur state looks inconsistent (missing files, stale manifests, unexpected hook blocks), run `syntaur doctor` to diagnose. The `/doctor-syntaur` slash command wraps it and helps interpret results.

## Playbooks

Playbooks are user-defined behavioral rules stored in `~/.syntaur/playbooks/`. Each playbook is a markdown file with imperative rules that agents must follow. When you begin work on any assignment, read all playbook files and follow their directives. Playbooks take precedence over default conventions when they conflict.

```bash
ls ~/.syntaur/playbooks/*.md 2>/dev/null
```

## Conventions

- Assignment frontmatter is the single source of truth for state
- Slugs are lowercase, hyphen-separated
- Always read `agent.md` and `claude.md` at the project level before starting work
- Add unanswered questions to the Q&A section of assignment.md (do not set status to blocked for questions)
- Commit frequently with messages referencing the assignment slug
