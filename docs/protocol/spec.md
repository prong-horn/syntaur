# Syntaur Protocol Specification

**Version:** 2.0

---

## 1. Introduction

The Syntaur protocol is a markdown-based file structure and format that serves as the "API" for the Syntaur platform. It defines how projects (high-level objectives), tickets (units of work), and their associated metadata are organized on the filesystem.

Any agent framework that can read and write files can participate in the Syntaur protocol. There is no proprietary wire format, no database to connect to, and no SDK to install. The protocol is the file system layout itself: a set of markdown files with YAML frontmatter arranged in a specific directory structure under `~/.syntaur/`.

Agents discover work by reading markdown files, report progress by updating markdown files, and coordinate with each other through the structure the protocol defines. Humans oversee and steer projects by editing the files they own. Derived files — rebuilt automatically by tooling — provide at-a-glance dashboards of project state.

This document is the authoritative conceptual reference for the protocol. For detailed field-level schemas of every file type, see [file-formats.md](./file-formats.md). A reader should be able to understand the entire protocol from this document alone.

---

## 2. Design Principles

### Markdown-as-Database

Every file in the protocol uses YAML frontmatter for structured, machine-readable fields and a markdown body for human-readable prose. This means a single file serves both as a data record and as a readable document. There is no separate database — the filesystem is the database.

### Agent-Framework Agnostic

The protocol does not assume any particular agent framework. Claude Code, Cursor, Codex, custom scripts — anything that can read a file and write a file can participate. Framework-specific configuration (e.g., `claude.md` for Claude Code) supplements the universal protocol files but is never required.

### Human-Readable

Every file in the protocol can be opened in a text editor and understood without specialized tooling. Status, dependencies, progress, and decisions are all visible as plain text. Derived files like dependency graphs use Mermaid syntax that renders in most markdown viewers.

### Machine-Parseable

YAML frontmatter provides structured fields with defined types and valid values. Tooling can parse frontmatter to build indexes, compute status rollups, enforce lifecycle rules, and power dashboards — all without fragile regex parsing of prose content.

### Workspace Grouping

Projects can optionally declare a `workspace` string in their frontmatter to group related projects by codebase or project context. This is a flat organizational label -- not a directory hierarchy. The dashboard uses workspace values to scope navigation and filtering. Projects without a workspace are treated as "Ungrouped." Note: the project-level `workspace` (a string) is distinct from the ticket-level `workspace` (an object containing repository, branch, and worktree information).

### Minimal Nesting

The directory structure is intentionally flat. Projects contain tickets, and that is the deepest nesting goes. Cross-references between tickets use slugs, not deeply nested paths. Index files at the project level provide navigation without requiring directory traversal.

### Derived Indexes

Computed files (index tables, status rollups, dependency graphs) are rebuilt from canonical sources by tooling. They are never manually edited. This separation means the canonical data (ticket frontmatter) is always authoritative, and the derived views are always reconstructable.

---

## 3. Directory Structure

The root of all Syntaur data is `~/.syntaur/`. Below is the full directory tree with every file's purpose:

```
~/.syntaur/
  config.md                          # Global Syntaur configuration (optional)
  projects/
    <project-slug>/
      manifest.md                    # Derived: root navigation file linking all indexes
      project.md                     # Human-authored: project overview, goal, context, success criteria
      _index-tickets.md          # Derived: ticket summary table with status counts
      _index-plans.md                # Derived: plan status summary table
      _index-decisions.md            # Derived: decision record summary table
      _status.md                     # Derived: computed project status, ticket rollup, dependency graph
      tickets/
        <ID>-<slug>/                 # Agent-writable ticket folder; ID is <PREFIX>-<n> from project.md
          ticket.md              # Agent-writable: the ticket record (source of truth for state)
          plan*.md                   # Agent-writable: versioned implementation plans (optional, 0 or more: plan.md, plan-v2.md, ...)
          progress.md                # Agent-writable, append-only: timestamped progress log
          comments.md                # CLI-mediated shared-writable: threaded questions/notes/feedback
          scratchpad.md              # Agent-writable: unstructured working memory
          handoff.md                 # Agent-writable: append-only **ticket-level cross-ticket outbound** at completion
          decision-record.md         # Agent-writable: append-only decision log
      resources/
        <resource-slug>.md           # Shared-writable: reference material for the project
      memories/
        <memory-slug>.md             # Shared-writable: learnings discovered during the project
  templates/
    <template-id>/
      template.md                    # Human-authored: ticket template manifest (stages, files, gates)
      ...                            # Optional companion files copied with custom templates
  playbooks/
    manifest.md                      # Derived: playbook listing with descriptions and when_to_use
    <slug>.md                        # User-authored: behavioral rules and workflows for agents
  syntaur.db                         # SQLite: agent sessions
```

