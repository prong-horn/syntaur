---
title: Syntaur v2 Specification
date: 2026-09-11
status: draft
binding_decisions:
  - Kernel is ticket.md plus chat/; every other file is template-defined
  - Fixed stage vocabulary; templates pick an ordered subset; blocked and parked are flags
  - Roles are a closed list defined by kernel behaviour; descriptions are mandatory and are for the agent
  - Status moves only by explicit verbs; gates come from the template and run at call time
  - Agents learn a ticket through the rendered syntaur show; skills never hardcode filenames
  - Stage agents and reviewers are hand-off defaults, never a lock; gates check artifacts, not authors
  - One noun ticket; short ids; the legacy template makes existing tickets valid without rewriting files
audit: Codex-info/plans/2026-09-10-syntaur-v2-audit.md
---

# Syntaur v2 Specification

## Acceptance criteria mapping

| Criterion | Section |
|---|---|
| Spec exists at `Codex-info/plans/syntaur-v2-spec.md` and is the single reference for other syntaur-v2 tickets | §1 |
| Kernel: `ticket.md` frontmatter and sections, `chat/` ownership by the broker | §3.3, §3.4 |
| Fixed stage vocabulary; templates may only pick an ordered subset and relabel | §3.5 |
| Exactly four roles with kernel behaviour and the rule for adding one | §4 |
| Complete template manifest schema with mandatory descriptions | §5.2, §5.3 |
| Verb table with gate checks | §6.1 |
| Rendered `syntaur show` with worked example and Next line; same text for ACP | §7 |
| Ticket id scheme: per-project prefix + counter | §3.6 |
| Legacy template and v1→v2 migration steps | §5.4, §10 |
| Delete list and keep list with audit evidence | §11 |
| Reviewed through the plan-review loop | *(driver, §12)* |

## 1. Purpose and scope

This document is the contract for Syntaur v2. Every ticket in the `syntaur-v2` project implements a section of this spec. The spec fixes fields, ids, grammars, tables, and migration contracts; algorithms and UI details belong to downstream tickets unless stated here.

Scope: the kernel (`ticket.md` + `chat/`), the fixed stage vocabulary, the four file roles, the template manifest contract, lifecycle verbs and gates, rendered `syntaur show` output, ticket ids, the legacy template, v1→v2 migration, delete and keep lists, Needs me and board mapping, agent surface, and the CLI surface.

Out of scope for this document: implementation code, dashboard wireframes, and the independent review loop (driver-owned).

Evidence and rationale: [2026-09-10 audit](Codex-info/plans/2026-09-10-syntaur-v2-audit.md). The seven binding decisions in `decision-record.md` for assignment `spec` are not reopened here.

*Left to ticket release-1-0: version cut and release checklist.*

## 2. Vocabulary

| Term | Meaning |
|---|---|
| ticket | The unit of work; replaces "assignment" everywhere |
| project | A container under `~/.syntaur/projects/<slug>/` with `project.md` and `tickets/` |
| template | A directory under `~/.syntaur/templates/<name>/` defining stages, files, gates, and workspace policy |
| kernel | The invariant core: `ticket.md` and `chat/` only |
| role | One of `plan`, `log`, `notes`, `deliverable`; defines tool behaviour for a template file |
| stage | One of the fixed ids in §3.5; stored in `ticket.md` `status` |
| flag | `blocked` or `parked`; a reason string or null; does not change stage |
| gate | A named check a verb evaluates at call time when declared on the template |
| verb | A CLI command that may move `status`, set flags, or act on role files |
| broker | The chat subsystem that owns `chat/` and supplies standing context to ACP participants |
| show | The rendered ticket summary from `syntaur show <id>` |

The noun is **ticket** in user-facing text, file names (`ticket.md`), and database keys. Verbs drop the noun: `syntaur new`, not `syntaur new-ticket`.

## 3. Kernel

### 3.1 Home layout

```
~/.syntaur/
  config.md                 # human via dashboard Settings; CLI reads
  templates/                # built-ins on init/upgrade; human edits copies
  playbooks/                # human via dashboard Library
  agents/                   # human via dashboard Library
  projects/<slug>/
    project.md              # CLI on project new; human edits metadata
    tickets/<ID>-<slug>/   # CLI on new/migrate
  syntaur.db                # CLI operational cache (sessions, chat index, events, usage)
  inbox-snoozes.json        # CLI on snooze API/verb
```

Gone in v2 (see §11): `workspaces.json`, standalone `assignments/<uuid>/`, `todos/`, `servers/`, `targets/`, `workflows/`, `saved-views.json`, memories, resources, backup subsystem.

**Kept:** `view-prefs.json` — keyed by project only; workspace keys are dropped (`delete-views-and-workspaces`).

`SYNTAUR_HOME` overrides `~/.syntaur` per `src/utils/paths.ts:11`.

*Left to ticket derived-state-to-db: drop derived index files and `_status.md` under projects.*

### 3.2 project.md

Frontmatter:

| Field | Type | Required | Default | Writer | Meaning |
|---|---|---|---|---|---|
| `slug` | string | yes | — | CLI | Directory name under `projects/` |
| `title` | string | yes | — | human | Display name |
| `prefix` | string | yes | derived | CLI | 2–5 uppercase letters, unique across projects |
| `nextTicket` | integer | yes | 1 | CLI | Next counter for id allocation |
| `defaultTemplate` | string | yes | `feature` | human | Default for `syntaur new` in this project |
| `created` | ISO-8601Z | yes | now | CLI | |
| `updated` | ISO-8601Z | yes | now | CLI | |

Body sections: `## Objective`, `## Context` (conventional).

**Id allocation contract.** Ids are `<PREFIX>-<n>`, URL-safe, never reused. `syntaur new` and `migrate v2` allocate under mutual exclusion; a crashed allocation must not wedge the counter. Source of truth is markdown (`nextTicket` in `project.md`); `syntaur.db` is a cache. The allocation mechanism (lock file, `flock`, or directory lock with stale recovery) is chosen by ticket `ticket-rename-and-ids`.

`migrate v2` assigns prefixes and prints them; default derivation is initials from the slug when not set.

*Left to ticket ticket-rename-and-ids: prefix assignment, uniqueness check, allocation implementation.*

