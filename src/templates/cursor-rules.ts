export interface CursorAssignmentParams {
  projectSlug: string;
  assignmentSlug: string;
  projectDir: string;
  assignmentDir: string;
}

export function renderCursorProtocol(): string {
  return `---
description: Syntaur protocol rules for multi-agent coordination
globs:
alwaysApply: true
---

# Syntaur Protocol

You are working within the Syntaur protocol for multi-agent project coordination.

## Directory Structure

\`\`\`
~/.syntaur/
  config.md
  projects/
    <project-slug>/
      manifest.md            # Derived: root navigation (read-only)
      project.md             # Human-authored: project overview (read-only)
      _index-assignments.md  # Derived (read-only)
      _index-plans.md        # Derived (read-only)
      _index-decisions.md    # Derived (read-only)
      _status.md             # Derived (read-only)
      assignments/
        <assignment-slug>/
          assignment.md      # Agent-writable: source of truth for state (includes ## Todos)
          plan*.md           # Agent-writable: versioned implementation plans (optional, one per ## Todos entry)
          progress.md        # Agent-writable, append-only: timestamped progress log
          comments.md        # CLI-mediated: threaded questions/notes/feedback (via \`syntaur comment\`)
          scratchpad.md      # Agent-writable: working notes
          handoff.md         # Agent-writable: append-only handoff log
          decision-record.md # Agent-writable: append-only decision log
      resources/
        _index.md            # Derived (read-only)
        <resource-slug>.md   # Shared-writable
      memories/
        _index.md            # Derived (read-only)
        <memory-slug>.md     # Shared-writable
  assignments/
    <assignment-id>/         # Standalone assignments — folder = UUID, \`project: null\`, slug display-only
      assignment.md
      plan*.md
      progress.md
      comments.md
      scratchpad.md
      handoff.md
      decision-record.md
\`\`\`

## Write Boundary Rules (CRITICAL)

### Files you may WRITE:
1. **Your assignment folder** -- only the assignment you are currently working on:
   - \`assignment.md\`, \`plan*.md\` (0 or more versioned plan files), \`progress.md\`, \`scratchpad.md\`, \`handoff.md\`, \`decision-record.md\`
   - Path (project-nested): \`~/.syntaur/projects/<project>/assignments/<your-assignment>/\`
   - Path (standalone): \`~/.syntaur/assignments/<your-assignment-uuid>/\`
2. **Shared resources and memories** at the project level:
   - \`~/.syntaur/projects/<project>/resources/<slug>.md\`
   - \`~/.syntaur/projects/<project>/memories/<slug>.md\`
3. **Your workspace** -- source code files in the current working directory (the directory where this adapter file lives). If your assignment's frontmatter specifies a \`workspace\` field, read it at runtime to determine the exact boundary.

> **Note:** The \`setup-adapter\` command does not parse assignment frontmatter for workspace paths. Workspace boundaries are resolved by the agent at runtime by reading \`assignment.md\` frontmatter. If no \`workspace\` field is set, treat the current working directory as your workspace.

### Files written only via CLI (never edit directly):
- \`comments.md\` (any assignment) -- use \`syntaur comment <slug-or-uuid> "body" [--type question|note|feedback] [--reply-to <id>]\`
- Another assignment's \`## Todos\` section -- use \`syntaur request <source> <target> "text"\` to request cross-assignment work

### Files you must NEVER write:
1. \`project.md\` -- human-authored, read-only
2. \`manifest.md\` -- derived, rebuilt by tooling
3. Any file prefixed with \`_\` -- derived
4. Other agents' assignment folders (except via the CLI-mediated channels above)
5. Any files outside your workspace boundary

## Assignment Lifecycle

| Status | Meaning |
|--------|---------|
| \`pending\` | Not yet started |
| \`in_progress\` | Actively being worked on |
| \`blocked\` | Manually blocked (requires blockedReason) |
| \`review\` | Work complete, awaiting review |
| \`completed\` | Done |
| \`failed\` | Could not be completed |

## Valid State Transitions

| From | Command | To |
|------|---------|-----|
| pending | start | in_progress |
| pending | block | blocked |
| in_progress | block | blocked |
| in_progress | review | review |
| in_progress | complete | completed |
| in_progress | fail | failed |
| blocked | unblock | in_progress |
| review | start | in_progress |
| review | complete | completed |
| review | fail | failed |

## Lifecycle Commands

Use the \`syntaur\` CLI for state transitions and coordination:
- \`syntaur assign <slug> --agent <name> --project <project>\` -- set assignee
- \`syntaur start <slug> --project <project>\` -- pending -> in_progress
- \`syntaur review <slug> --project <project>\` -- in_progress -> review
- \`syntaur complete <slug> --project <project>\` -- in_progress/review -> completed
- \`syntaur block <slug> --project <project> --reason <text>\` -- block an assignment
- \`syntaur unblock <slug> --project <project>\` -- unblock
- \`syntaur fail <slug> --project <project>\` -- mark as failed
- \`syntaur create-assignment "Title" [--type <type>] [--project <slug> | --one-off]\` -- create project-nested or standalone assignment
- \`syntaur comment <slug-or-uuid> "body" --type question|note|feedback [--reply-to <id>]\` -- append to \`comments.md\` (questions support resolve toggle via dashboard)
- \`syntaur request <source> <target> "text"\` -- append a todo to another assignment's \`## Todos\` annotated \`(from: <source>)\`

## Playbooks

Playbooks are user-defined behavioral rules stored in \`~/.syntaur/playbooks/\`. Read the playbook manifest before starting work:

\`\`\`bash
cat ~/.syntaur/playbooks/manifest.md
\`\`\`

Follow the rules in each playbook. They take precedence over default conventions when they conflict.

## Conventions

- Assignment frontmatter is the single source of truth for state. \`project\` is the containing project slug (\`null\` for standalone); \`type\` is a classification validated against \`config.md\` \`types.definitions\` when present.
- Slugs are lowercase, hyphen-separated. Standalone assignment folders are named by UUID; \`slug\` is display-only in that case.
- Always read \`project.md\` at the project level (when project-nested) before starting work.
- Append timestamped entries to \`progress.md\` (never to \`assignment.md\`).
- Record questions, notes, and feedback via \`syntaur comment\`. Never edit \`comments.md\` directly.
- To route work to another assignment, use \`syntaur request\`.
- Commit frequently with messages referencing the assignment slug.
`;
}

