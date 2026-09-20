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
| `status` | stage id | `backlog`, `planning`, `ready`, `in_progress`, `review`, `done`, `dropped` | required | first template stage | Current stage. See [spec.md](./spec.md) §6. |
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

**Q&A and progress live in the log role:** Modern templates declare `journal.md` with role `log`. Append typed entries via `syntaur log -t <type>` (questions, answers, progress, decisions, handoffs, notes, reviews). See section 5. Legacy templates keep separate files until `syntaur migrate journal` merges them — see sections 7–10.

**Sessions:** Agent sessions are tracked in a SQLite database (`~/.syntaur/syntaur.db`), not in the ticket file. The `assignee` field in frontmatter is the authoritative owner. See section 13 for session storage details.

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

- Depends on [BAS-1 design-auth-schema](../BAS-1-design-auth-schema/ticket.md) for the
  user table schema and key storage approach
- See [auth-requirements](../../resources/auth-requirements.md) for product specs
- JWT library: `jose` (chosen in Decision 1)
```

---

## 3. plan\*.md (`plan.md`, `plan-v2.md`, ...) — legacy-template

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

## 5. scratchpad.md — legacy-template

**Ownership:** Agent-writable

> **Note:** Preserved by the `legacy` template. Other templates may omit scratchpad or declare a different notes file in `template.md`.

Unstructured working memory for the agent. The agent uses this as scratch space during work. No required body format -- this is the agent's private workspace within the ticket. Created as an empty template by scaffolding, optional until first use.

### Frontmatter Schema

| Field | Type | Valid Values | Required | Default | Description |
|-------|------|-------------|----------|---------|-------------|
| `ticket` | string | ticket slug | required | — | The parent ticket. |
| `updated` | string (RFC 3339) | RFC 3339 datetime | required | — | When the scratchpad was last modified. |

### Body Sections

No required structure. The body is freeform working notes.

### Example

```markdown
---
ticket: implement-jwt-middleware
updated: "2026-03-18T14:30:00Z"
---

# Scratchpad

## Token format notes

Access token payload:
- sub: user UUID
- iat: issued at
- exp: 15 min from iat
- iss: "myapp"

Refresh token: opaque string, stored as SHA-256 hash in DB.

## Things to remember

- The jose library uses `importSPKI` / `importPKCS8` for PEM key import
- Need to handle both expired and malformed token errors differently (401 vs 400)
- Check if the DB migration from design-auth-schema included the refresh_tokens table
```

---

## 6. handoff.md — legacy (merged by `migrate journal`)

**Ownership:** Agent-writable, append-only (legacy template only)

> **Note:** Merged into `journal.md` as `handoff` log entries by `syntaur migrate journal`. Modern templates use `syntaur log -t handoff` on `journal.md` instead.

The **ticket-level cross-ticket outbound** doc. Written at completion (via the `done` skill / flow) for the next ticket, agent, or human reviewer who picks up downstream work. Each handoff is a numbered entry so history is preserved. Created as an empty template by scaffolding, optional until first use. Legacy frontmatter counters (`handoffCount`, `updated`) are stripped by `syntaur migrate v2`; undated handoff blocks may gain a `**Recorded:** <iso>` line as the first body line when the migrator needs a timestamp fallback.

### Frontmatter Schema

| Field | Type | Valid Values | Required | Default | Description |
|-------|------|-------------|----------|---------|-------------|
| `ticket` | string | ticket slug | required | — | The parent ticket. |
| `generated` | string (RFC 3339) | RFC 3339 datetime | required | — | When the file was first created. |

### Body Sections

Each handoff is a numbered entry (`## Handoff N`) separated by a horizontal rule. Entries are appended at the end of the file.

| Sub-section | Purpose | Who Writes |
|-------------|---------|------------|
| From | Who is handing off (agent name or "human") | Agent |
| To | Who is receiving (agent name or "human") | Agent |
| Reason | Why the handoff is happening | Agent |
| Summary | What was accomplished and what remains | Agent |
| Current State | Where things stand -- what's working, what's not, what's partially done | Agent |
| Next Steps | Bulleted list of recommended next actions | Agent |
| Important Context | Anything the next agent/human needs that isn't in the ticket or plan | Agent |

### Example

