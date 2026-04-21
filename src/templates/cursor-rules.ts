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
      claude.md              # Human-authored: Claude-specific instructions (read-only)
      agent.md               # Human-authored: universal agent instructions (read-only)
      assignments/
        <assignment-slug>/
          assignment.md      # Agent-writable: source of truth for state (includes ## Todos)
          plan*.md           # Agent-writable: versioned implementation plans (optional, one per ## Todos entry)
          scratchpad.md      # Agent-writable: working notes
          handoff.md         # Agent-writable: append-only handoff log
          decision-record.md # Agent-writable: append-only decision log
      resources/
        _index.md            # Derived (read-only)
        <resource-slug>.md   # Shared-writable
      memories/
        _index.md            # Derived (read-only)
        <memory-slug>.md     # Shared-writable
\`\`\`

## Write Boundary Rules (CRITICAL)

### Files you may WRITE:
1. **Your assignment folder** -- only the assignment you are currently working on:
   - \`assignment.md\`, \`plan*.md\` (0 or more versioned plan files), \`scratchpad.md\`, \`handoff.md\`, \`decision-record.md\`
   - Path: \`~/.syntaur/projects/<project>/assignments/<your-assignment>/\`
2. **Shared resources and memories** at the project level:
   - \`~/.syntaur/projects/<project>/resources/<slug>.md\`
   - \`~/.syntaur/projects/<project>/memories/<slug>.md\`
3. **Your workspace** -- source code files in the current working directory (the directory where this adapter file lives). If your assignment's frontmatter specifies a \`workspace\` field, read it at runtime to determine the exact boundary.

> **Note:** The \`setup-adapter\` command does not parse assignment frontmatter for workspace paths. Workspace boundaries are resolved by the agent at runtime by reading \`assignment.md\` frontmatter. If no \`workspace\` field is set, treat the current working directory as your workspace.

### Files you must NEVER write:
1. \`project.md\`, \`agent.md\`, \`claude.md\` -- human-authored, read-only
2. \`manifest.md\` -- derived, rebuilt by tooling
3. Any file prefixed with \`_\` -- derived
4. Other agents' assignment folders
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

Use the \`syntaur\` CLI for state transitions:
- \`syntaur assign <slug> --agent <name> --project <project>\` -- set assignee
- \`syntaur start <slug> --project <project>\` -- pending -> in_progress
- \`syntaur review <slug> --project <project>\` -- in_progress -> review
- \`syntaur complete <slug> --project <project>\` -- in_progress/review -> completed
- \`syntaur block <slug> --project <project> --reason <text>\` -- block an assignment
- \`syntaur unblock <slug> --project <project>\` -- unblock
- \`syntaur fail <slug> --project <project>\` -- mark as failed

## Playbooks

Playbooks are user-defined behavioral rules stored in \`~/.syntaur/playbooks/\`. Read the playbook manifest before starting work:

\`\`\`bash
cat ~/.syntaur/playbooks/manifest.md
\`\`\`

Follow the rules in each playbook. They take precedence over default conventions when they conflict.

## Conventions

- Assignment frontmatter is the single source of truth for state
- Slugs are lowercase, hyphen-separated
- Always read \`agent.md\` at the project level before starting work
- Add unanswered questions to the Q&A section of assignment.md
- Commit frequently with messages referencing the assignment slug
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
1. \`${params.projectDir}/agent.md\` -- universal agent instructions and boundaries
2. \`${params.projectDir}/project.md\` -- project overview and goals
3. \`${params.assignmentDir}/assignment.md\` -- your assignment details, acceptance criteria, todos, current status
4. any \`${params.assignmentDir}/plan*.md\` files linked from active todos in the \`## Todos\` section (may be 0, 1, or many)
5. \`${params.assignmentDir}/handoff.md\` -- previous session handoff notes

## Your Writable Files

You may ONLY write to files inside your assignment folder:
- \`${params.assignmentDir}/assignment.md\`
- \`${params.assignmentDir}/plan*.md\` (0 or more versioned plan files, e.g., \`plan.md\`, \`plan-v2.md\`)
- \`${params.assignmentDir}/scratchpad.md\`
- \`${params.assignmentDir}/handoff.md\`
- \`${params.assignmentDir}/decision-record.md\`

And source code files in your workspace. Read the \`workspace\` field from your assignment's frontmatter to determine the exact boundary. If not set, the current working directory is your workspace.
`;
}