export function renderCursorAssignment(params: CursorAssignmentParams): string {
  return `---
description: Syntaur assignment context for ${params.projectSlug}/${params.assignmentSlug}
globs:
alwaysApply: true
---

# Current Assignment Context

- **Project:** ${params.projectSlug}
- **Assignment:** ${params.assignmentSlug}
- **Project directory:** ${params.projectDir}
- **Assignment directory:** ${params.assignmentDir}

## Reading Order

Before starting work, read these files in order:
1. \`${params.projectDir}/project.md\` -- project overview and goals (project-nested assignments only)
2. \`${params.assignmentDir}/assignment.md\` -- your assignment details, acceptance criteria, todos, current status. Frontmatter includes \`project: <slug> | null\` (null for standalone) and \`type: <classification> | null\`.
3. any \`${params.assignmentDir}/plan*.md\` files linked from active todos in the \`## Todos\` section (may be 0, 1, or many)
4. \`${params.assignmentDir}/progress.md\` -- reverse-chron progress log (if present)
5. \`${params.assignmentDir}/comments.md\` -- threaded questions/notes/feedback (if present)
6. \`${params.assignmentDir}/handoff.md\` -- previous session handoff notes

## Your Writable Files

You may write directly to these files inside your assignment folder:
- \`${params.assignmentDir}/assignment.md\`
- \`${params.assignmentDir}/plan*.md\` (0 or more versioned plan files, e.g., \`plan.md\`, \`plan-v2.md\`)
- \`${params.assignmentDir}/progress.md\` (append timestamped entries, newest first)
- \`${params.assignmentDir}/scratchpad.md\`
- \`${params.assignmentDir}/handoff.md\`
- \`${params.assignmentDir}/decision-record.md\`

Do NOT edit \`${params.assignmentDir}/comments.md\` directly — use \`syntaur comment\`. Do NOT edit other assignments' files — use \`syntaur request\` for cross-assignment todos.

And source code files in your workspace. Read the \`workspace\` field from your assignment's frontmatter to determine the exact boundary. If not set, the current working directory is your workspace.
`;
}