### Key structural observations

- **One folder per project.** The folder name is the project slug and matches the `slug` field in `project.md` frontmatter.
- **All tickets live under a project.** Ticket folders are at `projects/<project-slug>/tickets/<ID>-<slug>/`, where `ID` is `<PREFIX>-<n>` (e.g. `FIT-3-implement-jwt-middleware`). The `prefix` and `nextTicket` counter live in `project.md`; ids are allocated by `syntaur new` and never reused. The `slug` is the human-readable suffix and may be renamed with `syntaur rename`.
- **Scratch project** (`projects/scratch/`, prefix `SCR`) holds tickets created without `--project`. `syntaur new` defaults here when `--project` is omitted. There is no standalone `~/.syntaur/tickets/` tree.
- **Derived files use an underscore prefix** (`_index-*`, `_status.md`, `_index.md`). This sorts them to the top of directory listings and signals "do not edit manually."
- **`manifest.md` is the entry point for a project.** An agent starting work on a project reads `manifest.md` first to discover all other files.
- **Resources and memories live at the project level**, not inside tickets. They are shared context available to all tickets in the project.
- **Templates live at the home level** (`~/.syntaur/templates/`). Five built-ins ship with the CLI (`feature`, `bug`, `spike`, `quick`, `legacy`); each is a directory with a `template.md` manifest. `syntaur init` seeds any missing built-ins. Custom templates are copies under the same tree.

---

## 4. File Ownership Rules

Every file in the protocol belongs to exactly one of five ownership categories. These categories determine who may write to a file and how conflicts are avoided.

### Human-Authored

Files written and maintained exclusively by humans. Agents read these but never modify them.

| File | Purpose |
|------|---------|
| `project.md` | Project overview, goal, context, success criteria |
| `templates/<id>/template.md` | Ticket template manifest (stages, file roles, gates). Built-ins are seeded from the package; humans may copy and customize. |

### Agent-Writable

Files inside ticket folders. Only the assigned agent writes to its own ticket folder. This single-writer guarantee prevents conflicts between concurrent agents. The single exception is `comments.md`, which is CLI-mediated so other agents and humans can append.

| File | Purpose |
|------|---------|
| `ticket.md` | Ticket record and source of truth for state |
| `plan*.md` | Versioned implementation plans (optional, 0 or more: `plan.md`, `plan-v2.md`, ...) |
| `progress.md` | Append-only timestamped progress log (replaces the old `## Progress` body section) |
| `scratchpad.md` | Unstructured working notes |
| `handoff.md` | Append-only handoff log |
| `decision-record.md` | Append-only decision log |

### CLI-Mediated Shared-Writable

Inside a ticket folder but writable by anyone through the CLI/API — never via direct editing. This preserves safe concurrency without abandoning the single-writer guarantee at the filesystem level.

| File | Purpose | Mediator |
|------|---------|----------|
| `comments.md` | Threaded questions/notes/feedback (replaces the old `## Questions & Answers` body section). Questions carry a `resolved` flag. | `syntaur comment` CLI and dashboard write API |

### Shared-Writable

Files in the `resources/` and `memories/` folders. Both humans and agents can create and update files here directly. There is no single-owner constraint — these are shared project context.

| File | Purpose |
|------|---------|
| `resources/<resource-slug>.md` | Reference material (docs, API specs, architecture notes) |
| `memories/<memory-slug>.md` | Learnings and patterns discovered during the project |

The `source` field in each file's frontmatter tracks who created it (e.g., `"human"`, `"claude-1"`), providing authorship provenance.

### Derived

Files generated by the rebuild script. Never edited manually. Always reconstructable from canonical sources.

| File | Purpose |
|------|---------|
| `manifest.md` | Root navigation file |
| `_index-tickets.md` | Ticket summary table |
| `_index-plans.md` | Plan status summary |
| `_index-decisions.md` | Decision record summary |
| `_status.md` | Computed project status, rollup, and dependency graph |

---

## 5. Source of Truth

**Ticket frontmatter is the single source of truth for all ticket state.**

This is the most important rule in the protocol. The `status`, `priority`, `assignee`, `depends_on`, `template`, `plan`, `workspace`, and all other structured fields in a ticket's YAML frontmatter are canonical. Every other representation of this data is a projection:

- The checkbox list in `_status.md` is a projection.
- The summary table in `_index-tickets.md` is a projection.
- The Mermaid dependency graph in `_status.md` is a projection.
- The `by_status` counts in `_index-tickets.md` frontmatter are projections.
- The project-level `status` in `_status.md` is a projection (computed from ticket states).

**When there is divergence between ticket frontmatter and any derived file, ticket frontmatter wins.** The correct response to a divergence is to re-run the rebuild script, which will regenerate all derived files from the canonical ticket data.

Similarly, `project.md` frontmatter is the canonical source for project-level human-authored fields (`archived`, `archivedAt`, `archivedReason`, `title`, `externalIds`). Project status, however, is not stored in `project.md` — it is computed from ticket states and written to `_status.md` by the rebuild script.

**Workspace naming note:** On `ticket.md`, `workspace` is an **object** containing code context fields (`repository`, `worktree`, `branch`, `parentBranch`) — the git worktree where the ticket's code lives. This is unrelated to the Syntaur workspace marker file (`.syntaur/context.json`), which identifies the repository/branch/worktree of the agent's current working directory.

---

## 6. Lifecycle Overview

### Stages

Every ticket has a `status` field in its frontmatter holding a **stage id** from the fixed vocabulary. Templates declare an ordered subset and may relabel display names; they must never invent stage ids.

| Stage id | Meaning | Typical entry verb |
|----------|---------|-------------------|
| `backlog` | Not started | `syntaur new` |
| `planning` | Plan being written | `plan` |
| `ready` | Plan approved, waiting to start | `approve` |
| `in_progress` | Active implementation | `start` |
| `review` | Awaiting or in review | `review` |
| `done` | Successfully completed | `done` |
| `dropped` | Abandoned or failed | `drop` |

`dropped` is implicit for every template — it is never listed in a template's `stages[]`, and `drop` works from any active stage. `ready` is valid only when the template declares a `plan` role; templates without a plan role use `backlog → in_progress` (no `planning`/`ready` stages).

**Stage order:** `backlog < planning < ready < in_progress < review < done` (`dropped` is aside).

Status moves only by explicit lifecycle verbs (`plan`, `approve`, `start`, `review`, `done`, `drop`, `reopen`). Gates declared on the template run at call time; `--force` skips gates and records `forced: true` on the `moved` event.

#### Gate table

| Gate id | Reads | Passes when |
|---------|-------|-------------|
| `plan-exists` | plan role file | File exists and is non-empty beyond scaffold |
| `plan-approved` | plan role + `plan.approvedDigest` | SHA-256 digest of current plan file equals `plan.approvedDigest` |
| `deps-done` | `depends_on` + ticket statuses | Every depended ticket is `done` |
| `workspace-set` | `workspace` frontmatter | All four workspace fields non-empty when template `workspace: required` |
| `criteria-checked` | Acceptance Criteria checkboxes | Every box checked |
| `handoff-logged` | log role | `handoff` entry later than last entry into `in_progress` or last `reopen` |
| `review-clean` | log role | Latest `review` entry is `approve` with `high=0`, after last entry into `review` or `reopen` |
| `deliverable-present` | deliverable role | File non-empty beyond scaffold |

Gate failure shape: `Cannot <verb> <ID>: <gate> — <reason>. Next: <hint>` (exit 1).

#### Verb table

| Verb | From (by template) | To | Gates (typical) | Side effects |
|------|-------------------|-----|-----------------|--------------|
| `plan` | stage before `planning`, or any active if no `planning` | `planning` or file-only | — | create/scaffold plan file |
| `approve` | stage before `ready`, or any active if no `planning`/`ready` | `ready` or file-only | `plan-exists` | set `plan.approved*` |
| `start` | stage before `in_progress` | `in_progress` | `plan-approved`, `deps-done`, `workspace-set` (per template) | dispatch if `auto` |
| `review` | stage before `review` | `review` | — | dispatch reviewer if configured |
| `done` | stage before `done` | `done` | per template `gates.done` | — |
| `drop` | any active | `dropped` | reason required | — |
| `reopen` | `done` or `dropped` | stage before `done` in subset | — | keeps `plan.approvedDigest` |
| `block` | any | — (flag) | reason required | `blocked: reason` |
| `unblock` | any | — | — | `blocked: null` |
| `park` | any | — (flag) | reason required | `parked: reason` |
| `unpark` | any | — | — | `parked: null` |

`plan version` creates `plan-v<N>.md`, sets `plan.file`, clears approval, and moves to `planning` when the template declares a `planning` stage.