### 3.3 Ticket folder and ticket.md

**Folder naming.** `projects/<project>/tickets/<ID>-<slug>/` (e.g. `SYN-142-needs-me-backlog-aging/`). The CLI, API, and links address tickets by `<ID>` alone; resolution is by id prefix match on folder names. `syntaur rename <id> <new-slug>` changes the slug and renames the folder.

**References.** `depends_on` and `links` hold ticket ids or external URLs, never slugs or paths.

**Unknown files.** Files and directories not declared in the template manifest (e.g. legacy `proof/`, `sessions/`) are ignored by every verb and not rendered by `show`.

**Kernel files never appear in `files[]`.** `ticket.md` and `chat/` are kernel-owned and are not manifest entries.

**ticket.md frontmatter** (17 fields):

| Field | Type | Required | Default | Writer | Meaning |
|---|---|---|---|---|---|
| `id` | string | yes | allocated | CLI | `<PREFIX>-<n>` |
| `slug` | string | yes | from title | CLI/human | Display-only; folder suffix |
| `title` | string | yes | — | human | |
| `project` | string | yes | — | CLI | Project slug |
| `template` | string | yes | project default | CLI | Template id |
| `status` | stage id | yes | first stage | CLI/verbs | Current stage |
| `priority` | enum | yes | template default | human | `low`, `medium`, `high`, `critical` |
| `blocked` | string or null | yes | null | verbs | Reason when blocked |
| `parked` | string or null | yes | null | verbs | Reason when parked |
| `depends_on` | string[] | yes | `[]` | human | Ticket ids |
| `assignee` | string or null | yes | null | human | Agent id or null |
| `tags` | string[] | yes | `[]` | human | |
| `links` | string[] | yes | `[]` | human | Ticket ids or URLs; rendered by `show` |
| `workspace` | object or null | yes | null | human/CLI | `repository`, `branch`, `worktree`, `parentBranch` |
| `plan` | object | yes | empty | CLI | `file`, `approvedDigest`, `approvedAt`, `approvedBy` |
| `created` | ISO-8601Z | yes | now | CLI | |
| `updated` | ISO-8601Z | yes | now | CLI | |

**Dropped fields** (migrator removes): `externalIds`, `workspaceGroup`, `type`, `statusHistory`, `archived`, `archivedAt`, `archivedReason`, `workflow`, `phase`, `disposition`, `planApproval`, `reviewRequested`, `reworkRequested`, `implementationStarted`, `override`, `facts`, `attestations`, `solicitations`, `firedVerdicts`, `frozenChecks`, `hold`, `gateOverrides`, `blockedReason` (folded into `blocked`).

**Required body sections.** `## Objective`, `## Acceptance Criteria` (checkbox list; `criteria-checked` gate reads this). `## Context` is conventional. There is no `## Links` section; links live in frontmatter only. Templates may add sections via their `ticket.md` skeleton.

**Edit rule.** `ticket.md` is the only kernel file agents edit directly (plus `notes`-role files declared by the template).

#### Example ticket.md (SYN-142)

```markdown
---
id: SYN-142
slug: needs-me-backlog-aging
title: "Needs me: age out the backlog with a max-age filter and snooze"
project: syntaur-meta
template: feature
status: in_progress
priority: medium
blocked: null
parked: null
depends_on:
  - SYN-138
assignee: cursor
tags: []
links: []
workspace:
  repository: /Users/brennen/syntaur
  branch: feat/needs-me-backlog-aging
  worktree: /Users/brennen/syntaur/.worktrees/feat/needs-me-backlog-aging
  parentBranch: main
plan:
  file: plan.md
  approvedDigest: bab1dba6528048e055493836349a0dd9da576ede52977c4505f09538d11c2d62
  approvedAt: "2026-09-10T20:11:46Z"
  approvedBy: human
created: "2026-09-10T12:12:50Z"
updated: "2026-09-10T22:38:43Z"
---

# Needs me: age out the backlog with a max-age filter and snooze

## Objective

Keep the Needs me queue from being dominated by reviews and plan approvals on parked projects. Two controls: a maximum-age filter on inbox rows and per-row snooze stored outside ticket files.

## Acceptance Criteria

- [x] Max-age filter in the core and API
- [x] Snooze store
- [x] Page controls
- [x] CLI parity
- [x] Docs, live check, gates

## Context

Depends on SYN-138 (live cards). Snoozes live in `inbox-snoozes.json` under the Syntaur home.
```

*Left to ticket templates: scaffold generation and `purpose:` injection into template files.*

### 3.4 chat/

Chat behaviour is unchanged from `docs/assignment-chat.md` (How a turn works `:19`, agent definitions `~/.syntaur/agents/<id>.md` `:56-159`, Needs me `:175-199`, data layout `:200-235`, multi-agent `:317-432`, slash commands `:433`).

**Contract additions for v2:**

1. **Standing context** per adapter session is the `syntaur show` text (`src/chat/broker.ts:19-20`). The broker embeds it once per session and refreshes on stage change.
2. **Record actions** (`fileChatRecord` at `src/chat/records.ts:147`, today `appendDecisionEntry` at `:160` from `src/lifecycle/log-append.ts:86`) write **log-role** entries via the log grammar (§4), not to a fixed filename.

*Left to ticket log-role-and-journal: repoint record actions to role-based log path.*

### 3.5 Stages and flags

**Fixed stage ids** (global order):

| Stage id | Meaning | Typical entry verb | Hidden on board when |
|---|---|---|---|
| `backlog` | Not started | `syntaur new` | never (unless filtered) |
| `planning` | Plan being written | `plan` | never |
| `ready` | Plan approved, waiting to start | `approve` | never |
| `in_progress` | Active implementation | `start` | never |
| `review` | Awaiting or in review | `review` | never |
| `done` | Successfully completed | `done` | older than N days (board filter) |
| `dropped` | Abandoned or failed | `drop` | older than N days (board filter) |

Templates declare an **ordered subset** of the active stage ids (`backlog` through `done`) and may relabel display names. `dropped` is never listed in a manifest's `stages[]`; it is implicit for every template, and `drop` works from any active stage. Templates must never invent stage ids. `template check` rejects unknown ids and rejects `dropped` in `stages[]` (rule 16).

