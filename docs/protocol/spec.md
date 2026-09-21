# Syntaur Protocol Specification

**Protocol version:** 2.0 · **Package:** 1.0.0 (as shipped)

This document is the conceptual contract for Syntaur v2. Field-level schemas live in [file-formats.md](./file-formats.md). The CLI surface is in [cli.md](../cli.md). Where this text disagrees with running code, the code wins — callouts below note known deltas as **as shipped in 1.0**.

---

## 1. Purpose and scope

Syntaur is a markdown-on-disk workflow for coding agents: projects, tickets, templates, lifecycle verbs, a typed journal, chat, sessions, and a local dashboard. Agents discover work through `syntaur show`; humans steer through markdown they own and through the dashboard.

**In scope:** the kernel (`ticket.md` + `chat/`), fixed stage vocabulary, four file roles, template manifests, verbs and gates, rendered `show`, ticket ids, Needs me and the board, the six skills and three hooks, and the CLI commands that exist in `syntaur --help`.

**Out of scope here:** implementation code, dashboard wireframes, and one-off migration transcripts (see [v1.0 release note](../releases/v1.0.md)).

---

## 2. Vocabulary

| Term | Meaning |
|------|---------|
| ticket | The unit of work; the noun everywhere (files, UI, database keys) |
| project | Container under `~/.syntaur/projects/<slug>/` with `project.md` and `tickets/` |
| template | Directory under `~/.syntaur/templates/<name>/` defining stages, files, gates, workspace policy |
| kernel | Invariant core: `ticket.md` and `chat/` only |
| role | One of `plan`, `log`, `notes`, `deliverable`; tool behaviour for a template file |
| stage | Fixed id in §3.5; stored in `ticket.md` `status` |
| flag | `blocked` or `parked`; reason string or null; does not change stage |
| gate | Named check a verb evaluates when declared on the template |
| verb | CLI command that may move `status`, set flags, or act on role files |
| broker | Chat subsystem that owns `chat/` and supplies standing context to ACP participants |
| show | Rendered ticket summary from `syntaur show <id>` |

Verbs drop the noun: `syntaur new`, not `syntaur new-ticket`.

---

## 3. Kernel

### 3.1 Home layout

```
~/.syntaur/
  config.md                 # human via dashboard Settings; CLI reads
  templates/                # built-ins on init/update; human edits copies
  playbooks/                # human via dashboard Library
  agents/                   # human via dashboard Library
  projects/<slug>/
    project.md
    tickets/<ID>-<slug>/
  syntaur.db                # sessions, engagement, events, usage, chat index
  inbox-snoozes.json
  view-prefs.json
  hooks/                    # copied by syntaur hooks install
  statusline*               # statusline.sh, conf, backups (when installed)
  home-commit.sh
  .git / .gitignore         # git-backed home from syntaur init
  runtime/                  # operational logs and pid files (gitignored)
```

`SYNTAUR_HOME` overrides `~/.syntaur`. Retired top-level entries (`servers/`, `todos/`, `schedules/`, `workspaces.json`, `saved-views.json`, and similar) are tolerated by `doctor` but are not part of v2 — move them aside on upgrade (see [v1.0 release note](../releases/v1.0.md)).

### 3.2 project.md

| Field | Writer | Meaning |
|-------|--------|---------|
| `slug` | CLI | Directory name under `projects/` |
| `title` | human | Display name |
| `prefix` | CLI | 2–5 uppercase letters, unique across projects |
| `nextTicket` | CLI | Next counter for id allocation |
| `defaultTemplate` | human | Default for `syntaur new` (usually `feature`) |
| `archived`, `archivedAt`, `archivedReason` | CLI / human | Project archive state (`syntaur archive` / `restore`) |
| `created`, `updated` | CLI | Timestamps |

Body: `## Overview`, optional `## Notes`. Optional `repositories[]` and `externalIds[]` may appear on older projects; they are not required for v2 tickets.