### Flags

`blocked` and `parked` are **flags**, not stages. They hold a reason string or `null` in ticket frontmatter. A flagged ticket keeps its stage and shows a badge on the board and in `show`.

| Flag | Set by | Cleared by |
|------|--------|------------|
| `blocked` | `syntaur block <id> "<reason>"` | `syntaur unblock <id>` |
| `parked` | `syntaur park <id> "<reason>"` | `syntaur unpark <id>` |

`block` and `park` require a non-empty reason.

### Dependency Semantics

Tickets declare dependencies via `depends_on`, which lists ticket ids (`<PREFIX>-<n>`).

- **`backlog` (or any pre-`in_progress` stage) with unmet `depends_on`** — the ticket is waiting for dependencies to reach `done`. The `deps-done` gate on `start` enforces this; no extra field is needed.

- **`blocked` flag** — a manual or runtime obstacle unrelated to declared dependencies (missing credentials, external system down, unclear requirements). Set with `syntaur block` and a reason string.

Structural waiting on dependencies is normal and resolves when dependencies complete. A `blocked` flag is exceptional and requires explicit clearance via `unblock`.

### Project Status Rollup

Project status is not stored in `project.md`. It is computed from ticket stages and flags and written to `_status.md`. Rules are evaluated top-to-bottom; first match wins:

| Priority | Condition | Resulting Status |
|----------|-----------|-----------------|
| 1 | `project.md` has `archived: true` | `archived` |
| 2 | ALL tickets are `done` | `completed` |
| 3 | ANY ticket is `in_progress` or `review` | `active` |
| 4 | ANY ticket is `dropped` | `failed` |
| 5 | ANY ticket has `blocked` set | `blocked` |
| 6 | ALL tickets are `backlog` (or pre-active stages only) | `pending` |
| 7 | Otherwise | `active` |

**Valid project statuses:** `pending`, `active`, `blocked`, `completed`, `failed`, `archived`.

`archived` is a human-authored override in `project.md` frontmatter. It is the only project status not computed from ticket states.

### Edge Case Examples

- **2 done + 1 backlog + 0 active** = `active` (rule 7). Work remains but nothing is running.

- **1 done + 1 blocked flag + 1 backlog** = `blocked` (rule 5). The blocked flag takes precedence.

- **1 in_progress + 1 dropped + 1 done** = `active` (rule 3). Active work takes precedence over drops.

- **3 done** = `completed` (rule 2).

- **Human sets `archived: true` on `project.md`** = `archived` (rule 1).

---

## 7. Naming Conventions

### Project Slugs

Lowercase, hyphen-separated. The slug is used as the project folder name and stored in the `slug` field of `project.md` frontmatter.

Examples: `build-auth-system`, `migrate-to-postgres`, `q1-performance-audit`

### Ticket Slugs

Lowercase, hyphen-separated. The slug is used as the ticket folder name and stored in the `slug` field of `ticket.md` frontmatter.

Examples: `design-auth-schema`, `implement-jwt-middleware`, `write-auth-tests`

### Derived Files

All derived files use an underscore prefix to distinguish them from human-authored and agent-writable files:

- `_index-tickets.md`
- `_index-plans.md`
- `_index-decisions.md`
- `_status.md`

The underscore prefix serves two purposes: it sorts derived files to the top of directory listings, and it provides a clear visual signal that these files should not be edited manually.

### Resource and Memory Slugs

Lowercase, hyphen-separated. The filename (slug) is the canonical identifier for resources and memories. Unlike projects and tickets, they do not carry a separate `id`/`slug` in frontmatter — the `name` field is display-only.

Examples: `auth-requirements.md`, `postgres-connection-pooling.md`

---

## 8. Timestamp & Path Normalization

### Timestamps

All timestamps throughout the protocol use **RFC 3339 / ISO 8601 with UTC offset**.

Format: `2026-03-18T14:30:00Z`

This applies to every timestamp field in frontmatter (`created`, `updated`, `generated`, `archivedAt`, etc.) and to timestamps in markdown body content (progress entries, handoff dates, decision dates, session times).

### Filesystem Paths

**Local filesystem path fields** (`workspace.worktree`, `defaultProjectDir`, and any other local path stored in YAML frontmatter or config) use the **absolute expanded form**. Never store `~` literally — always expand to the full path at write time.

**Note:** `workspace.repository` is exempt from this rule — it may be either a local absolute path or a remote URL (e.g., `https://github.com/org/repo.git`, `git@github.com:org/repo.git`). Only local filesystem paths require absolute expansion.

