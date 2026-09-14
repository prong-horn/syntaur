export interface CursorTicketParams {
  projectSlug: string;
  ticketSlug: string;
  projectDir: string;
  ticketDir: string;
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
      _index-tickets.md  # Derived (read-only)
      _index-plans.md        # Derived (read-only)
      _index-decisions.md    # Derived (read-only)
      _status.md             # Derived (read-only)
      tickets/
        <ID>-<slug>/         # Folder name; ID is <PREFIX>-<n> from project.md
          ticket.md      # Agent-writable: source of truth for state
          plan*.md           # Agent-writable: versioned implementation plans (optional)
          progress.md        # Agent-writable, append-only: timestamped progress log
          comments.md        # CLI-mediated: threaded questions/notes/feedback (via \`syntaur comment\`)
          scratchpad.md      # Agent-writable: working notes
          handoff.md         # Agent-writable: append-only cross-ticket outbound at completion
          decision-record.md # Agent-writable: append-only decision log
      resources/
        <resource-slug>.md   # Shared-writable
      memories/
        <memory-slug>.md     # Shared-writable
\`\`\`

One-off tickets default to \`projects/scratch/\` (prefix \`SCR\`) when created via \`syntaur new\` without \`--project\`. There is no standalone \`~/.syntaur/tickets/\` tree.

## Write Boundary Rules (CRITICAL)

### Files you may WRITE:
1. **Your ticket folder** -- only the ticket you are currently working on:
   - \`ticket.md\`, \`plan*.md\` (0 or more versioned plan files), \`progress.md\`, \`scratchpad.md\`, \`handoff.md\` (cross-ticket outbound at completion), \`decision-record.md\`
   - Path: \`~/.syntaur/projects/<project>/tickets/<ID>-<slug>/\`
2. **Shared resources and memories** at the project level:
   - \`~/.syntaur/projects/<project>/resources/<slug>.md\`
   - \`~/.syntaur/projects/<project>/memories/<slug>.md\`
3. **Your workspace** -- source code files in the current working directory (the directory where this adapter file lives). If your ticket's frontmatter specifies a \`workspace\` field, read it at runtime to determine the exact boundary.

> **Note:** The \`setup-adapter\` command does not parse ticket frontmatter for workspace paths. Workspace boundaries are resolved by the agent at runtime by reading \`ticket.md\` frontmatter. If no \`workspace\` field is set, treat the current working directory as your workspace.

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
- \`syntaur assign <id> --agent <name> --project <project>\` -- set assignee
- \`syntaur start <id> --project <project>\` -- pending -> in_progress
- \`syntaur review <id> --project <project>\` -- in_progress -> review
- \`syntaur complete <id> --project <project>\` -- in_progress/review -> completed
- \`syntaur block <id> --project <project> --reason <text>\` -- block a ticket
- \`syntaur unblock <id> --project <project>\` -- unblock
- \`syntaur fail <id> --project <project>\` -- mark as failed
- \`syntaur new "Title" [--type <type>] [--project <slug>]\` -- create ticket (defaults to scratch); allocates \`<PREFIX>-<n>\` id
- \`syntaur rename <id> <new-slug>\` -- rename slug (folder becomes \`<ID>-<new-slug>\`)
- \`syntaur comment <id> "body" --type question|note|feedback [--reply-to <id>]\` -- append to \`comments.md\` (questions support resolve toggle via dashboard)

## Playbooks

Playbooks are user-defined behavioral rules stored in \`~/.syntaur/playbooks/\`. Read the playbook manifest before starting work:

\`\`\`bash
cat ~/.syntaur/playbooks/manifest.md
\`\`\`

Follow the rules in each playbook. They take precedence over default conventions when they conflict.

## Conventions

- Ticket frontmatter is the single source of truth for state. \`id\` is \`<PREFIX>-<n>\`; \`project\` is the containing project slug; \`template\` names the ticket template.
- Ticket folders are \`<ID>-<slug>\`. Slugs are lowercase, hyphen-separated and may be renamed with \`syntaur rename\`.
- \`depends_on\` and \`links\` hold ticket ids, not slugs.
- Run \`syntaur show <id>\` at the start of work and after every lifecycle verb; follow Stage and Next.
- Edit only \`ticket.md\` and files listed by \`show\` with writer \`agent\`; use the Commands line for CLI-mediated files.
- Commit frequently with messages referencing the ticket slug.
`;
}

export function renderCursorTicket(params: CursorTicketParams): string {
  return `---
description: Syntaur ticket context for ${params.projectSlug}/${params.ticketSlug}
globs:
alwaysApply: true
---

# Current Ticket Context

- **Project:** ${params.projectSlug}
- **Ticket:** ${params.ticketSlug}
- **Project directory:** ${params.projectDir}
- **Ticket directory:** ${params.ticketDir}

## Working the ticket

Run \`syntaur show\` (or \`syntaur show <id> --project ${params.projectSlug}\`) at the start of work and after every lifecycle verb. Follow **Stage** and **Next**.

Edit only \`ticket.md\` and the files \`show\` lists with writer \`agent\`. Use the **Commands** line for CLI-mediated files. Never edit files \`show\` does not list.

Read \`${params.projectDir}/project.md\` when you need project context. Workspace source code stays inside the ticket's configured worktree (or the current working directory when unset).
`;
}
