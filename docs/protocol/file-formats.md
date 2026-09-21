# Syntaur File Format Reference

This document defines the complete schema for every file type in the Syntaur protocol. For each file, the YAML frontmatter schema, body sections, ownership, and a realistic example are provided.

**Conventions used in this document:**

- **Required** fields must be present for a valid file. **Optional** fields may be omitted.
- All timestamps use **RFC 3339 / ISO 8601 with UTC offset** (e.g., `2026-03-18T14:30:00Z`).
- Local filesystem path fields (`workspace.worktree`, `defaultProjectDir`) use absolute expanded form. Never store `~` literally. `workspace.repository` is exempt — it may be a local path or a remote URL.
- Intra-project markdown links use relative paths for portability (e.g., `./project.md`).
- **Derived** project markdown indexes are removed in v2; rollups are computed at read time.
- **Agent-writable** files are written only by the assigned agent.
- **Human-authored** files are written only by humans.
- **Shared-writable** files can be created by both humans and agents.

---

## 1. project.md

**Ownership:** Human-authored only

The project overview containing the goal, context, and success criteria. This file contains **no computed or derived content**. Status rollups, ticket listings, and dependency graphs are computed at read time by the CLI and dashboard.

**Archived projects:** The only lifecycle state stored in `project.md` is the `archived` flag. When a human sets `archived: true`, rollup logic treats the project as `archived`, overriding any computed status from ticket stages.

### Frontmatter Schema

| Field | Type | Valid Values | Required | Default | Description |
|-------|------|-------------|----------|---------|-------------|
| `id` | string (UUID) | UUID v4 | required | — | Unique identifier for the project. |
| `slug` | string | lowercase, hyphen-separated | required | — | Human-readable identifier. Matches the folder name. Explicit in frontmatter so it's available without path inference. |
| `title` | string | any | required | — | Display title for the project. |
| `archived` | boolean | `true`, `false` | optional | `false` | Human-authored lifecycle override. When true, project rollup reports `archived`. |
| `archivedAt` | string (RFC 3339) or null | RFC 3339 datetime | optional | `null` | Timestamp when the project was archived. |
| `archivedReason` | string or null | any | optional | `null` | Human explanation for why the project was archived. |
| `created` | string (RFC 3339) | RFC 3339 datetime | required | — | When the project was created. |
| `updated` | string (RFC 3339) | RFC 3339 datetime | required | — | When the project was last modified. |
| `prefix` | string | 2–5 uppercase letters | required | — | Ticket id prefix for this project (e.g. `FIT`, `SCR`). Combined with a counter to form ticket ids. |
| `nextTicket` | number (integer) | >= 1 | required | `1` | Next ticket counter value. Ids are `<prefix>-<n>`; incremented on each `syntaur new`; never reused. |
| `defaultTemplate` | string | any | optional | `feature` | Default ticket type/template for `syntaur new` in this project. |
| `externalIds` | array of objects | `{system, id, url}` | optional | `[]` | Links to external tracking systems. Generic format — new integrations don't require protocol changes. |
| `externalIds[].system` | string | any (e.g., `jira`, `linear`, `github`) | required (per entry) | — | Name of the external system. |
| `externalIds[].id` | string | any | required (per entry) | — | Identifier in the external system. |
| `externalIds[].url` | string or null | URL | optional (per entry) | `null` | Direct link to the item in the external system. |
| `tags` | array of strings | any | optional | `[]` | Freeform tags for categorization. |

### Body Sections

| Section | Purpose | Who Writes |
|---------|---------|------------|
| Overview | Free-form description of the project goal, context, and success criteria | Human |
| Notes | Optional human notes, updates, or context that don't fit elsewhere | Human |

### Example