**Id allocation:** ids are `<PREFIX>-<n>`, never reused. Source of truth is `nextTicket` in `project.md`; `syntaur new` and `migrate v2` allocate under exclusion.

### 3.3 Ticket folder and ticket.md

**Folder:** `projects/<project>/tickets/<ID>-<slug>/`. Address tickets by `<ID>`; folders match by id prefix. `syntaur rename <id> <new-slug>` changes slug and renames the folder.

**References:** `depends_on` and `links` hold ticket ids or URLs, never slugs or paths.

**Unknown files** (legacy `proof/`, `sessions/`, etc.) are ignored by verbs and not listed in `show`.

**Kernel files are not in `files[]`.** `ticket.md` and `chat/` are never manifest entries.

**Frontmatter (17 fields):**

| Field | Writer | Meaning |
|-------|--------|---------|
| `id` | CLI | `<PREFIX>-<n>` |
| `slug` | CLI/human | Display; folder suffix |
| `title` | human | |
| `project` | CLI | Project slug |
| `template` | CLI | Template id |
| `status` | CLI/verbs | Current stage |
| `priority` | human | `low` \| `medium` \| `high` \| `critical` |
| `blocked`, `parked` | verbs | Flag reasons or null |
| `depends_on` | human | Ticket ids |
| `assignee` | human / `assign` | Agent id or null |
| `tags`, `links` | human | |
| `workspace` | human/CLI | `repository`, `branch`, `worktree`, `parentBranch` or null |
| `plan` | CLI | `file`, `approvedDigest`, `approvedAt`, `approvedBy` |
| `created`, `updated` | CLI | |

Required body: `## Objective`, `## Acceptance Criteria` (checkboxes; `criteria-checked` gate). `## Context` is conventional. Links live in frontmatter only.

Agents edit `ticket.md` directly plus template files with `writer: agent`. Log-role files are append-only via `syntaur log`.

### 3.4 chat/

Ticket chat is documented in [ticket-chat.md](../ticket-chat.md). Contract for v2:

1. **Standing context** per adapter session is the full `syntaur show` text; refreshed on stage change.
2. **Record actions** from chat append **log-role** entries via the journal grammar (§4), not fixed legacy filenames.

### 3.5 Stages and flags

**Fixed stage ids (global order):**

| Stage | Meaning | Typical verb |
|-------|---------|--------------|
| `backlog` | Not started | `syntaur new` |
| `planning` | Plan being written | `syntaur plan create` |
| `ready` | Plan approved | `syntaur approve` |
| `in_progress` | Active work | `syntaur start` |
| `review` | In or awaiting review | `syntaur review` |
| `done` | Completed | `syntaur done` |
| `dropped` | Abandoned | `syntaur drop` |

Templates declare an ordered subset of `backlog`…`done` and may relabel. `dropped` is never in `stages[]`; `drop` works from any active stage. `ready` requires a `plan` role.

**Flags:**

| Flag | Set by | Cleared by |
|------|--------|------------|
| `blocked` | `block <id> "<reason>"` | `unblock <id>` |
| `parked` | `park <id> "<reason>"` | `unpark <id>` |

**`depends_on`:** the `deps-done` gate (when declared) requires every listed ticket to be `done` before the gated verb runs — on built-in `feature`, `deps-done` is on `done`, not `start` (**as shipped in 1.0**).

### 3.6 Ids and folder names

Format `<PREFIX>-<n>` per project. Scratch project (`projects/scratch/`, prefix `SCR`) holds tickets created without `--project`. Operational tables key tickets by `id` string only.

---

## 4. Roles and the log grammar

### plan

At most one file. Verbs: `syntaur plan create`, `plan version`, `approve`. Gates: `plan-exists`, `plan-approved`.

### log

