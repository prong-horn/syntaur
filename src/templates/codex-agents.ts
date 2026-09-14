export interface CodexAgentsParams {
  projectSlug: string;
  ticketSlug: string;
  projectDir: string;
  ticketDir: string;
}

export function renderCodexAgents(params: CodexAgentsParams): string {
  return `# Syntaur Protocol -- Agent Instructions

This project uses the Syntaur protocol for multi-agent project coordination.

## Current Ticket

- **Project:** ${params.projectSlug}
- **Ticket:** ${params.ticketSlug}
- **Project directory:** ${params.projectDir}
- **Ticket directory:** ${params.ticketDir}

## Preferred Workflow

If the global Syntaur Codex plugin is installed, prefer these workflows instead of ad hoc protocol edits:

- \`syntaur-operator\` agent -- use for broad Syntaur protocol work or when a task spans multiple lifecycle steps
- \`syntaur-protocol\` -- background protocol and write-boundary rules
- \`create-project\` -- scaffold a project
- \`create-ticket\` -- create a new ticket (use \`-t|--template <id>\`; defaults to the scratch project and allocates a \`<PREFIX>-<n>\` id)
- \`grab-ticket\` -- claim work, create \`.syntaur/context.json\`, and register a session
- \`plan-ticket\` -- write a versioned plan file (\`plan.md\`, \`plan-v2.md\`, ...)
- \`complete-ticket\` -- record the cross-ticket handoff and a final progress entry in the files \`syntaur show\` lists, close the session, and transition state
- \`resume-session\` -- re-orient on the active ticket from \`.syntaur/context.json\` and any open handoff so a fresh session picks up without re-reading the transcript
- \`replan\` -- bump the active ticket to a new \`plan-v<N>.md\` per the Plan Versioning playbook (CLI does file ops, skill writes the body)
- \`syntaur-worktree\` -- atomic worktree creation under \`<repository>/.worktrees/<branch>\` plus assign + start + context binding in one move
- \`list-tickets\` -- cross-project listing with filters by status, project, tag, age (scriptable output for automation)
- \`log-progress\` -- append a timestamped progress entry to the template's log file via \`syntaur progress log\` (Keep Records Updated playbook)
- \`set-workspace\` -- populate the four \`workspace.*\` fields in \`ticket.md\`; validates via \`syntaur doctor --ticket --json\` before writing
- \`track-session\` -- register an agent session with the dashboard

If the plugin is unavailable, follow the same workflow manually with the \`syntaur\` CLI and keep the protocol files current yourself.

## Working the ticket

Run \`syntaur show\` (or \`syntaur show <id> --project ${params.projectSlug}\`) at the start of work and after every lifecycle verb. Follow **Stage** and **Next**.

Edit only \`ticket.md\` and files \`show\` lists with writer \`agent\`. Use the **Commands** line for CLI-mediated files. Never edit files \`show\` does not list.

## Context File

- Treat \`.syntaur/context.json\` in the current working directory as the active ticket context when it exists.
- Use that file to resolve the workspace boundary, ticket path, and project path (the active ticket binding). The active session id, however, is resolved from *your* running process -- prefer \`$CLAUDE_CODE_SESSION_ID\` (or the peer \`OPENCODE_SESSION_ID\` / \`PI_SESSION_ID\`), otherwise run \`syntaur session resolve-id\`; the \`sessionId\` scalar in context.json is only a clobberable legacy hint, not authoritative.
- If there is no context file yet and you are supposed to work on a ticket, claim or set up the ticket before editing code.

## Directory Structure

\`\`\`
~/.syntaur/
  config.md
  projects/
    <project-slug>/
      manifest.md            # Derived: root navigation (read-only)
      project.md             # Human-authored: project overview (read-only)
      _index-tickets.md  # Derived (read-only)
      _index-plans.md        # Derived (read-only)
      _index-decisions.md    # Derived (read-only)
      _status.md             # Derived (read-only)
      tickets/
        <ID>-<slug>/         # Folder name; ID is <PREFIX>-<n> from project.md
          ticket.md          # Kernel: source of truth for state
          …                  # Template-owned files (see \`syntaur show\`)
      resources/
        <resource-slug>.md   # Shared-writable
      memories/
        <memory-slug>.md     # Shared-writable
\`\`\`

One-off tickets default to \`projects/scratch/\` (prefix \`SCR\`) when created via \`syntaur new\` without \`--project\`. There is no standalone \`~/.syntaur/tickets/\` tree.

## Write Boundary Rules (CRITICAL)

### Files you may WRITE:
1. **Your ticket folder** -- only the ticket you are currently working on:
   - \`ticket.md\` and any files \`syntaur show\` lists with writer \`agent\` (template-specific; never hardcode sidecar names)
   - Path: \`${params.ticketDir}/\`
2. **Shared resources and memories** at the project level:
   - \`${params.projectDir}/resources/<slug>.md\`
   - \`${params.projectDir}/memories/<slug>.md\`
3. **Your workspace** -- source code files in the current working directory (the directory where this AGENTS.md lives). If your ticket's frontmatter specifies a \`workspace\` field, read it at runtime to determine the exact boundary.

> **Note:** Workspace boundaries are resolved by the agent at runtime by reading \`ticket.md\` frontmatter. If no \`workspace\` field is set, treat the current working directory as your workspace.

### Files written only via CLI (never edit directly):
- \`comments.md\` (any ticket) -- use \`syntaur comment <id> "body" [--type question|note|feedback] [--reply-to <id>]\`

### Files you must NEVER write:
1. \`project.md\` -- human-authored, read-only
2. \`manifest.md\` -- derived, rebuilt by tooling
3. Any file prefixed with \`_\` -- derived
4. Other agents' ticket folders (except via the CLI-mediated channels above)
5. Any files outside your workspace boundary

## Ticket Lifecycle

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
- \`syntaur assign ${params.ticketSlug} --agent <name> --project ${params.projectSlug}\` -- set assignee
- \`syntaur start ${params.ticketSlug} --project ${params.projectSlug}\` -- pending -> in_progress
- \`syntaur review ${params.ticketSlug} --project ${params.projectSlug}\` -- in_progress -> review
- \`syntaur complete ${params.ticketSlug} --project ${params.projectSlug}\` -- in_progress/review -> completed
- \`syntaur block ${params.ticketSlug} --project ${params.projectSlug} --reason <text>\` -- block
- \`syntaur unblock ${params.ticketSlug} --project ${params.projectSlug}\` -- unblock
- \`syntaur fail ${params.ticketSlug} --project ${params.projectSlug}\` -- mark as failed
- \`syntaur comment ${params.ticketSlug} "body" --type question|note|feedback [--reply-to <id>]\` -- append to \`comments.md\` (use for all Q&A; questions support resolve toggle)

## Troubleshooting

If Syntaur state looks inconsistent (missing files, stale manifests, unexpected hook blocks), run \`syntaur doctor\` to diagnose. Use \`--json\` for structured output.

## Playbooks

Playbooks are user-defined behavioral rules stored in \`~/.syntaur/playbooks/\`. Before starting work, read the playbook manifest and then each referenced playbook:

\`\`\`bash
cat ~/.syntaur/playbooks/manifest.md
\`\`\`

Read each linked playbook and follow the rules in its body section. The \`when_to_use\` field tells you when each playbook applies. Playbooks take precedence over default conventions when they conflict.

## Conventions

- Ticket frontmatter is the single source of truth for state. \`id\` is \`<PREFIX>-<n>\`; \`project\` is the containing project slug; \`template\` names the ticket template.
- Ticket folders are \`<ID>-<slug>\`. Slugs are lowercase, hyphen-separated and may be renamed with \`syntaur rename\`.
- \`depends_on\` and \`links\` hold ticket ids, not slugs.
- Run \`syntaur show <id>\` at the start of work and after every lifecycle verb; follow Stage and Next.
- Keep \`ticket.md\` acceptance criteria updated as work lands; use the Commands line from \`show\` for log and comment writes.
- Keep active plan file(s) current after planning changes. Record the cross-ticket handoff (via \`complete-ticket\`) at the cross-ticket boundary.
- When requirements shift, write a new versioned plan file instead of rewriting the old one.
- Record questions, notes, and feedback via \`syntaur comment\`. Never edit \`comments.md\` directly. Resolve questions via the dashboard UI (toggle on the question entry).
- Commit frequently with messages referencing the ticket slug.
`;
}
