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
   - Path: \`~/.syntaur/projects/<project>/tickets/<ID>-<slug>/\`
2. **Shared resources and memories** at the project level:
   - \`~/.syntaur/projects/<project>/resources/<slug>.md\`
   - \`~/.syntaur/projects/<project>/memories/<slug>.md\`
3. **Your workspace** -- source code files in the current working directory (the directory where this adapter file lives). If your ticket's frontmatter specifies a \`workspace\` field, read it at runtime to determine the exact boundary.

> **Note:** The \`setup-adapter\` command does not parse ticket frontmatter for workspace paths. Workspace boundaries are resolved by the agent at runtime by reading \`ticket.md\` frontmatter. If no \`workspace\` field is set, treat the current working directory as your workspace.

### Files written only via CLI (never edit directly):
- Log-role file (\`journal.md\` on modern templates) -- use \`syntaur log <id> -t <type> "body"\` (seven types: progress, decision, handoff, note, question, answer, review)

### Files you must NEVER write:
1. \`project.md\` -- human-authored, read-only
2. \`manifest.md\` -- derived, rebuilt by tooling
3. Any file prefixed with \`_\` -- derived
4. Other agents' ticket folders (except via the CLI-mediated channels above)
5. Any files outside your workspace boundary

## Ticket Lifecycle

Stages (stored in \`status\` frontmatter):

| Stage | Meaning |
|-------|---------|
| \`backlog\` | Not yet started |
| \`planning\` | Plan being written |
| \`ready\` | Plan approved, waiting to start |
| \`in_progress\` | Actively being worked on |
| \`review\` | Awaiting review |
| \`done\` | Completed |
| \`dropped\` | Abandoned or failed |

Flags (not stages): \`blocked\` and \`parked\` hold reason strings or \`null\`.

## Lifecycle Commands

Use the \`syntaur\` CLI for stage moves and flags (\`--by <name>\` attributes the action in the audit log; default \`human\`):
- \`syntaur assign <id> --agent <name> --project <project>\` -- set assignee (not stage dispatch)
- \`syntaur plan create [--ticket <id>] [--project <project>] [--by <name>]\` -- scaffold plan; may move to planning
- \`syntaur approve <id> --project <project> [--by <name>]\` -- approve plan, move to ready
- \`syntaur start <id> --project <project> [--agent <id>] [--by <name>]\` -- move to in_progress; \`--agent\` is a one-use stage dispatch recipient only
- \`syntaur review <id> --project <project> [--by <name>]\` -- move to review
- \`syntaur done <id> --project <project> [--by <name>]\` -- move to done
- \`syntaur drop <id> "<reason>" --project <project> [--by <name>]\` -- move to dropped
- \`syntaur reopen <id> --project <project> [--by <name>]\` -- reopen from done/dropped
- \`syntaur block <id> "<reason>" --project <project> [--by <name>]\` -- set blocked flag
- \`syntaur unblock <id> --project <project> [--by <name>]\` -- clear blocked flag
- \`syntaur park <id> "<reason>" --project <project> [--by <name>]\` -- set parked flag
- \`syntaur unpark <id> --project <project> [--by <name>]\` -- clear parked flag
- \`syntaur new "Title" [-t|--template <id>] [--project <slug>]\` -- create ticket (defaults to scratch); allocates \`<PREFIX>-<n>\` id
- \`syntaur rename <id> <new-slug>\` -- rename slug (folder becomes \`<ID>-<new-slug>\`)
- \`syntaur log <id> -t <type> "body" [--agent <id>]\` -- append to the template log role (\`--agent\` is log author, not dispatch)

## Stage handoff

Template stages may declare \`agent\` or \`reviewer\` (not both) with optional \`auto\`. Entering a stage may queue **one** exact-target dashboard turn — separate from ordinary chat, which stays available at every stage. \`syntaur show\` lists **Handoff:** (latest log handoff) and **Agent:** (dispatch status) on separate lines. A \`completed\` receipt means the agent turn ended, not that review passed or the ticket is done. Offline dispatch leaves the stage move intact; retry from the ticket page **Hand to** without repeating the lifecycle verb. Example Library definitions: implementer \`cursor\` / \`composer-2.5\`; reviewer \`reviewer\` on harness \`cursor\` / \`cursor-grok-4.6-high\`.

## Stage instructions and playbooks

Run \`syntaur show <id>\` at the start of work and after every lifecycle verb; follow **Stage** and **Next**. Template stage instructions carry the guidance for that ticket's workflow. User playbooks that are not claimed by any template manifest are injected on each prompt by the Claude Code \`UserPromptSubmit\` hook (\`syntaur session context\`); they apply on top of stage instructions when present.

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