At most one file; `writer: cli`. Verb: `syntaur log`. Without a log role, `syntaur log` appends chat notes under `chat/`. Gates: `handoff-logged`, `review-clean`; Needs me tier 2 for open `question`.

**Frontmatter:** `purpose` only (from manifest `description`).

**Entry grammar:**

```
## <ISO-8601Z> · <type> · <author>
<optional key lines>
<body>
```

**Types (seven):** `progress`, `decision`, `handoff`, `note`, `question`, `answer`, `review`.

**Key lines:** `verdict: approve|changes · open: high=<n> medium=<n>` on `review`; `answers: <ISO>` on `answer`; `attachments: <path>` (under `chat/attachments/`).

**Author:** agent id from `~/.syntaur/agents/` or `human`. `--agent` on `syntaur log` sets author.

### notes

Any number of files; direct edit; no verbs.

### deliverable

At most one file; gate `deliverable-present` when declared.

---

## 5. Templates

**Layout:** `~/.syntaur/templates/<id>/template.md` (manifest), optional skeleton files.

**Commands:** `template list|new|check|reset`, `retemplate` (add missing files only).

**Built-ins (gates and stages as shipped in `templates/*/template.md`):**

| Template | Stages | `gates` (summary) |
|----------|--------|-------------------|
| `feature` | backlog → planning → ready → in_progress → review → done | `approve`: plan-exists; `start`: plan-approved, workspace-set; `done`: criteria-checked, handoff-logged, review-clean, deps-done |
| `bug` | backlog → in_progress → review → done | `start`: workspace-set; `done`: criteria-checked, handoff-logged, review-clean, deps-done |
| `spike` | backlog → in_progress → done | `done`: deliverable-present |
| `quick` | backlog → done | `done`: [] |
| `legacy` | full active set (migration only) | `approve`: plan-exists; `start`: []; `done`: criteria-checked, handoff-logged, deps-done |

Manifest schema and validation rules: [file-formats.md](./file-formats.md) §5.

---

## 6. Verbs, gates, dispatch, events, and CLI

**Stage order:** `backlog < planning < ready < in_progress < review < done`.

**`--force`:** skips gates; `forced: true` on `moved`.

**`--by <name>`:** audit actor on lifecycle verbs, plan create/version, and flag verbs (`human` default). **`start --agent <id>`** is dispatch recipient only, not audit attribution.

| Gate | Passes when |
|------|-------------|
| `plan-exists` | Plan role file non-empty |
| `plan-approved` | Plan digest matches `plan.approvedDigest` |
| `deps-done` | Every `depends_on` ticket is `done` |
| `workspace-set` | All four workspace fields set when template `workspace: required` |
| `criteria-checked` | All acceptance checkboxes checked |
| `handoff-logged` | `handoff` entry after last `in_progress` entry or `reopen` |
| `review-clean` | Latest `review` is `approve` with `high=0` after last `review` entry or `reopen` |
| `deliverable-present` | Deliverable role file non-empty |

| Verb | To / effect | Built-in gates (typical) |
|------|-------------|---------------------------|
| `plan create` / `plan version` | `planning` or file-only | — |
| `approve` | `ready` or file-only | `plan-exists` |
| `start` | `in_progress` | template `gates.start` |
| `review` | `review` | — |
| `done` | `done` | template `gates.done` |
| `drop` | `dropped` | reason required |
| `reopen` | stage before `done` | — |
| `block` / `park` / `unblock` / `unpark` | flags | reason on set |

**Dispatch:** on stage entry, when `stages[].agent` is set and `auto: true`, the broker queues one ACP turn (dashboard must be running). `reviewer` defaults `auto: false` → **Hand to**. `syntaur start --agent <id>` overrides the recipient once.

**Events** (`events` table): `created`, `moved`, `flagged`, `unflagged`, `plan-approved`, `plan-versioned`, `logged`, `dispatched`, `retemplated`. Ticket key column: `ticket_id`.