```markdown
---
ticket: design-auth-schema
generated: "2026-03-17T10:00:00Z"
---

# Handoff Log

## Handoff 1: 2026-03-17T10:00:00Z

**From:** claude-2
**To:** human
**Reason:** Ticket completed, handing off for review and downstream work.

### Summary
Designed the complete auth schema including users table, refresh_tokens table,
and RSA key pair storage. All acceptance criteria met.

### Current State
- Users table migration is ready at `migrations/003_auth_schema.sql`
- Refresh tokens table included with user_id FK, token_hash, expires_at, revoked_at
- RSA key pair stored as environment variables (not in DB)
- All tests passing

### Next Steps
- Review the migration before merging
- Start implement-jwt-middleware (depends on this ticket)

### Important Context
Chose PostgreSQL over Redis for refresh token storage. See decision record for
rationale. The connection pooling findings are documented in the project memory
`postgres-connection-pooling`.
```

---

## 7. decision-record.md — legacy (merged by `migrate journal`)

**Ownership:** Agent-writable, append-only (legacy template only)

> **Note:** Merged into `journal.md` as `decision` log entries by `syntaur migrate journal`. Modern templates use `syntaur log -t decision` instead.

A structured log of decisions made during the ticket. Each decision is a numbered entry with required fields. Created as an empty template by scaffolding, optional until first use. Legacy counters are stripped by `syntaur migrate v2`; decision blocks without a date may gain `**Recorded:** <iso>` from the file’s former `updated` timestamp during migration.

### Frontmatter Schema

| Field | Type | Valid Values | Required | Default | Description |
|-------|------|-------------|----------|---------|-------------|
| `ticket` | string | ticket slug | required | — | The parent ticket. |
| `generated` | string (RFC 3339) | RFC 3339 datetime | required | — | When the file was first created. |

### Body Sections

Each decision is a numbered entry (`## Decision N: <title>`) separated by a horizontal rule. Entries are appended at the end of the file.

| Field | Purpose | Who Writes |
|-------|---------|------------|
| Date | When the decision was made (RFC 3339) | Agent |
| Status | Lifecycle of the decision | Agent |
| Context | Why this decision was needed | Agent |
| Decision | What was decided | Agent |
| Consequences | What follows from this decision | Agent |

**Status values:**

| Value | Meaning |
|-------|---------|
| `proposed` | Decision is under consideration, not yet finalized. |
| `accepted` | Decision has been accepted and is in effect. |
| `rejected` | Decision was considered but not adopted. |
| `superseded` | Decision was accepted previously but has been replaced by a later decision. |

### Example

```markdown
---
ticket: implement-jwt-middleware
generated: "2026-03-17T09:00:00Z"
---

# Decision Record

## Decision 1: Use RS256 for JWT signing

**Date:** 2026-03-17T16:30:00Z
**Status:** accepted
**Context:** Need to choose a JWT signing algorithm. Options are HS256 (symmetric)
or RS256 (asymmetric). The auth-requirements resource specifies that tokens may
be verified by multiple services.
**Decision:** Use RS256 (asymmetric) so that services only need the public key to
verify tokens. The private key stays on the auth server.
**Consequences:** Slightly larger tokens and slower signing than HS256, but
verification can be distributed without sharing secrets. Key rotation is simpler
since only the public key needs to be distributed.
```

---

## 8. progress.md — legacy (merged by `migrate journal`)

**Ownership:** Agent-writable, append-only (`legacy` template log role)

> **Note:** The `legacy` template still uses `progress.md` as its log role until migrated. `syntaur progress log` is an alias of `syntaur log -t progress`. After `migrate journal`, entries live in `journal.md`.

A reverse-chronological log of work the agent has done on the ticket. This replaces the old `## Progress` body section that used to live inside `ticket.md`. The agent writes entries directly (no CLI mediation). Created as an empty template by scaffolding, optional until first use.

### Frontmatter Schema

| Field | Type | Valid Values | Required | Default | Description |
|-------|------|-------------|----------|---------|-------------|
| `ticket` | string | ticket slug | required | — | The parent ticket. |
| `generated` | string (RFC 3339) | RFC 3339 datetime | required | — | When the template was scaffolded. |

Legacy `entryCount` and `updated` frontmatter keys are removed by `syntaur migrate v2`.

### Body Sections

Each entry is a timestamped heading (`## <RFC 3339 timestamp>`) followed by the entry body. Entries are **prepended** — newest first. The empty template contains the heading `# Progress` and the sentinel `No progress yet.` which is replaced on first entry.

