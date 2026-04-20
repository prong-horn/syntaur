# File Ownership Rules

## Human-Authored (READ-ONLY for agents)

Agents must NEVER modify these files:

| File | Location |
|------|----------|
| `mission.md` | `<mission>/mission.md` |
| `agent.md` | `<mission>/agent.md` |
| `claude.md` | `<mission>/claude.md` |

## Agent-Writable (YOUR assignment folder ONLY)

You may ONLY write to files inside your assigned assignment folder:

| File | Purpose |
|------|---------|
| `assignment.md` | Assignment record, source of truth for state (includes `## Todos` checklist) |
| `plan*.md` | Versioned implementation plans (optional, 0 or more: `plan.md`, `plan-v2.md`, ...) — each linked from a todo in `assignment.md` |
| `scratchpad.md` | Working notes |
| `handoff.md` | Append-only handoff log |
| `decision-record.md` | Append-only decision log |

Path pattern: `~/.syntaur/missions/<mission>/assignments/<your-assignment>/`

## Shared-Writable (any agent or human)

| Location | Purpose |
|----------|---------|
| `<mission>/resources/<slug>.md` | Reference material |
| `<mission>/memories/<slug>.md` | Learnings and patterns |

## Derived (NEVER edit)

All files prefixed with `_` are derived and rebuilt by tooling:
- `manifest.md`
- `_index-assignments.md`
- `_index-plans.md`
- `_index-decisions.md`
- `_status.md`
- `resources/_index.md`
- `memories/_index.md`

## Workspace Files

When working on code (not protocol files), you may write to files within
the workspace defined in your assignment frontmatter:
- `workspace.worktreePath` or `workspace.repository` defines your project root
- You may create and edit source code files within that workspace
- The `.syntaur/context.json` context file in your working directory is also writable
