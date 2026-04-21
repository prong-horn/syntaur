---
name: syntaur-protocol
description: This skill should be used when the user mentions "syntaur", "assignment", "project", works with files under ~/.syntaur/, references assignment.md, plan.md, handoff.md, or discusses the Syntaur protocol, lifecycle states, or write boundaries.
version: 0.1.0
---

# Syntaur Protocol Knowledge

You are working within the Syntaur protocol. Follow these rules at all times.

## Write Boundary Rules (CRITICAL)

You MUST respect file ownership boundaries. Violations will be blocked by the PreToolUse hook.

### Files you may WRITE directly:
1. **Your assignment folder** -- only the assignment you are currently working on:
   - `assignment.md`, `plan*.md` (0 or more versioned plan files), `progress.md`, `scratchpad.md`, `handoff.md`, `decision-record.md`
   - Path (project-nested): `~/.syntaur/projects/<project>/assignments/<your-assignment>/`
   - Path (standalone): `~/.syntaur/assignments/<your-assignment-uuid>/` — folder named by UUID, `project: null`, `slug` display-only
2. **Shared resources and memories** at the project level:
   - `~/.syntaur/projects/<project>/resources/<slug>.md`
   - `~/.syntaur/projects/<project>/memories/<slug>.md`
3. **Your workspace** -- source code files within the workspace defined in your assignment's frontmatter (`workspace.worktreePath` or `workspace.repository`)
4. **Context file** -- `.syntaur/context.json` in the current working directory

### Files written only via CLI (never edit directly):
- `comments.md` (any assignment) — use `syntaur comment <slug-or-uuid> "body" --type question|note|feedback [--reply-to <id>]`. Never edit directly. Questions carry a `resolved` flag toggled in the dashboard.
- Another assignment's `## Todos` section — use `syntaur request <target> "text"` to append a todo annotated `(from: <source>)`.

### Files you must NEVER write:
1. `project.md` -- human-authored, read-only
2. `manifest.md` -- derived, rebuilt by tooling
3. Any file prefixed with `_` (`_index-*.md`, `_status.md`) -- derived
4. Other agents' assignment folders (except via the CLI-mediated channels above)
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

Use the `syntaur` CLI for state transitions and coordination:
- `syntaur assign <slug> --agent <name> --project <project>` -- set assignee
- `syntaur start <slug> --project <project>` -- pending -> in_progress
- `syntaur review <slug> --project <project>` -- in_progress -> review
- `syntaur complete <slug> --project <project>` -- in_progress/review -> completed
- `syntaur block <slug> --project <project> --reason <text>` -- block an assignment
- `syntaur unblock <slug> --project <project>` -- unblock
- `syntaur fail <slug> --project <project>` -- mark as failed
- `syntaur create-assignment "<title>" [--type <type>] [--project <slug> | --one-off]` -- create project-nested or standalone assignment
- `syntaur comment <slug-or-uuid> "body" --type question|note|feedback [--reply-to <id>]` -- append to `comments.md`
- `syntaur request <target> "text" [--from <source>]` -- append a todo to another assignment's `## Todos`

## Troubleshooting

If Syntaur state looks inconsistent (missing files, stale manifests, unexpected hook blocks), run `syntaur doctor` to diagnose. The `/doctor-syntaur` slash command wraps it and helps interpret results.

## Playbooks

Playbooks are user-defined behavioral rules stored in `~/.syntaur/playbooks/`. Each playbook is a markdown file with imperative rules that agents must follow. When you begin work on any assignment, read all playbook files and follow their directives. Playbooks take precedence over default conventions when they conflict.

```bash
ls ~/.syntaur/playbooks/*.md 2>/dev/null
```

## Conventions

- Assignment frontmatter is the single source of truth for state. `project` is the containing project slug (`null` for standalone); `type` is a classification validated against `config.md` `types.definitions` when present.
- Slugs are lowercase, hyphen-separated. For standalone assignments, the folder is named by UUID; `slug` is display-only.
- Always read `project.md` at the project level (when project-nested) before starting work.
- Append timestamped entries to `progress.md` as work lands — do NOT add a `## Progress` section to `assignment.md`.
- Record questions/notes/feedback via `syntaur comment` — never edit `comments.md` directly. Do NOT set status to blocked for questions.
- Use `syntaur request` to route work to another assignment.
- Commit frequently with messages referencing the assignment slug.