### Example

```markdown
---
ticket: implement-jwt-middleware
generated: "2026-03-17T18:00:00Z"
---

# Progress

## 2026-03-18T14:30:00Z

Implemented Bearer token extraction and RS256 signature validation. Both passing
tests. Moving on to token expiry checking next.

## 2026-03-17T18:00:00Z

Set up the middleware skeleton and installed the `jose` library. Created the
worktree and branch. Reviewed the auth schema from the dependency ticket.
```

---

## 9. comments.md — legacy (merged by `migrate journal`)

**Ownership:** Retired — was CLI-mediated on the `legacy` template only

> **Note:** Merged into `journal.md` as `question`, `answer`, and `note` log entries by `syntaur migrate journal`. Use `syntaur log -t question|answer|note` on modern templates.

Historical threaded Q&A file from the `legacy` template. Preserved here for migration reference only.

### Frontmatter Schema

| Field | Type | Valid Values | Required | Default | Description |
|-------|------|-------------|----------|---------|-------------|
| `ticket` | string | ticket slug | required | — | The parent ticket. |
| `generated` | string (RFC 3339) | RFC 3339 datetime | required | — | When the template was scaffolded. |

Legacy `entryCount` and `updated` keys are stripped by `syntaur migrate v2`.

### Body Sections

Each comment is a heading with a stable id (`## <comment-id>`) followed by structured metadata lines and the body. Entries are appended at the end. The empty template contains the heading `# Comments` and the sentinel `No comments yet.` which is replaced on first entry.

| Field | Purpose | Required | Notes |
|-------|---------|----------|-------|
| `**Recorded:**` | RFC 3339 timestamp | yes | When the comment was appended. |
| `**Author:**` | Agent name or `"human"` | yes | Who wrote the comment. |
| `**Type:**` | One of `question`, `note`, `feedback` | yes | Classification. |
| `**Reply to:**` | A previous comment id | no | Present only when the comment replies to another. |
| `**Resolved:**` | `true` or `false` | conditional | Present **only** when `Type: question`. Toggleable via `PATCH /api/.../comments/:id/resolved`. |
| Body | Freeform markdown | yes | The comment content. |

### Example

```markdown
---
ticket: implement-jwt-middleware
generated: "2026-03-17T16:00:00Z"
---

# Comments

## c-1

**Recorded:** 2026-03-17T16:30:00Z
**Author:** claude-1
**Type:** question
**Resolved:** true

Should refresh tokens be stored in the database or use a stateless approach?

## c-2

**Recorded:** 2026-03-17T17:05:00Z
**Author:** human
**Type:** note
**Reply to:** c-1

Store refresh tokens in the database so we can revoke them. Add a `refresh_tokens`
table with user_id, token_hash, expires_at, revoked_at.

## c-3

**Recorded:** 2026-03-18T15:00:00Z
**Author:** human
**Type:** feedback

Great progress on the middleware. Please add rate-limit tests before review.
```

### Open questions

Open `question` log entries (and legacy `comments.md` until migrated) feed inbox and rollup UIs directly — there is no `_status.md` file.

---

## 10. Agent Sessions (SQLite)

**Storage:** `~/.syntaur/syntaur.db` — `sessions` table

Agent sessions are stored in a SQLite database rather than markdown files. This provides proper querying, atomic updates, and scales well as session counts grow. Sessions are operational/node-local data — agents write them via the `syntaur track-session` CLI or the dashboard API, and humans consume them through the dashboard UI.

### Schema