**`ready` rule.** `ready` is valid only when the template declares a `plan` role. `approve` moves `planning → ready`. Templates without a plan role use `backlog → in_progress` (no `planning`/`ready` stages).

**Flags** (not stages):

| Flag | Type | Set by | Cleared by |
|---|---|---|---|
| `blocked` | reason string | `block <id> "<reason>"` | `unblock <id>` |
| `parked` | reason string | `park <id> "<reason>"` | `unpark <id>` |

A flagged ticket keeps its stage and shows a badge on the board and in `show`. `block` and `park` require a non-empty reason.

*Left to ticket lifecycle-verbs: verb implementation and stage transitions.*

### 3.6 Ids and folder names

- **Format:** `<PREFIX>-<n>` per project (e.g. `SYN-142`). URL-safe, never reused.
- **Slug:** display-only; used in folder suffix after id.
- **Resolution:** CLI/API accept id alone; folder match by id prefix.
- **Standalone tickets:** three v1 standalone assignments move into project `scratch` (prefix `SCR`), created lazily by `syntaur new` with no project and by `migrate v2`.
- **Database key:** every operational table references tickets by `id` string only (§6.3). UUID frontmatter ids are replaced during migration.
- **Timestamps and paths:** unchanged from `docs/protocol/spec.md` §8.

*Left to ticket ticket-rename-and-ids: migration maps, dry-run transcript, snooze key rewrite.*

## 4. Roles and the log grammar

### 4.1 Role: plan

| Aspect | Rule |
|---|---|
| Kernel behaviour | Approval gate: stores `plan.file`, `plan.approvedDigest`, `plan.approvedAt`, `plan.approvedBy` on `approve`; `plan version` creates `plan-v<N>.md`, sets `plan.file`, clears approval — moves to `planning` when the template declares a `planning` stage, otherwise a file action with no stage move |
| Constraints | At most one file per template |
| Verbs | `plan create`, `plan version`, `approve` |
| Without plan role | `plan`, `approve`, and `plan version` refuse; `ready` stage invalid; `plan-approved` gate unavailable |
| Gates reading it | `plan-exists`, `plan-approved` |

### 4.2 Role: log

| Aspect | Rule |
|---|---|
| Kernel behaviour | Append-only via `syntaur log`; typed entries; timeline; last-handoff lookup; review verdicts |
| Constraints | At most one file per template; `writer` must be `cli` |
| Verbs | `log` |
| Without log role | `syntaur log` appends a chat note, creating `chat/` if it does not exist yet (`chat/` is kernel; every ticket may have one); `handoff-logged` and `review-clean` gates unavailable |
| Gates reading it | `handoff-logged`, `review-clean`; Needs me tier 2 (open `question`) |

**Log file frontmatter:** `purpose` only (copied from manifest `description`).

**Entry grammar:**

```
## <ISO-8601Z> · <type> · <author>
<optional key lines>
<markdown body>
```

- **Types (exactly seven):** `progress`, `decision`, `handoff`, `note`, `question`, `answer`, `review`

This type list supersedes the shorter one in the `log-role-and-journal` ticket's criteria; that ticket is planned from this spec.

- **author:** agent id from `~/.syntaur/agents/` or `human`
- **Optional key lines** (directly under heading):
  - `verdict: approve|changes · open: high=<n> medium=<n>` — required on `review`
  - `answers: <ISO of question entry>` — required on `answer`
  - `attachments: <path>[, <path>]` — paths relative to `chat/attachments/` (`syntaur log --attach` copies in first)
- **Latest rule:** greatest timestamp wins; readers sort by timestamp. New log files are oldest-first; legacy `progress.md` is newest-first (tolerated).
- **`decision` body:** Status / Context / Decision / Consequences shape (`docs/protocol/file-formats.md:580-641`)
- **`handoff`:** required entry type for `done` (`handoff-logged` gate)
- **`question`:** open until an `answer` entry names it via `answers:`

#### Worked log entries

**progress:**

```markdown
## 2026-09-10T22:40:00Z · progress · cursor

Implemented max-age filter in computeInbox; added API query param and CLI flag.
```

**decision:**

```markdown
## 2026-09-10T20:05:00Z · decision · human

**Status:** accepted
**Context:** Badge counted all historical rows.
**Decision:** Default window is 14 days; tier-1 live cards exempt from age filter.
**Consequences:** Nav badge uses same default as page.
```

**review:**

```markdown
## 2026-09-10T23:30:00Z · review · pi

verdict: approve · open: high=0 medium=0

Implementation matches plan. All acceptance criteria verified in tests.
```

**handoff rule:** `handoff-logged` passes when a `handoff` entry exists with timestamp later than the ticket's last entry into the `in_progress` stage or last `reopen`, whichever is later. A ticket with neither event (e.g. migrated legacy) passes on any `handoff` entry.

### 4.3 Role: notes

| Aspect | Rule |
|---|---|
| Kernel behaviour | Freeform agent-editable markdown |
| Constraints | Any number of files |
| Verbs | none (direct edit) |
| Without notes role | no notes files scaffolded |

### 4.4 Role: deliverable

| Aspect | Rule |
|---|---|
| Kernel behaviour | Must be non-empty before `done` when gate declared; shown first when `status` is `done` |
| Constraints | At most one file per template |
| Verbs | none (direct edit) |
| Gates reading it | `deliverable-present` |

### 4.5 Adding a role

A new role is added to the kernel only when the tool would behave differently for that file class. Purpose text for agents lives in manifest `description`, not in a separate protocol section.

*Left to ticket log-role-and-journal: journal merge, `syntaur log` implementation.*

## 5. Templates

### 5.1 Directory layout

```
~/.syntaur/templates/<id>/
  template.md         # required; §5.2 schema in YAML frontmatter; optional markdown body (human notes, tool ignores)
  ticket.md           # optional skeleton
  <file templates>    # optional scaffolds for declared files
```

The `template.md` shape matches `agents/*.md`, `playbooks/*.md`, and `config.md`: YAML frontmatter plus an optional markdown body the tool ignores.