```yaml
# Correct
workspace:
  worktree: /Users/brennen/worktrees/build-auth-system/implement-jwt-middleware

# Incorrect
workspace:
  worktree: ~/worktrees/build-auth-system/implement-jwt-middleware
```

**Intra-project markdown links** (links between files within the same project folder) use **relative paths** for portability. If a project folder is moved or renamed, relative links remain valid.

```markdown
## Links
- [Ticket](./tickets/implement-jwt-middleware/ticket.md)
- [Status](./_status.md)
```

---

## 9. Versioning

The protocol version is tracked in two places:

- **`manifest.md` frontmatter** — the `version` field in each project's manifest indicates which protocol version the project was created with.
- **`config.md` frontmatter** — the `version` field in the global config indicates the installed protocol version.

The current protocol version is **`"2.0"`**.

### Changes in 2.0

- **`project` added to `ticket.md` frontmatter.** `project: string | null` makes the containing project explicit (`null` for standalone). Ticket classification moved to `template:` (see Templates section).
- **`progress.md` and `comments.md`** replace the old `## Progress` and `## Questions & Answers` body sections in `ticket.md`. See sections 3 and 4.
- **Standalone tickets** at `~/.syntaur/tickets/<uuid>/` — tickets that don't belong to any project. Folder is named by UUID.
- **`_status.md` field rename** — `needsAttention.unansweredQuestions` → `needsAttention.openQuestions`, now computed from `comments.md` (question entries with `resolved !== true`).

### Forward Compatibility

- **Additive changes** (new optional fields, new file types) will increment the minor version and remain backward compatible. A tool that understands version `2.0` can safely ignore fields it does not recognize.
- **Breaking changes** (removed fields, changed semantics, restructured directories) will increment the major version. Tooling should check the version field and warn if it encounters a version it does not support.
- **The `version` field is a string**, not a number, to support semver-style versioning (e.g., `"2.0"`, `"2.1"`, `"3.0"`).

Tooling should always write the version it supports and should handle unknown versions gracefully — logging a warning rather than failing silently or crashing.

---

## 10. Cross-Ticket References

Tickets frequently need to reference each other — a newly-created ticket may depend on an older one, a question may cross a boundary, or a decision in one ticket may affect another.

### Declared Dependencies

The `depends_on` field in `ticket.md` frontmatter is the structural form of a cross-ticket reference. It holds an array of ticket ids this one depends on. The lifecycle engine blocks transitions out of `pending` while any dependency is not `completed`. Dependencies are only valid between tickets within the **same project** — standalone tickets may not declare `depends_on` entries (the dashboard write API validates this).

### Markdown Links

Any markdown body (ticket, progress, comments, handoff) may reference another ticket with a normal markdown link. Two link forms resolve to a ticket:

- **Relative path** — `[title](../other-slug/ticket.md)` for project-nested peers.
- **Absolute route** — `[title](/projects/<slug>/tickets/<aslug>/ticket.md)` for project-nested cross-project links, or `[title](/tickets/<id>/ticket.md)` for standalone tickets.

Tooling can resolve these links in both directions. The **forward** direction is explicit in the link. The **backward** direction (`Referenced by`) is computed by the dashboard when it loads a ticket detail — it scans other tickets' comments, progress, and handoff bodies for links that resolve to the current ticket. Results are capped at 50 mentions to bound work.

---

## 11. Ticket Templates

A **template** declares how a ticket is worked: stage instructions, which files exist and who writes them, workspace requirements, and lifecycle gates. The ticket's `template` frontmatter field names the active template (replacing the old `type` field).

**Built-ins:** `feature`, `bug`, `spike`, `quick`, and `legacy`. New tickets default to the project's `defaultTemplate` (usually `feature`). Migrated v1 tickets are assigned `legacy`, which maps existing sidecar files (`progress.md`, `plan.md`, `comments.md`, etc.) to roles without rewriting them.

**Agent guide:** `syntaur show <id>` renders the ticket summary — objective, acceptance, workspace, dependencies, declared files with roles and state, log tail, current stage instructions, a **Next** line, and CLI **Commands**. Agents and chat standing context use this rendered text as the authoritative file list; they do not hardcode filenames.

**Management:** `syntaur template list|new|check|reset` for manifests; `syntaur retemplate <id> <template>` to switch a ticket and scaffold missing files. See [file-formats.md](./file-formats.md) for the `template.md` manifest schema and `ticket.md` frontmatter fields (`template`, `depends_on`, `plan`).