```sql
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  project_slug TEXT,
  assignment_slug TEXT,
  agent TEXT NOT NULL,
  started TEXT NOT NULL,
  ended TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  path TEXT,
  description TEXT,
  transcript_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Current schema version: `3`. The schema version is stored in a `meta` table and the DB migrates automatically on `initSessionDb()` — v1→v2 made project/ticket nullable and added `description`; v2→v3 added `transcript_path`.

### Session ID Rule

`session_id` must always be the **real, agent-generated session identifier**. Never synthesize a UUID. The CLI (`syntaur track-session`) and the POST endpoint (`/api/agent-sessions`) both reject requests that omit `session_id`.

Sources of truth by agent:

| Agent | Where to read the real session id |
|-------|-----------------------------------|
| Claude Code | SessionStart hook stdin payload (`session_id`), or fallback: the most-recently-modified `~/.claude/sessions/<pid>.json` whose `cwd` matches `$(pwd)`. |
| Codex | `payload.id` from the first line (`type: "session_meta"`) of the most-recently-modified `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` whose `payload.cwd` matches `$(pwd)`. |

`transcript_path` is the absolute path to the agent's rollout/transcript file. Optional — nullable column — but strongly preferred so handoffs and the dashboard can link back to the raw conversation.

### Upsert Semantics

`appendSession` (and the POST endpoint it backs) upserts on `session_id`. Re-registering the same real id is a no-op for identity fields and a COALESCE for other fields, so SessionStart can pre-register a minimal row that `grab` or `syntaur track-session` later enrich with project/ticket/description. Sessions already in a terminal status (`completed` / `stopped`) are not revived by re-registration.

### Status Values

| Status | Meaning |
|--------|---------|
| `active` | Session is currently running |
| `completed` | Session finished successfully |
| `stopped` | Session was terminated or failed |

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agent-sessions` | List all sessions across all projects |
| `GET` | `/api/agent-sessions/:projectSlug` | List sessions for a project (optional `?ticket=` filter) |
| `POST` | `/api/agent-sessions` | Register a new session |
| `PATCH` | `/api/agent-sessions/:sessionId/status` | Update session status |

### CLI

```bash
syntaur track-session --agent <name> --session-id <real-id> [--transcript-path <path>] [--project <slug>] [--ticket <id>] [--path <cwd>] [--description <text>]
```

`--session-id` is required; it must be the real id from the agent runtime. `--transcript-path` is optional but strongly preferred.

### Events

Lifecycle and audit events live in the same database (`events` table):

| Column | Type | Description |
|--------|------|-------------|
| `event_id` | TEXT PRIMARY KEY | Unique event id |
| `ticket_id` | TEXT NOT NULL | Ticket id (`<PREFIX>-<n>`) |
| `at` | TEXT NOT NULL | RFC 3339 timestamp |
| `actor` | TEXT NOT NULL | Who triggered the event |
| `type` | TEXT NOT NULL | Event type (see below) |
| `details` | TEXT | JSON payload |
| `source_key` | TEXT UNIQUE | Idempotency / provenance key |

Indexes: `(ticket_id, at)` and `at`.