```markdown
---
id: 7a1b3c4d-5e6f-7890-abcd-ef1234567890
slug: build-auth-system
title: Build Authentication System
prefix: BAS
nextTicket: 4
defaultTemplate: feature
archived: false
archivedAt: null
archivedReason: null
created: "2026-03-15T09:00:00Z"
updated: "2026-03-18T14:00:00Z"
externalIds:
  - system: jira
    id: AUTH-42
    url: https://mycompany.atlassian.net/browse/AUTH-42
  - system: linear
    id: AUTH-123
    url: https://linear.app/mycompany/issue/AUTH-123
tags:
  - security
  - backend
---

# Build Authentication System

## Overview

Build a complete JWT-based authentication system for the backend API. This includes
schema design, middleware implementation, and comprehensive test coverage.

Success looks like: all API endpoints are protected by JWT auth, tokens are signed
with RS256, refresh token rotation is implemented, and test coverage exceeds 90%.

## Notes

2026-03-16: Product confirmed we need both access and refresh tokens. Access token
TTL is 15 minutes, refresh token TTL is 7 days.
```

---

## 2. ticket.md

**Ownership:** Agent-writable

The core unit of work and the **single source of truth** for ticket state. This is the file an agent reads to understand what to do and updates to report progress. All index files and status rollups are projections of data in this file.

### Frontmatter Schema

The kernel defines exactly **17 fields**:

| Field | Type | Valid Values | Required | Default | Description |
|-------|------|-------------|----------|---------|-------------|
| `id` | string | `<PREFIX>-<n>` | required | — | Unique ticket identifier (e.g. `BAS-2`). Allocated from the project's `prefix` and `nextTicket` counter. |
| `slug` | string | lowercase, hyphen-separated | required | — | Human-readable identifier. Forms the suffix of the folder name (`<ID>-<slug>`). Rename with `syntaur rename`. |
| `title` | string | any | required | — | Display title for the ticket. |
| `project` | string | project slug | required | — | The containing project's slug (e.g. `build-auth-system` or `scratch`). |
| `template` | string | installed template id | required | — | Ticket template (e.g. `feature`, `bug`, `legacy`). |
| `status` | stage id | `backlog`, `planning`, `ready`, `in_progress`, `review`, `done`, `dropped` | required | first template stage | Current stage. See [spec.md](./spec.md) §3.5. |
| `priority` | string (enum) | `low`, `medium`, `high`, `critical` | required | template default | Priority level. |
| `blocked` | string or null | any | required | `null` | Reason when blocked (flag, not a stage). Set by `syntaur block`. |
| `parked` | string or null | any | required | `null` | Reason when parked (flag). Set by `syntaur park`. |
| `depends_on` | array of strings | ticket ids | required | `[]` | Ticket ids (`<PREFIX>-<n>`) this depends on. |
| `assignee` | string or null | agent name or null | required | `null` | The agent currently responsible for this ticket. |
| `tags` | array of strings | any | required | `[]` | Freeform tags. |
| `links` | array of strings | ticket ids or URLs | required | `[]` | Related references (non-blocking). |
| `workspace` | object or null | see sub-fields | required | `null` | Code workspace information. |
| `workspace.repository` | string or null | repo path or URL | optional | `null` | The repository this ticket works in. |
| `workspace.worktree` | string or null | absolute path | optional | `null` | Absolute path to the git worktree. |
| `workspace.branch` | string or null | branch name | optional | `null` | The git branch for this ticket's work. |
| `workspace.parentBranch` | string or null | branch name | optional | `null` | The branch this was created from. |
| `plan` | object | see sub-fields | required | empty | Plan-role approval state. |
| `plan.file` | string or null | filename | optional | `null` | Active plan file (e.g. `plan.md`, `plan-v2.md`). |
| `plan.approvedDigest` | string or null | content hash | optional | `null` | SHA-256 digest of the approved plan revision. |
| `plan.approvedAt` | string (RFC 3339) or null | RFC 3339 datetime | optional | `null` | When the plan was approved. |
| `plan.approvedBy` | string or null | agent name or `"human"` | optional | `null` | Who approved the plan. |
| `created` | string (RFC 3339) | RFC 3339 datetime | required | — | When the ticket was created. |
| `updated` | string (RFC 3339) | RFC 3339 datetime | required | — | When the ticket was last modified. |