- **init / upgrade:** copies built-ins; `upgrade` refreshes shipped files without overwriting `builtin:`-stamped edits (see validation rule 13).
- **Custom template:** copy a built-in directory and edit.
- **Commands:** `template list|new|check|reset`, `retemplate <id>` (adds missing files, never deletes; logs `retemplated` event).

*Left to ticket templates: full CLI and validation implementation.*

### 5.2 Manifest schema

All fields below live in the YAML frontmatter of `template.md`.

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `id` | string | yes | — | Template id (directory name) |
| `version` | integer | yes | — | Manifest schema version; always `1` in v2 |
| `builtin` | string | on shipped | — | `name@n`; marks built-in; not overwritten on upgrade |
| `description` | string | yes | — | For humans and `template list` |
| `whenToUse` | string | yes | — | Agent-facing guidance for picking template |
| `stages` | array | yes | — | Ordered subset of fixed stage ids |
| `stages[].id` | stage id | yes | — | Must be in fixed vocabulary |
| `stages[].label` | string | no | id | Display label |
| `stages[].instructions` | string | yes | — | Shown in `show` at this stage |
| `stages[].agent` | string | no | — | Agent id for hand-off default |
| `stages[].reviewer` | string | no | — | Reviewer agent id |
| `stages[].auto` | boolean | no | `true` for agent, `false` for reviewer | Auto-dispatch on stage entry |
| `files` | array | yes | — | Template-owned files (not kernel) |
| `files[].path` | string | yes | — | Relative path under ticket folder |
| `files[].role` | role or omitted | no | plain | Omitted = plain (no kernel behaviour) |
| `files[].writer` | enum | yes | — | `agent`, `cli`, or `human`; `log` forces `cli` |
| `files[].createOn` | enum | no | `ticket-creation` | `ticket-creation`, `<stage id>`, or `never` |
| `files[].description` | string | yes | — | Agent purpose; copied to `purpose:` in scaffold |
| `files[].entryTypes` | string[] | no | all seven | Subset for log role |
| `gates` | object | yes | `{}` | Map verb → list of gate ids |
| `playbooks` | string[] | no | `[]` | Playbook slugs; documentary only (content lives in `stages[].instructions`) |
| `workspace` | enum | no | `optional` | `required`, `optional`, or `none` |
| `defaultPriority` | enum | no | `medium` | Default on `syntaur new` |

### 5.3 Validation rules

1. `id` matches directory name.
2. `version` is `1`.
3. Every `stages[].id` is in the fixed vocabulary §3.5.
4. `stages` order matches global stage order (subset, no reordering violation).
5. If `ready` is in `stages`, a `plan` role file exists.
6. If `plan-approved` is declared, a `plan` role exists.
7. If `review-clean` is declared, `review` is in `stages`.
8. If `deliverable-present` is declared, a `deliverable` role exists.
9. If `handoff-logged` or any log-reading gate is declared, a `log` role exists.
10. At most one file per `plan`, `log`, `deliverable` role.
11. Every `files[].description` is non-empty.
12. `log` role files have `writer: cli`.
13. `builtin` manifests: `template check --builtins` reports drift; `template reset <id>` restores.
14. `createOn` values are `ticket-creation`, a declared stage id, or `never`.
15. Kernel paths (`ticket.md`, `chat/`) do not appear in `files[]`.
16. `dropped` does not appear in `stages[]`.

*Left to ticket templates: `template check` implements rules 1–16.*

### 5.4 Built-in manifests

#### feature

```yaml
id: feature
version: 1
builtin: feature@1
description: Full development cycle with plan approval, workspace, implementation, and review.
whenToUse: Default for feature work, refactors, and multi-step implementation with plan and review gates.
workspace: required
defaultPriority: medium
playbooks:                   # documentary; absorbed into stage instructions below
  - create-and-plan-assignment
  - plan-versioning
  - read-before-plan
  - workspace-before-code
  - keep-records-updated
stages:
  - id: backlog
    label: Backlog
    instructions: Ticket is queued. Run syntaur plan when ready to write the plan.
  - id: planning
    label: Planning
    instructions: |
      Read all project context before planning: project.md, ticket.md, upstream tickets' decision logs, and dependencies.
      Write plan.md with objective, tasks, and verify steps. Iterate until review-ready.
      Do not skip context files you think you already know.
  - id: ready
    label: Ready
    instructions: |
      Plan is approved. Set workspace fields (repository, branch, worktree, parentBranch) in ticket.md before any implementation code.
      Run syntaur start when the workspace is set and dependencies are done.
  - id: in_progress
    label: In Progress
    instructions: |
      Implement the approved plan task by task. Log progress after meaningful steps.
      Tick acceptance criteria in ticket.md as each is met. Commit in small logical units with clear messages.
      Never commit secrets. Run linter before commit if configured.
    agent: cursor
    auto: true
  - id: review
    label: Review
    instructions: |
      Verify every acceptance criterion with evidence. Run the test suite and build.
      Log a review entry with verdict and open issue counts. Fix high/medium findings before approve verdict.
    reviewer: pi
    auto: false
  - id: done
    label: Done
    instructions: Terminal. Deliverable and handoff requirements must be satisfied before syntaur done.
files:
  - path: plan.md
    role: plan
    writer: agent
    createOn: planning
    description: Implementation plan with tasks and verify steps; requires human approval before start.
  - path: journal.md
    role: log
    writer: cli
    createOn: ticket-creation
    description: Append-only log for progress, decisions, handoffs, questions, answers, and reviews.
    entryTypes: [progress, decision, handoff, note, question, answer, review]
gates:
  approve: [plan-exists]
  start: [plan-approved, deps-done, workspace-set]
  done: [criteria-checked, handoff-logged, review-clean]
```

#### bug