**Tracked event types** (same as [cli.md](../cli.md#tracked-event-types)): `created`, `moved`, `flagged`, `unflagged`, `plan-approved`, `plan-versioned`, `logged`, `dispatched`, `retemplated`.

Read with `syntaur timeline <id>` or `syntaur history <id> --events`. Ticket folder file history is separate: `syntaur history <id>` (git log scoped to the ticket directory).

---

## 11. Resource Files

**Ownership:** Shared-writable (humans and agents)

Resource files live in the `resources/` folder and represent reference material agents need to consult: external docs, API specs, architecture notes, configuration references, etc.

**Canonical identity:** The filename (slug) is the canonical identifier. Unlike projects and tickets, resources do not carry a separate `id`/`slug` in frontmatter. The `name` field is display-only.

### Frontmatter Schema

| Field | Type | Valid Values | Required | Default | Description |
|-------|------|-------------|----------|---------|-------------|
| `type` | string (literal) | `"resource"` | required | — | Always `"resource"`. Discriminator field. |
| `name` | string | any | required | — | Display name for the resource. |
| `source` | string | agent name or `"human"` | required | — | Who created this resource. Tracks provenance. |
| `category` | string (enum) | `documentation`, `api`, `service`, `config`, `other` | required | — | Classification of the resource. |
| `sourceUrl` | string or null | URL | optional | `null` | Link to the original external source, if any. |
| `sourceTicket` | string or null | ticket slug | optional | `null` | The ticket that created this resource, if any. |
| `relatedTickets` | array of strings | ticket ids | optional | `[]` | Tickets that reference or use this resource. |
| `created` | string (RFC 3339) | RFC 3339 datetime | required | — | When the resource was created. |
| `updated` | string (RFC 3339) | RFC 3339 datetime | required | — | When the resource was last modified. |

### Body Sections

No required structure. The body contains the resource content: descriptions, links, specs, notes, etc.

### Example

**Filename:** `resources/auth-requirements.md`

```markdown
---
type: resource
name: Auth Requirements
source: human
category: documentation
sourceUrl: https://docs.google.com/document/d/1abc123/edit
sourceTicket: null
relatedTickets:
  - design-auth-schema
  - implement-jwt-middleware
created: "2026-03-15T09:00:00Z"
updated: "2026-03-16T09:00:00Z"
---

# Auth Requirements

Product requirements for the authentication system, summarized from the PRD.

## Token Specifications

- **Access token:** JWT, RS256 signed, 15-minute TTL
- **Refresh token:** opaque, stored in DB, 7-day TTL, rotation on use
- Both tokens issued on login and refresh

## Endpoints

- `POST /auth/login` — issue token pair
- `POST /auth/refresh` — rotate refresh token, issue new access token
- `POST /auth/logout` — revoke refresh token
- `GET /auth/me` — return current user (requires valid access token)

## Security Requirements

- Refresh tokens must be revocable
- Rate limit on login: 5 attempts per minute per IP
- Rate limit on refresh: 10 requests per minute per user
```

---

## 12. Memory Files

**Ownership:** Shared-writable (humans and agents)

Memory files live in the `memories/` folder and represent learnings, patterns, or context discovered during the project that may be useful for other tickets or future work.

**Canonical identity:** The filename (slug) is the canonical identifier. No separate `id`/`slug` in frontmatter. The `name` field is display-only.

### Frontmatter Schema

| Field | Type | Valid Values | Required | Default | Description |
|-------|------|-------------|----------|---------|-------------|
| `type` | string (literal) | `"memory"` | required | — | Always `"memory"`. Discriminator field. |
| `name` | string | any | required | — | Display name for the memory. |
| `source` | string | agent name or `"human"` | required | — | Who created this memory. Tracks provenance. |
| `sourceTicket` | string or null | ticket slug | optional | `null` | The ticket where this learning originated. |
| `relatedTickets` | array of strings | ticket ids | optional | `[]` | Tickets that benefit from this memory. |
| `scope` | string (enum) | `ticket`, `project`, `global` | required | — | How broadly this learning applies. |
| `created` | string (RFC 3339) | RFC 3339 datetime | required | — | When the memory was created. |
| `updated` | string (RFC 3339) | RFC 3339 datetime | required | — | When the memory was last modified. |
| `tags` | array of strings | any | optional | `[]` | Freeform tags for categorization and search. |

**Scope values:**

| Value | Meaning |
|-------|---------|
| `ticket` | Learning is specific to the source ticket. |
| `project` | Learning is relevant to the entire project. |
| `global` | Learning is potentially promotable to a global memory system (future versions). |

### Body Sections

No required structure. The body contains the learning content.

### Example

**Filename:** `memories/postgres-connection-pooling.md`

```markdown
---
type: memory
name: PostgreSQL Connection Pooling Configuration
source: claude-2
sourceTicket: design-auth-schema
relatedTickets:
  - implement-jwt-middleware
scope: project
created: "2026-03-17T11:00:00Z"
updated: "2026-03-17T11:00:00Z"
tags:
  - postgres
  - performance
  - infrastructure
---

# PostgreSQL Connection Pooling Configuration

During the auth schema design, discovered that the default PostgreSQL connection
pool settings are insufficient for the expected token refresh load.

## Findings

- Default `max` connections in `pg` library is 10, which will bottleneck under
  concurrent refresh token lookups
- Recommended: set pool `max` to 20 for the auth service, with `idleTimeoutMillis`
  of 30000
- Connection pool should be shared across the auth middleware and refresh endpoint,
  not created per-request

## Configuration

```javascript
const pool = new Pool({
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

## Relevance

This applies to any ticket that performs database queries in the request path,
especially the JWT middleware refresh endpoint which will see high concurrency.
```

---


## 13. template.md

**Ownership:** Human-authored (built-ins seeded from the package; never overwritten on upgrade unless reset)

Each installed template is a directory under `~/.syntaur/templates/<id>/` with a `template.md` manifest. The manifest's YAML frontmatter declares stages, file roles, gates, and defaults; the markdown body is human notes (often a single line for built-ins).

### Manifest schema (§5.2)

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

### Validation rules (§5.3)

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

## 14. config.md

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

The `agents:` and `agentDiscovery:` blocks were REMOVED in v0.80 along with the
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

## 15. Playbooks (`~/.syntaur/playbooks/<slug>.md`)

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