### Dependency Semantics

- **Pre-`in_progress` stage with unmet `depends_on`:** The ticket is waiting for dependencies to reach `done`. The `deps-done` gate on `start` enforces this.
- **`blocked` flag:** A manual or runtime obstacle unrelated to dependencies. Set with `syntaur block <id> "<reason>"` and cleared with `syntaur unblock`.
- **`parked` flag:** Work is intentionally paused without dropping the ticket. Set with `syntaur park <id> "<reason>"` and cleared with `syntaur unpark`.

### Body Sections

| Section | Purpose | Who Writes |
|---------|---------|------------|
| Objective | Clear description of what needs to be done and why | Human (initial), agent may refine |
| Acceptance Criteria | Checklist of requirements for completion | Human (initial), agent checks off |
| Context | Links to relevant docs, code, or other tickets | Human or agent |

Cross-ticket references live in frontmatter (`depends_on`, `links`) — not in a body section.

**Q&A and progress live in the log role:** Modern templates declare `journal.md` with role `log`. Append typed entries via `syntaur log -t <type>` (questions, answers, progress, decisions, handoffs, notes, reviews). See [§4](#4-journalmd--log-role). Legacy templates keep separate files until `syntaur migrate journal` merges them — see [§10](#10-legacy-files-pre-20-merged-by-migrate-journal).

**Sessions:** Agent sessions are tracked in a SQLite database (`~/.syntaur/syntaur.db`), not in the ticket file. The `assignee` field in frontmatter is the authoritative owner. See [§9](#9-sqlite-syntaurdb).

### Example

```markdown
---
id: BAS-2
slug: implement-jwt-middleware
title: Implement JWT Authentication Middleware
project: build-auth-system
template: feature
status: in_progress
priority: high
blocked: null
parked: null
depends_on:
  - BAS-1
assignee: claude-1
tags:
  - security
  - middleware
links: []
workspace:
  repository: /Users/brennen/projects/myapp
  branch: feat/jwt-middleware
  worktree: /Users/brennen/projects/myapp-jwt-middleware
  parentBranch: main
plan:
  file: plan.md
  approvedDigest: bab1dba6528048e055493836349a0dd9da576ede52977c4505f09538d11c2d62
  approvedAt: "2026-03-17T16:00:00Z"
  approvedBy: human
created: "2026-03-16T10:00:00Z"
updated: "2026-03-18T14:30:00Z"
---

# Implement JWT Authentication Middleware

## Objective

Implement Express middleware that validates JWT tokens on protected routes. Tokens
are signed with RS256 using the key pair defined in the auth schema. Must support
both access tokens (15min TTL) and refresh token rotation (7-day TTL).

## Acceptance Criteria

- [x] Middleware extracts Bearer token from Authorization header
- [x] RS256 signature validation implemented
- [ ] Token expiry checking with appropriate error responses
- [ ] Refresh token rotation endpoint
- [ ] Rate limiting on token refresh

## Context

- Depends on ticket `BAS-1` for the user table schema and key storage approach
- See project docs for product specs
- JWT library: `jose` (chosen in Decision 1)
```

---

## 3. plan.md and plan-vN.md

**Ownership:** Agent-writable

> **Note:** This section describes the v1 sidecar layout preserved by the `legacy` template. Modern templates (e.g. `feature`) declare plan files in `template.md` with the same role semantics; use `syntaur show` for the authoritative file list on a given ticket.

Zero or more implementation plan files per ticket. Plans are **not scaffolded** — they are created on demand by `/plan`.

**Filename versioning:** The first plan for a ticket is `plan.md`. Subsequent plans use `plan-v2.md`, `plan-v3.md`, etc. — the smallest unused `plan-v<N>.md` where `N >= 2`. When requirements shift, create a new versioned plan file instead of rewriting the old one.

Each plan has its own status independent of the ticket status.

### Frontmatter Schema

| Field | Type | Valid Values | Required | Default | Description |
|-------|------|-------------|----------|---------|-------------|
| `ticket` | string | ticket slug | required | — | The parent ticket this plan belongs to. |
| `status` | string (enum) | `draft`, `approved`, `in_progress`, `completed` | required | — | Plan lifecycle state. Independent of ticket status. |
| `created` | string (RFC 3339) | RFC 3339 datetime | required | — | When the plan was created. |
| `updated` | string (RFC 3339) | RFC 3339 datetime | required | — | When the plan was last modified. |

### Body Sections

| Section | Purpose | Who Writes |
|---------|---------|------------|
| Approach | High-level description of how the agent plans to accomplish the objective | Agent |
| Tasks | Checklist of implementation steps | Agent |
| Risks & Mitigations | Table of identified risks and planned mitigations | Agent |

### Example

```markdown
---
ticket: implement-jwt-middleware
status: in_progress
created: "2026-03-17T16:00:00Z"
updated: "2026-03-18T14:30:00Z"
---

# Plan: Implement JWT Authentication Middleware

## Approach

Use the `jose` library for JWT operations. Implement as Express middleware that
runs before route handlers. Start with token validation, then add refresh rotation.
Follow the schema from design-auth-schema for key storage.

## Tasks

- [x] Set up worktree and branch
- [x] Install jose library and configure RS256 keys
- [x] Implement Bearer token extraction middleware
- [x] Implement RS256 signature validation
- [ ] Add token expiry checking with 401 responses
- [ ] Implement refresh token rotation endpoint
- [ ] Add rate limiting to refresh endpoint
- [ ] Write integration tests

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Key rotation complexity | Start with single key pair, add rotation support as a follow-up |
| Refresh token theft | Store hashed tokens in DB, implement token family tracking |
| Performance impact of DB lookups on refresh | Add connection pooling (see memory: postgres-connection-pooling) |
```

---

## 4. journal.md — log role

**Ownership:** CLI-mediated append-only (`writer: cli` in the template manifest)

The unified log file for modern templates (`feature`, `bug`, `spike`, etc.). One file holds every typed record that used to be spread across `progress.md`, `decision-record.md`, `handoff.md`, and `comments.md` on the `legacy` template. All writes go through `syntaur log` or the dashboard **Journal** tab — never by editing the file directly.

### Frontmatter Schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `purpose` | string | required | — | Copied from the template manifest `description` at scaffold time. |

No `entryCount` or `updated` fields — readers sort entries by timestamp in the body.

### Entry grammar

```markdown
## <ISO-8601Z> · <type> · <author>
<optional key lines>
<markdown body>
```

**Types (exactly seven):** `progress`, `decision`, `handoff`, `note`, `question`, `answer`, `review`

**Optional key lines** (directly under the heading):

| Key line | When required | Format |
|----------|---------------|--------|
| `verdict: … · open: …` | `review` | `verdict: approve\|changes · open: high=<n> medium=<n>` |
| `answers: <ISO>` | `answer` | Timestamp of the `question` entry being answered |
| `attachments: <path>[, <path>]` | optional | Paths under `chat/attachments/` |

New files are **oldest-first** (append at end). Legacy `progress.md` on the `legacy` template remains newest-first until migrated.

### Worked entries

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

**question / answer:**

```markdown
## 2026-09-11T09:00:00Z · question · cursor

Should snoozed rows appear in the CLI default view?

## 2026-09-11T10:15:00Z · answer · human
answers: 2026-09-11T09:00:00Z

No — hidden unless --show-snoozed; document in cli.md.
```

**review:**

```markdown
## 2026-09-10T23:30:00Z · review · pi

verdict: approve · open: high=0 medium=0

Implementation matches plan. All acceptance criteria verified in tests.
```

**handoff:**

```markdown
## 2026-09-12T16:00:00Z · handoff · cursor

Shipped age filter + snooze parity. Remaining: dashboard badge polish (follow-up ticket).
```

### Open questions

A `question` entry is open until an `answer` entry names it via `answers: <question timestamp>`. Open questions are counted at read time for inbox and dashboard rollups (log-role files and legacy `comments.md` until migrated).

---

## 5. template.md

**Ownership:** Human-authored (built-ins seeded from the package; never overwritten on upgrade unless reset)

Each installed template is a directory under `~/.syntaur/templates/<id>/` with a `template.md` manifest. The manifest's YAML frontmatter declares stages, file roles, gates, and defaults; the markdown body is human notes (often a single line for built-ins).

### Manifest schema

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
| `stages[].agent` | string | no | — | Implementer agent id for stage handoff default |
| `stages[].reviewer` | string | no | — | Reviewer agent id for stage handoff default |
| `stages[].auto` | boolean | no | `true` for agent, `false` for reviewer | When `true`, entering the stage queues one automatic exact-target turn (requires a running dashboard on this home) |
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

### Validation rules

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
17. Each stage declares at most one of `agent` or `reviewer`; both on one stage is invalid.

`template check` implements rules 1–17. Built-ins (`feature`, `bug`, `spike`, `quick`, `legacy`) are seeded by `syntaur init` and `migrate v2`. Do not use `legacy` for new tickets.

**Stage dispatch semantics:** ids name agent **definitions** (`~/.syntaur/agents/<id>.md` plus built-ins), not harness registry entries. The `harness` field (`claude` | `codex` | `cursor`) selects the ACP adapter; separate ids with the same harness can pin different models. `auto: false` means the driver uses **Hand to** on the ticket page for a one-turn handoff; `start --agent <id>` is a one-use recipient override for automatic dispatch on that start only. Receipt `completed` means the ACP turn finished, not that `review-clean` or `done` gates passed. Offline CLI lifecycle moves succeed; dispatch is retried from the dashboard without repeating the verb.

### Example (abbreviated)

```markdown
---
id: feature
version: 1
builtin: feature@2
description: Full development cycle with plan approval, workspace, implementation, and review.
whenToUse: Default for feature work, refactors, and multi-step implementation with plan and review gates.
workspace: required
defaultPriority: medium
playbooks:                   # documentary; content lives in stages[].instructions
  - create-and-plan-assignment
  - plan-versioning
  - read-before-plan
  - workspace-before-code
  - keep-records-updated
  - e2e-dev-cycle
stages:
  - id: backlog
    label: Backlog
    instructions: Ticket is queued. Run syntaur plan create <ID> when ready to write the plan.
  - id: planning
    label: Planning
    instructions: |
      Read before you plan, in order: project.md, ticket.md, this ticket's journal.md, then every depends_on ticket's plan and its decision entries (syntaur show <dep> --log -t decision). Upstream decisions are binding; do not contradict them silently. Do not skip files you think you already know.
      Write plan.md: objective, decisions, tasks with files and tests, verify steps, risks. Iterate on plan.md directly until an independent review has no high or medium findings and you agree it is solid; never version an unimplemented plan.
      Record accepted decisions with syntaur log <ID> -t decision. Ask through syntaur log <ID> -t question when a choice is the human's; answer open questions with -t answer --answers <ts>.
    agent: claude
    auto: false
  - id: ready
    label: Ready
    instructions: |
      Plan approved. Before any implementation code, bind a workspace: syntaur worktree create --branch <name> (or syntaur workspace set with repository, branch, worktree and parentBranch); syntaur start refuses without it.
      Run syntaur start <ID> when the workspace is set.
  - id: in_progress
    label: In Progress
    instructions: |
      Implement the approved plan task by task; keep the plan's task checkboxes current. After every meaningful step run syntaur log <ID> -t progress; tick acceptance criteria in ticket.md the moment each is met, never in a batch. journal.md is append-only through syntaur log; never edit it directly.
      Commit in small logical units with clear messages tied to plan tasks; run the linter or formatter before committing when the project has one; never amend; never commit secrets.
      If the plan must change mid-flight, add a "Revision N" section to plan.md (reason, what changed, what was already done) and log a decision; after implementation, change course with syntaur plan version <ID> and leave the implemented plan intact.
      Stopping before done: log a progress entry with the current state and what comes next. Questions for the human go through syntaur log <ID> -t question.
    agent: cursor
    auto: true
  - id: review
    label: Review
    instructions: |
      Verify every acceptance criterion with evidence: run the test suite and the build, check for regressions, and say what you could not verify.
      Have the work reviewed; fix every high and medium finding and re-review until the reviewer has none and you agree the code is solid. Then syntaur log <ID> -t review --verdict approve --open high=0,medium=0.
      Hand off with syntaur log <ID> -t handoff (summary, state, next steps, context the next agent needs), then syntaur done <ID>.
    reviewer: cursor
    auto: false
  - id: done
    label: Done
    instructions: Terminal. Criteria checked, handoff logged and a clean review are required before syntaur done.
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
  start: [plan-approved, workspace-set]
  done: [criteria-checked, handoff-logged, review-clean, deps-done]
---
```

---

## 6. config.md

**Ownership:** Human-authored

Global Syntaur configuration file at `~/.syntaur/config.md`. This file is **optional** -- Syntaur works with sensible defaults when it is absent.

### Frontmatter Schema

| Field | Type | Valid Values | Required | Default | Description |
|-------|------|-------------|----------|---------|-------------|
| `version` | string | `"2.0"` | required | — | Config schema version. |
| `defaultProjectDir` | string | absolute path | optional | `~/.syntaur/projects` (expanded) | Default directory for projects. **Must be absolute path; never use `~`.** |
| `agentDefaults.trustLevel` | string (enum) | `low`, `medium`, `high` | optional | `medium` | Default trust level for agents. |
| `agentDefaults.autoApprove` | boolean | `true`, `false` | optional | `false` | Whether to auto-approve agent actions. |
| `agentDefaults.autoCreateWorktree` | string (enum) | `skip`, `ask`, `always` | optional | `ask` | Behavior when a flow that needs a worktree meets a ticket with no `workspace.worktree`/`branch` set. `skip`: fall back without prompting. `ask`: interactively offer to create a worktree. `always`: create one with inferred defaults, no prompt. |
| `terminal` | string (enum) or null | `terminal-app`, `iterm`, `ghostty`, `alacritty`, `warp`, `kitty`, `cmux` | optional | `null` (platform default) | Which terminal `syntaur open` opens at a worktree. |
| `session.idleSweepHours` | number | > 0 | optional | `6` | How long an `active` non-chat session may sit without a heartbeat before the stale sweep marks it `stopped` and closes its engagement. |
The v1 `types` config block was removed in the templates protocol. Ticket manifests live under `~/.syntaur/templates/<id>/template.md`; per-project defaults use `defaultTemplate` in `project.md`.

The `agents:` and `agentDiscovery:` blocks were removed in 1.0 along with the
terminal-launch stack they configured — Syntaur no longer opens a terminal for
you, so there are no launch recipes to configure. Chat agents are defined per
file under `~/.syntaur/agents/<id>.md` instead (see
[ticket-chat.md](../ticket-chat.md)). A leftover `agents:` block in
`config.md` is ignored; delete it.

**Path normalization:** All path fields must use absolute expanded form. The CLI expands `~` to the full home directory at write time. A config file must never contain a literal `~` in any path value.

### Body Sections

The body is optional and contains human notes about the configuration. No required structure.

### Example

```markdown
---
version: "2.0"
defaultProjectDir: /Users/brennen/.syntaur/projects
agentDefaults:
  trustLevel: medium
  autoApprove: false
  autoCreateWorktree: ask
terminal: ghostty
session:
  idleSweepHours: 6
---

# Syntaur Configuration

Personal development machine. Projects stored in default location.
```

---

## 7. Playbooks (`~/.syntaur/playbooks/<slug>.md`)

**Ownership:** Human-authored (agents edit via the dashboard Library; CLI playbook verbs were removed in v2)
**Purpose:** Optional behavioral rules that apply on top of template stage instructions.

Playbooks are global — they apply across all projects and tickets. Fresh homes seed two cross-template playbooks (`commit-discipline`, `test-before-done`). Template manifests may list playbook slugs in `playbooks[]` for documentation only; that guidance lives in `stages[].instructions` instead.

**Injection:** Cross-template playbooks (enabled slugs not claimed by any template manifest) are injected on each Claude Code prompt by the `UserPromptSubmit` hook via `syntaur session context`. Agents should run `syntaur show <id>` and follow **Stage** and **Next** for template workflow; user playbooks from the hook apply on top when present. The derived manifest is rebuilt for the dashboard Library and is not read by the hook.

The **feature** template expresses the e2e development cycle as its defaults (stages, agents, gates); session mechanics such as worktree creation, `track-session`, and session hooks are separate skills and hooks, not stage text.

### Frontmatter Schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Display name |
| `slug` | string | yes | — | Filename-safe identifier (lowercase, hyphenated) |
| `description` | string | no | `""` | One-line summary of what the playbook does |
| `when_to_use` | string | no | `null` | Describes when agents should apply this playbook |
| `created` | RFC 3339 | yes | — | Creation timestamp |
| `updated` | RFC 3339 | yes | — | Last update timestamp |
| `tags` | string[] | no | `[]` | Categorization tags |

### Body

The body contains imperative rules and workflows in markdown. Guidelines:

- Keep playbooks short — ideally under 50 lines
- Use imperative language ("Do X", "Never do Y")
- Focus each playbook on a single concern
- Rules in playbooks take precedence over default conventions when they conflict

### Example

```markdown
---
name: "Test Before Done"
slug: test-before-done
description: "Agents must run tests and verify acceptance criteria before marking tickets complete"
when_to_use: "Before transitioning a ticket to review or completed"
created: "2026-04-02T00:00:00Z"
updated: "2026-04-02T00:00:00Z"
tags:
  - quality
  - testing
---

# Test Before Done

Before transitioning a ticket to `review` or `completed`:

1. **Run the test suite.** If the project has tests, run them. All must pass.
2. **Check every acceptance criterion.** Go through them one by one.
3. **Build the project.** If there's a build step, run it. No build errors allowed.

Do NOT mark a ticket complete just because you wrote the code.
```

## 8. Agent definitions (`~/.syntaur/agents/<id>.md`)

**Ownership:** Human via dashboard **Library** (built-in ids `claude`, `codex`, `cursor` ship as defaults).

Each file is YAML frontmatter plus a markdown body the harness reads when that agent participates in ticket chat. Field meanings (harness, model, permissions, roster lines) are documented in [ticket-chat.md](../ticket-chat.md).

Agent ids appear in template `stages[].agent` / `reviewer`, `syntaur log --agent`, `assign --agent`, and chat `@mention` routing.

## 9. SQLite (`syntaur.db`)

Operational cache at `~/.syntaur/syntaur.db` (gitignored). Markdown under `projects/` remains authoritative for ticket state; the database holds sessions, engagements, audit events, usage rollups, and chat indexes. Each subsystem owns a `*_schema_version` row in `meta`.

### `meta`

| Column | Description |
|--------|-------------|
| `key` | TEXT PRIMARY KEY |
| `value` | TEXT |

### `sessions`

| Column | Description |
|--------|-------------|
| `session_id` | TEXT PRIMARY KEY — real agent runtime id (never synthesized) |
| `agent` | Harness name (`claude`, `codex`, `cursor`, …) |
| `started`, `ended` | ISO timestamps |
| `status` | `active`, `completed`, or `stopped` |
| `path` | Cwd at registration |
| `description`, `summary` | Human or auto summary text |
| `transcript_path` | Absolute transcript path (preferred) |
| `original_head_sha`, `hosted_by` | Legacy / attribution columns |
| `summarized_at`, `description_source` | Auto-summary metadata |
| `pinned_at`, `archived_at` | Session list curation |
| `created_at`, `updated_at` | Row timestamps |

Ticket binding is on `engagement`, not on `sessions`. Pre-v2 rows used `project_slug` / `assignment_slug` on `sessions`; migrator re-keys to `ticket_id` on `engagement` and related tables.

### `engagement`

| Column | Description |
|--------|-------------|
| `id` | INTEGER PRIMARY KEY |
| `session_id` | TEXT NOT NULL |
| `ticket_id` | TEXT — ticket id (`<PREFIX>-<n>`) |
| `stage` | Stage at open |
| `started_at`, `ended_at` | Interval |
| `tokens_at_open`, `tokens_at_close` | JSON snapshots |
| `close_reason` | Why the edge closed |

At most one open engagement per session (partial unique index on `ended_at IS NULL`).

### `events`

| Column | Description |
|--------|-------------|
| `event_id` | TEXT PRIMARY KEY |
| `ticket_id` | TEXT NOT NULL |
| `at` | TEXT NOT NULL |
| `actor` | TEXT NOT NULL |
| `type` | TEXT NOT NULL |
| `details` | JSON TEXT |
| `source_key` | TEXT UNIQUE — idempotency |

**Types:** `created`, `moved`, `flagged`, `unflagged`, `plan-approved`, `plan-versioned`, `logged`, `dispatched`, `retemplated`.

### `usage_events` / `usage_daily`

`usage_events` PK `(session_id, model)` — cumulative token/cost snapshot per session and model. Columns include `input_tokens`, `output_tokens`, `cache_creation_tokens`, `cache_read_tokens`, `total_tokens`, `total_cost`, `project_slug`, `ticket_id`, `event_ts`, `updated_at`.

`usage_daily` PK `(day, tool, model, project_slug, ticket_id)` — rolled-up daily totals with `frozen` reserved for closed-day promotion.

### `chat_sessions` / `chat_items` / `chat_harness_options`

`chat_sessions.session_key` is `<ticket-id>~<harness>` (no colon). Columns include `ticket_id`, `agent_id`, `harness`, `acp_session_id`, `usage_snapshot_json`, `state`, `last_delivered_seq`, `standing_fingerprint`, `commands_json`.

`chat_items` stores materialised chat rows keyed by `item_id` with `ticket_id`, `session_key`, `seq_first` / `seq_last`, and serialised JSON.

`chat_harness_options` caches per-harness adapter config and auth state for the Agents editor.

Canonical chat transcript: `<ticketDir>/chat/events.jsonl` (index is rebuildable).

### Session id rule

`session_id` must be the **real** id from the agent runtime when known. `syntaur track-session` and `syntaur session register` resolve it from env, process markers, or transcript scan when omitted. Never invent a substitute id for attribution.

### CLI

```bash
syntaur track-session --agent <name> [--session-id <id>] [--transcript-path <path>] \
  [--project <slug>] [--ticket <id>] [--path <cwd>] [--description <text>]
```

Read audit rows: `syntaur timeline <id>` or `syntaur history <id> --events`. Ticket file history: `syntaur history <id>` (git log on the ticket folder).

---

## 10. Legacy files (pre-2.0, merged by `migrate journal`)

The `legacy` template keeps v1 sidecars until `syntaur migrate journal` merges them into `journal.md` and switches the ticket to `feature` (or `--template`). **`syntaur migrate v2`** may inject `**Recorded:** <iso>` as the first body line on undated decision/handoff blocks when stripping `updated` from record frontmatter.

| File | Role after merge |
|------|------------------|
| `progress.md` | `progress` / other log types (newest-first layout tolerated until merge) |
| `decision-record.md` | `decision` entries |
| `handoff.md` | `handoff` entries |
| `comments.md` | `question` / `answer` / `note` entries |
| `scratchpad.md` | `note` entries or remains as `notes` role on legacy only |

Per-ticket backups live in `.migrate-journal.bak/` during merge. Full v1 layouts for these files were removed from this reference — use `syntaur show` on a `legacy` ticket or run a dry-run `migrate journal` to inspect sources.

---


---