```yaml
id: bug
version: 1
builtin: bug@1
description: Bug fix flow with optional plan, required review, and workspace.
whenToUse: Defect fixes where plan is optional but review and workspace are required.
workspace: required
defaultPriority: high
stages:
  - id: backlog
    instructions: Triage the bug. Optionally run syntaur plan to capture a fix plan before start.
  - id: in_progress
    instructions: Fix the defect. Log progress. Tick acceptance criteria as verified.
    agent: cursor
    auto: true
  - id: review
    instructions: Verify fix and regression tests. Log review verdict.
    reviewer: pi
    auto: false
  - id: done
    instructions: Terminal.
files:
  - path: plan.md
    role: plan
    writer: agent
    createOn: never
    description: Optional fix plan; created only when syntaur plan is run.
  - path: journal.md
    role: log
    writer: cli
    createOn: ticket-creation
    description: Work log for the bug fix.
    entryTypes: [progress, decision, handoff, note, question, answer, review]
gates:
  start: [deps-done, workspace-set]
  done: [criteria-checked, handoff-logged, review-clean]
```

#### spike

```yaml
id: spike
version: 1
builtin: spike@1
description: Time-boxed research with findings deliverable; no plan or review stage.
whenToUse: Research, design exploration, or spikes with a written outcome.
workspace: none
defaultPriority: medium
stages:
  - id: backlog
    instructions: Define the spike question in the objective.
  - id: in_progress
    instructions: Investigate and write findings.md. Notes go in notes.md.
    agent: cursor
    auto: true
  - id: done
    instructions: findings.md must be non-empty before syntaur done.
files:
  - path: findings.md
    role: deliverable
    writer: agent
    createOn: in_progress
    description: Research findings and recommendation; this is the handoff artifact for spikes.
  - path: notes.md
    role: notes
    writer: agent
    createOn: ticket-creation
    description: Scratch notes during investigation.
gates:
  done: [deliverable-present]
```

#### quick

```yaml
id: quick
version: 1
builtin: quick@1
description: Two-stage card for small chores; no template files.
whenToUse: Small tasks that do not need plan, log, or review; replaces todo-store chores.
workspace: none
defaultPriority: low
stages:
  - id: backlog
    instructions: Do the work described in the objective, then syntaur done.
  - id: done
    instructions: Terminal.
files: []
gates:
  done: []
```

#### legacy

```yaml
id: legacy
version: 1
builtin: legacy@1
description: v1 assignment layout without file rewriting; maps old record files to roles.
whenToUse: Assigned by migrate v2 to all migrated tickets. Do not use for new tickets.
workspace: optional
defaultPriority: medium
stages:
  - id: backlog
    instructions: Migrated backlog/draft.
  - id: planning
    instructions: Migrated ready_for_planning.
  - id: ready
    instructions: Migrated ready_to_implement.
  - id: in_progress
    instructions: Implementation per approved plan.
  - id: review
    instructions: Review when applicable.
  - id: done
    instructions: Completed.
files:
  - path: progress.md
    role: log
    writer: cli
    createOn: ticket-creation
    description: v1 progress log; append via syntaur log; migrator preserves content.
    entryTypes: [progress, decision, handoff, note, question, answer, review]
  - path: plan.md
    role: plan
    writer: agent
    createOn: ticket-creation
    description: v1 plan file; approval digest in ticket.md plan block.
  - path: scratchpad.md
    role: notes
    writer: agent
    createOn: ticket-creation
    description: v1 scratchpad.
  - path: decision-record.md
    writer: human
    createOn: ticket-creation
    description: v1 decision record; historical read-only after migration.
  - path: handoff.md
    writer: agent
    createOn: ticket-creation
    description: v1 handoff; historical read-only after migration.
  - path: comments.md
    writer: human
    createOn: ticket-creation
    description: v1 comments; historical read-only after migration.
gates:
  approve: [plan-exists]
  start: [deps-done]
  done: [criteria-checked, handoff-logged]
```

**Dropped frontmatter on migrate** (listed for legacy migrator): see §3.3 dropped list; includes `facts`, `attestations`, `statusHistory`, `planApproval` (moved to `plan` block).

**Type mapping for new tickets only:** `feature`/`refactor` → `feature`; `bug` → `bug`; `research`/`spike`/`design` → `spike`; `chore` → `quick`. Migrated tickets are all `template: legacy`.

*Left to ticket playbooks-into-stages: refine stage instruction wording from playbooks.*

### 5.5 Lifecycle of a template

| Action | Behaviour |
|---|---|
| Copy | `template new <id> --from <builtin>` copies directory |
| Edit | Human edits `template.md` and skeletons |
| check | `template check <id>` runs §5.3 rules |
| reset | `template reset <id>` restores built-in from `builtin:` stamp |
| retemplate | On ticket: add missing files from current manifest; log `retemplated`; never delete files |

## 6. Verbs, gates, dispatch, events, and the CLI surface

### 6.1 Verbs and gates

**Stage order:** `backlog < planning < ready < in_progress < review < done` (`dropped` is aside).

**General rule.** A moving verb moves a ticket from the template stage immediately preceding its target in the template's ordered subset to the target. A ticket in any other stage fails with:

`Cannot <verb> <ID>: ticket is in <stage>, <verb> applies from <previous>.`

When the target stage is absent: `start`, `review`, `done` fail with `template <id> has no <stage> stage`. On a template without `planning`/`ready`, `plan` and `approve` apply from any active stage (file actions only, no stage move); `approve` implies `plan-exists`.

**`--force`:** skips gates; recorded on `moved` event as `forced: true`.

#### Gate table

| Gate id | Reads | Passes when | Hint (Next line) |
|---|---|---|---|
| `plan-exists` | plan role file | File exists and is non-empty beyond scaffold | Run syntaur plan create |
| `plan-approved` | plan role + `plan.approvedDigest` | SHA-256 digest of current plan file equals `plan.approvedDigest` | Run syntaur approve |
| `deps-done` | `depends_on` + ticket statuses | Every depended ticket is `done` | Wait for dependencies |
| `workspace-set` | `workspace` frontmatter | All four workspace fields non-empty when template `workspace: required` | Set workspace in ticket.md |
| `criteria-checked` | Acceptance Criteria checkboxes | Every box checked | Tick acceptance criteria |
| `handoff-logged` | log role | `handoff` entry later than the last entry into the `in_progress` stage or the last `reopen`, whichever is later (or any `handoff` if neither) | syntaur log -t handoff |
| `review-clean` | log role | Latest `review` entry (by timestamp) is later than the last entry into the `review` stage or the last `reopen`, whichever is later, and is `approve` with `high=0` | Log approving review |
| `deliverable-present` | deliverable role | File non-empty beyond scaffold | Write deliverable |