**CLI groups:** see [cli.md](../cli.md) — Setup, Projects, Tickets, Lifecycle, Records, Workspace, Sessions, Migrations, Hooks, Playbooks, Stage dispatch, Retired.

---

## 7. syntaur show

Text grammar (representative):

```
<ID> · <title> · <template> · <status>[ · blocked: …][ · parked: …]
Objective: …
Acceptance: n of m checked
Workspace: … — or — Workspace: none (template does not require one)
Depends: …
Files:
  ticket.md  kernel · editable
  …
Handoff: …
Log: last 3 entries
Stage: <id>. <instructions>
Next: <hint>
Commands: syntaur log …; syntaur block …; ask via question log or @mention in chat
```

`--json` emits the same content structurally. `--log` prints log entries only (chat notes when no log role).

**Worked example (feature, in_progress):**

```
BAS-2 · Implement JWT middleware · feature · in_progress
Objective: Implement Express middleware that validates JWT tokens…
Acceptance: 3 of 5 checked
Workspace: /Users/me/myapp · feat/jwt · /Users/me/myapp/.worktrees/feat/jwt
Depends: BAS-1 done
Files:
  ticket.md  kernel · editable
    JWT middleware for protected routes
  plan.md  plan · approved
    Implementation plan with tasks and verify steps…
  journal.md  log · 4 entries · last progress 1h
    Append-only log for progress, decisions, handoffs…
Handoff: none
Log: last 3 entries
  ## 2026-03-18T14:00:00Z · progress · cursor — Wired refresh rotation
Stage: in_progress. Implement the approved plan task by task…
Next: syntaur review BAS-2
Commands: syntaur log BAS-2 -t progress "…"; …
```

---

## 8. Needs me and the board

**Needs me tiers:**

| Tier | Source |
|------|--------|
| 0 | Unsettled permission/ask cards (chat) |
| 1 | Chat replies owed |
| 2 | Open `question` log entries |
| 3 | Unapproved plan-role file |
| 4 | `status: review` |

Snooze keys: `<ID>` or `<ID>~<compact-ts>` (no colons). CLI: `syntaur inbox`; dashboard: **Needs me** page.

**Board:** columns follow global stage order; `done` and `dropped` age out of the default view; `blocked` and `parked` badges do not change column.

---

## 9. Agent surface

**Skills (six):** `syntaur-protocol`, `grab`, `plan`, `done`, `log`, `worktree` — install with `npx skills add prong-horn/syntaur -g -a claude-code`.

**Hooks (three):** SessionStart → `session register`; PostToolUse → `session touch`; UserPromptSubmit → `session context`. No SessionEnd hook.

**Playbooks** live in `~/.syntaur/playbooks/` for Library editing; built-in templates embed condensed content in `stages[].instructions`. Manifest `playbooks:` is documentary.

---

## 10. Timestamps and paths

Timestamps: RFC 3339 UTC (`2026-03-18T14:30:00Z`). Local path fields use absolute expanded paths (not `~`). `workspace.repository` may be a URL. Intra-project links use relative paths.

---

## 11. Versioning

- **Protocol** `"2.0"` in `config.md` `version`.
- **npm package** 1.0.0 for this release line.

### Changes in 2.0 (shipped in 1.0.0)

- Ticket ids `<PREFIX>-<n>`; `assignments/` → `tickets/`; `assignment.md` → `ticket.md`.
- Fixed stages and template manifests; lifecycle verbs and SQLite `events`.
- Log role (`journal.md`) and seven entry types; `syntaur log` only.
- Kernel `chat/`; dashboard ACP chat replaces terminal-launch stack.
- Derived project markdown removed; git-backed home (`init`, `history`).
- Resources/memories subsystems removed; six skills and settings hooks install path.
- Session usage rollups include input/output token split on the Sessions page (carried from 0.80.x).

**Forward compatibility:** optional new fields may appear; tooling should warn on unknown major versions, not crash.
