export interface CodexAgentsParams {
  missionSlug: string;
  assignmentSlug: string;
  missionDir: string;
  assignmentDir: string;
}

export function renderCodexAgents(params: CodexAgentsParams): string {
  return `# Syntaur Protocol -- Agent Instructions

This project uses the Syntaur protocol for multi-agent mission coordination.

## Current Assignment

- **Mission:** ${params.missionSlug}
- **Assignment:** ${params.assignmentSlug}
- **Mission directory:** ${params.missionDir}
- **Assignment directory:** ${params.assignmentDir}

## Reading Order

Before starting work, read these files in order:
1. \`${params.missionDir}/agent.md\` -- universal agent instructions and boundaries
2. \`${params.missionDir}/mission.md\` -- mission overview and goals
3. \`${params.assignmentDir}/assignment.md\` -- your assignment details, acceptance criteria, current status
4. \`${params.assignmentDir}/plan.md\` -- your implementation plan
5. \`${params.assignmentDir}/handoff.md\` -- previous session handoff notes

## Directory Structure

\`\`\`
~/.syntaur/
  config.md
  missions/
    <mission-slug>/
      manifest.md            # Derived: root navigation (read-only)
      mission.md             # Human-authored: mission overview (read-only)
      _index-assignments.md  # Derived (read-only)
      _index-plans.md        # Derived (read-only)
      _index-decisions.md    # Derived (read-only)
      _index-sessions.md     # Derived (read-only)
      _status.md             # Derived (read-only)
      claude.md              # Human-authored: Claude-specific instructions (read-only)
      agent.md               # Human-authored: universal agent instructions (read-only)
      assignments/
        <assignment-slug>/
          assignment.md      # Agent-writable: source of truth for state
          plan.md            # Agent-writable: implementation plan
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
   - \`assignment.md\`, \`plan.md\`, \`scratchpad.md\`, \`handoff.md\`, \`decision-record.md\`
   - Path: \`${params.assignmentDir}/\`
2. **Shared resources and memories** at the mission level:
   - \`${params.missionDir}/resources/<slug>.md\`
   - \`${params.missionDir}/memories/<slug>.md\`
3. **Your workspace** -- source code files in the current working directory (the directory where this AGENTS.md lives). If your assignment's frontmatter specifies a \`workspace\` field, read it at runtime to determine the exact boundary.

> **Note:** Workspace boundaries are resolved by the agent at runtime by reading \`assignment.md\` frontmatter. If no \`workspace\` field is set, treat the current working directory as your workspace.

### Files you must NEVER write:
1. \`mission.md\`, \`agent.md\`, \`claude.md\` -- human-authored, read-only
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
- \`syntaur assign ${params.assignmentSlug} --agent <name> --mission ${params.missionSlug}\` -- set assignee
- \`syntaur start ${params.assignmentSlug} --mission ${params.missionSlug}\` -- pending -> in_progress
- \`syntaur review ${params.assignmentSlug} --mission ${params.missionSlug}\` -- in_progress -> review
- \`syntaur complete ${params.assignmentSlug} --mission ${params.missionSlug}\` -- in_progress/review -> completed
- \`syntaur block ${params.assignmentSlug} --mission ${params.missionSlug} --reason <text>\` -- block
- \`syntaur unblock ${params.assignmentSlug} --mission ${params.missionSlug}\` -- unblock
- \`syntaur fail ${params.assignmentSlug} --mission ${params.missionSlug}\` -- mark as failed

## Conventions

- Assignment frontmatter is the single source of truth for state
- Slugs are lowercase, hyphen-separated
- Always read \`agent.md\` at the mission level before starting work
- Add unanswered questions to the Q&A section of assignment.md
- Commit frequently with messages referencing the assignment slug
`;
}