**Error shape:** `Cannot <verb> <ID>: <gate> — <reason>. Next: <hint>` (exit 1).

#### Verb table

| Verb | From (by template) | To | Gates (built-in) | Side effects | Event |
|---|---|---|---|---|---|
| `plan` | stage before `planning`, or any active if no planning | `planning` | — | create/scaffold plan file | `moved` |
| `approve` | stage before `ready`, or any active if no `planning`/`ready` | `ready` or file-only | feature/legacy: `plan-exists` (implies `plan-exists`) | set `plan.approved*` | `plan-approved`, `moved` if stage moves |
| `start` | stage before `in_progress` | `in_progress` | feature: `plan-approved`, `deps-done`, `workspace-set`; bug: `deps-done`, `workspace-set`; legacy: `deps-done` | dispatch if `auto` | `moved`, `dispatched` |
| `review` | stage before `review` | `review` | — | dispatch reviewer if configured | `moved`, `dispatched` |
| `done` | stage before `done` | `done` | per template `gates.done` | — | `moved` |
| `drop` | any active | `dropped` | reason required | — | `moved` |
| `reopen` | `done` or `dropped` | stage before `done` in subset | — | keeps `plan.approvedDigest` | `moved` |
| `block` | any | — (flag) | reason required | `blocked: reason` | `flagged` |
| `unblock` | any | — | — | `blocked: null` | `unflagged` |
| `park` | any | — (flag) | reason required | `parked: reason` | `flagged` |
| `unpark` | any | — | — | `parked: null` | `unflagged` |

`plan version`: creates `plan-v<N>.md`, sets `plan.file`, clears approval, logs `plan-versioned`; moves to `planning` when the template declares a `planning` stage, otherwise a file action with no stage move.

`syntaur new`: writes first stage of template subset; allocates id.

**Plan versioning** (unchanged behaviour from `src/commands/plan.ts`): unchecked plan tasks carry forward on version.

*Left to ticket lifecycle-verbs: implement verbs and gate evaluation.*

### 6.2 Dispatch

On stage entry when `stages[].agent` is set and `auto: true` (default for agent): the broker opens **one turn** to that agent. First message = `show` text + stage `instructions`. Turn is recorded in chat.

`stages[].reviewer` defaults `auto: false` → dashboard **Hand-to** button.

`syntaur start --agent <id>` and dashboard picker override the default agent for one dispatch.

Any participant may be addressed at any stage from chat. Gates check artifacts, not authors.

*Left to ticket stage-agents: resume/follow-up driver loop semantics.*

### 6.3 Events and the database key

| Event type | Payload fields |
|---|---|
| `created` | — |
| `moved` | `from`, `to`, `verb`, `by`, `forced` |
| `flagged` | `flag`, `reason` |
| `unflagged` | `flag` |
| `plan-approved` | `file`, `digest` |
| `plan-versioned` | `file` |
| `logged` | `type` |
| `dispatched` | `agent`, `stage` |
| `retemplated` | `from`, `to` |

`source_key` idempotency is kept from `src/db/events-db.ts:19,134-141`.

**Database key rule.** Operational tables reference tickets by `id` string (`SYN-142`) only:

| Table / column | v2 key |
|---|---|
| `events.assignment_id` | ticket `id` |
| `engagement.assignment_id` | ticket `id` |
| `chat_sessions.assignment_id` | ticket `id` |
| `chat_sessions.session_key` | `<ID>~<harness>` (no colon) |
| `chat_items.session_key` | follows `chat_sessions.session_key` |
| `chat_items.assignment_id` | ticket `id` |
| `usage_events.ticket_id` | replaces `assignment_slug`; empty string for project-level rows (~79% today) |
| `usage_daily.ticket_id` | replaces `assignment_slug`; empty for unattributed (~48% today) |

**Dropped columns:** `project_slug` on `events`; `project_slug` and `assignment_slug` on `engagement` and `chat_sessions`. `project_slug` is retained only on `usage_events` and `usage_daily`.

`artifacts` table is removed before migration (`delete-ops-subsystems` precedes `ticket-rename-and-ids`).

Migrator prints UUID→id and `(project_slug, assignment_slug)`→id maps in dry-run transcript; re-keys snooze keys to id form (`<ID>` or `<ID>~<compact-ts>`).

*Left to ticket derived-state-to-db: events schema and history command.*

### 6.4 CLI surface

| Verb | Contract | Owning ticket |
|---|---|---|
| `init` | Home layout, `git init`, copy built-ins | derived-state-to-db, templates |
| `upgrade` / `update` | Refresh built-ins without overwriting edits | templates |
| `statusline (install/configure/uninstall)` | Shell statusline | skills-and-install |
| `project (new/list)` | `new` derives prefix, checks uniqueness, sets defaultTemplate | ticket-rename-and-ids |
| `new` | Requires project (except lazy `scratch`) | templates |
| `show` | Render ticket summary | templates |
| `ls` | List tickets | ticket-rename-and-ids |
| `worktree (create/remove/gc)` | Git worktrees | ticket-rename-and-ids |
| `session (register/touch/resume)` | Session tracking | ticket-rename-and-ids |
| `inbox` | Needs me queue | ticket-rename-and-ids |
| `usage` | Cost rollup | ticket-rename-and-ids |
| `search` | Id-based search | ticket-rename-and-ids |
| `history` | `history <id>` prints the git log of the ticket folder (the home is a git repository from `init`); `history <id> --events` prints the events-table rows for the ticket | derived-state-to-db |
| `dashboard` | Start SPA | dashboard-six-pages |
| `doctor` | Hygiene checks | test-root-hygiene, ticket-rename-and-ids |
| `plan (create/version)` | Plan file lifecycle | lifecycle-verbs |
| `approve`, `start`, `review`, `done`, `drop`, `reopen` | Lifecycle | lifecycle-verbs |
| `block`, `unblock`, `park`, `unpark` | Flags | lifecycle-verbs |
| `log` | Append log-role entry | log-role-and-journal |
| `retemplate` | Add manifest files to ticket | templates |
| `template (list/new/check/reset)` | Template management | templates |
| `rename` | Slug and folder rename | ticket-rename-and-ids |
| `migrate (v2/journal)` | v2 migration; optional journal merge | ticket-rename-and-ids, log-role-and-journal |

Agent definitions and playbooks: dashboard Library only (no CLI). Removed: six `*-playbook` verbs and `regen-playbook-manifest` (`playbooks-into-stages`). Anything not listed does not exist in v2.

## 7. syntaur show

### 7.1 Text grammar

**File states** (rendered in the Files block):

| Role | State values |
|---|---|
| kernel `ticket.md` | `editable` |
| `plan` | `missing`, `unapproved`, `approved`, `stale` (`stale` = edited after approval; digest differs) |
| `log` | `<n> entries · last <type> <age>` |
| `deliverable` | `empty`, `present` |
| `notes`, plain | `editable` |

```
<ID> · <title> · <template> · <status>[ · blocked: <reason>][ · parked: <reason>]
Objective: <first paragraph>
Acceptance: <n> of <m> checked
Workspace: <repository> · <branch> · <worktree>
  — or — Workspace: none (template does not require one)
Depends: <ID> <status>[, ...]  — or — Depends: none
Links: <id or url>[, ...]     — omitted when links empty
Files:
  ticket.md  kernel · <state>
    <objective one-liner>
  <path>  <role|plain> · <state>
    <description>
Handoff: <first line of the latest handoff entry>  — or — Handoff: none
Log: last <n> entries
  <tail lines>
Stage: <id>. <instructions>
Next: <hint>
Commands: syntaur log <ID> -t <type> "..."; syntaur block <ID> "<reason>"; ask via question log or @mention in chat
```

**Next line:** first unmet gate of the next verb in stage order, or the verb name when all gates pass.

**`show --log [-t <type>]`:** prints log entries only (no header).

**`--json`:** `{ ticket, workspace, depends[], links[], files[], handoff, log[], stage, next, commands[] }` with the same content.

### 7.2 Worked example: SYN-142 (feature, in_progress)

```
SYN-142 · Needs me: age out the backlog with a max-age filter and snooze · feature · in_progress
Objective: Keep the Needs me queue from being dominated by reviews and plan approvals on parked projects.
Acceptance: 5 of 5 checked
Workspace: /Users/brennen/syntaur · feat/needs-me-backlog-aging · /Users/brennen/syntaur/.worktrees/feat/needs-me-backlog-aging
Depends: SYN-138 done
Files:
  ticket.md  kernel · editable
    Age filter and snooze for Needs me queue
  plan.md  plan · approved
    Implementation plan with tasks and verify steps; requires human approval before start.
  journal.md  log · 8 entries · last progress 2h
    Append-only log for progress, decisions, handoffs, questions, answers, and reviews.
Handoff: none
Log: last 3 entries
  ## 2026-09-10T22:40:00Z · progress · cursor — Implemented max-age filter in computeInbox
  ## 2026-09-10T20:05:00Z · decision · human — Default window is 14 days
  ## 2026-09-10T12:15:00Z · progress · cursor — Started implementation
Stage: in_progress. Implement the approved plan task by task. Log progress after meaningful steps. Tick acceptance criteria in ticket.md as each is met. Commit in small logical units with clear messages. Never commit secrets. Run linter before commit if configured.
Next: syntaur review SYN-142
Commands: syntaur log SYN-142 -t progress "..."; syntaur block SYN-142 "reason"; ask via question log or @mention in chat
```

### 7.3 Worked example: SCR-7 (quick, backlog)

```
SCR-7 · Update README install section · quick · backlog
Objective: Add skills.sh install path to README.
Acceptance: 0 of 1 checked
Workspace: none (template does not require one)
Depends: none
Files:
  ticket.md  kernel · editable
    README install update
Handoff: none
Log: last 0 entries
Stage: backlog. Do the work described in the objective, then syntaur done.
Next: syntaur done SCR-7
Commands: syntaur log SCR-7 -t note "..."; syntaur block SCR-7 "reason"; ask via question log or @mention in chat
```

### 7.4 Broker and dashboard use

- **Broker:** standing context = full `show` text; set once per adapter session; refresh on stage change (`src/chat/broker.ts:19-20`).
- **Dashboard:** ticket header consumes `show --json` fields for ticket summary, files, stage, and Next; cost and session count come from the usage and engagement APIs, not from `show --json`.

*Left to ticket templates: show renderer and JSON emitter.*

## 8. Needs me and the board

### 8.1 Needs me tiers (v2)

| Tier | Source | Notes |
|---|---|---|
| 0 | Unsettled permission/ask cards | Chat-sourced; unchanged |
| 1 | Chat replies owed | Chat-sourced; unchanged |
| 2 | Open `question` log entries | No `answer` names the question |
| 3 | Unapproved plan-role file | Plan-role file present and `plan.approvedDigest` unset or not equal to the current file digest, on any ticket not `done` or `dropped` |
| 4 | `status: review` | Review queue |

Settled cards leave the queue. Snooze and window behaviour unchanged. Row keys: `<ID>` (ticket-level), `<ID>~<compact-ts>` (log rows, e.g. `SYN-142~20260911T052000Z`), or chat item id — **no colons**.

*Left to ticket dashboard-six-pages: board UI and tier wiring.*

### 8.2 Board

Columns = union of stage ids in global order. Filter by template and status. `done` and `dropped` older than N days hidden by default (archive as filter, not a page). `blocked` and `parked` show badges without changing column.

## 9. Agent surface

### 9.1 Skills (six)

| Skill | One-line contract |
|---|---|
| `syntaur-protocol` | Run `syntaur show` and follow Next |
| `grab` | Claim ticket and set workspace |
| `plan` | Create or version plan via CLI |
| `done` | Complete ticket through gates |
| `log` | Append typed log entries |
| `worktree` | Create/bind worktree |

Install path: `npx skills add` only (`skills-and-install`). ACP chat participants need no skills; broker files records.

### 9.2 Hooks

Kept: SessionStart register, session touch. Dropped: SessionEnd (`session-cleanup.sh`, the recompute trigger), PreCompact, ExitPlanMode prompt hooks, unwired `enforce-boundaries.sh` (`platforms/claude-code/hooks/hooks.json`).

UserPromptSubmit may inject stage instructions reference; playbooks become stage instructions in manifests (`playbooks-into-stages`).

### 9.3 Playbooks vs stage instructions

Playbooks remain in `~/.syntaur/playbooks/` for Library editing. Built-in templates embed condensed playbook content in `stages[].instructions`. The manifest `playbooks` field is documentary.

*Left to ticket skills-and-install: hook wiring and skill pack.*

## 10. Migration v1→v2

### 10.1 Steps (ordered)

1. **Backup** the Syntaur home directory and `syntaur.db`.
2. **Assign prefixes** and ids into `project.md` and ticket frontmatter.
3. **Rename** `assignments/` → `tickets/`, `assignment.md` → `ticket.md`, folders to `<ID>-<slug>/`.
4. **Move standalone** three assignments into `projects/scratch/tickets/`.
5. **Set** `template: legacy` on all migrated tickets.
6. **Map statuses:** `draft→backlog`, `ready_for_planning→planning`, `ready_to_implement→ready`, `in_progress`, `review`, `completed→done`, `failed→dropped`.
7. **Archived rule:** `archived: true` + terminal → `done`/`dropped` as today; `archived: true` + non-terminal (10 tickets) → `dropped` with reason `archived`.
8. **Drop** engine frontmatter fields (§3.3 list).
9. **Re-key** database rows and `inbox-snoozes.json` keys to id form.
10. **Leave** `proof/` and `sessions/` on disk unread.
11. **Verify** applied home against dry-run transcript (not fixed counts).

Optional later: `migrate journal` merges v1 record files into single journal (not prerequisite).

### 10.2 Dry-run transcript (contract)

```
project <slug>: prefix <PFX>, <n> tickets
<old-folder> → <new-folder> · <ID> · <old-status>→<new-status> · template legacy
...
UUID → id map (lines)
(project_slug, assignment_slug) → id map (lines)
re-keyed events.assignment_id: <n>  (project_slug dropped)
re-keyed engagement.assignment_id: <n>  (project_slug, assignment_slug dropped)
re-keyed chat_sessions.assignment_id: <n>  (project_slug, assignment_slug dropped)
re-keyed chat_sessions.session_key: <n>
re-keyed chat_items.session_key: <n>
re-keyed chat_items.assignment_id: <n>
re-keyed usage_events.ticket_id: <n>  (assignment_slug dropped; project_slug kept)
re-keyed usage_daily.ticket_id: <n>  (assignment_slug dropped; project_slug kept)
dropped fields: <count>
totals: <projects> projects, <tickets> tickets
```

`migrate v2 --apply` prints the same transcript; `release-1-0` verifies against it.

### 10.3 Rollback

Restore backup directory and database copy; do not partial-apply.

Counts in the audit (324 assignments, etc.) drift daily; verification compares to the dry-run transcript, not audit numbers.

*Left to ticket ticket-rename-and-ids: migrator implementation.*

## 11. Delete and keep

### 11.1 Delete list

| Subsystem | Approx LOC | Evidence | Owning ticket |
|---|---|---|---|
| Workflow, status, facts, derive ladder, stage engine, editor, 5 migrations | 6,300 + 7,300 + 1,700 | 1 workflow, 0 custom facts, triple-logged transitions | lifecycle-verbs |
| Todos (three implementations), bundles, linked todos | 3,400 + 3,700 | 12 items, dead since June | delete-todos-and-bundles |
| Saved views, query language, overview widgets | 240 + 5,900 | 3 default views | delete-views-and-workspaces |
| Leases and inventories | 1,100 + 300 | 0 rows | delete-ops-subsystems |
| Schedules | 2,400 + 400 | 0 created | delete-ops-subsystems |
| Servers and autodiscovery | 900 + 400 | auto-captured files unread | delete-ops-subsystems |
| Memories and resources | 800 + 900 | 14 documents total | delete-ops-subsystems |
| Proof, capture, artifacts | 1,000 | 6 tickets | delete-ops-subsystems |
| Session summaries and PreCompact hook | 300 | 19 tickets; hook fails outside REPL | delete-ops-subsystems |
| TUI (`browse`) | 300 | 4 launches | delete-ops-subsystems |
| Platform adapters, three install paths, `targets/` | 3,900 | one user, one install path | skills-and-install |
| Workspaces, `/w/` routes | 500 + 700 | one workspace | delete-views-and-workspaces |
| Backup subsystem | 400 | never configured | delete-ops-subsystems |
| Derived indexes, `_status.md`, `resources/_index.md`, `memories/_index.md` | per `docs/protocol/file-formats.md` §10–12 and §14–16 | replaced by DB | derived-state-to-db |
| Scratchpad, comments, decision-record, handoff as separate files (v1) | folded | see journal role | log-role-and-journal |

### 11.2 Keep list

| Subsystem | Reason | Port ticket |
|---|---|---|
| `src/chat/` | ACP broker, Needs me integration | dashboard-six-pages |
| `src/inbox/` + inbox SPA | Needs me queue | dashboard-six-pages |
| Sessions and engagement | Usage of 2,678 sessions | dashboard-six-pages |
| Usage tracking | $16.6k tracked | dashboard-six-pages |
| Search | Small, used | ticket-rename-and-ids |
| Staleness | Inbox tiers | dashboard-six-pages |
| Playbooks + agents editor | Library page | dashboard-six-pages |
| Statusline | Wired in Claude settings | skills-and-install |
| Parser, scanner, watcher | Markdown-as-database | templates |
| WebSocket manager | Dashboard live updates | dashboard-six-pages |
| Markdown editor | Ticket detail | dashboard-six-pages |
| Kanban/table board | Board page | dashboard-six-pages |
| Worktree utilities | Agent workflows | skills-and-install |
| Ticket detail + chat tab | Core UI | dashboard-six-pages |

## 12. Non-goals and open questions

### 12.1 Non-goals (v2)

| Non-goal | |
|---|---|
| Multi-user | |
| Project-level or inherited templates | |
| Template marketplace | |
| Non-markdown ticket storage | |
| Schedules | |
| Leases | |
| Custom stages | |

### 12.2 Open questions

*(none)*
