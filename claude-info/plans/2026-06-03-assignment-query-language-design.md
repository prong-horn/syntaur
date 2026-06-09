# Design: Assignment Query Language + Status History

- **Date:** 2026-06-03
- **Status:** Approved design (pre-implementation)
- **Author:** Brennen + Claude (brainstorming)

## Problem

The current "create views" filtering is not powerful enough, especially for
date-based questions. Today's date filter (`src/utils/view-prefs-schema.ts:48-62`)
allows exactly **one** field (`created` *or* `updated`), **one** constraint per
view, and only fixed presets (`last_24h`/`last_7d`/`last_30d`/`last_90d`/`older_7d`/
`older_30d`) **or** an absolute `from`/`to` range. It cannot express:

- Arbitrary windows ("last **36 hours**" — not a preset).
- Cross-field OR ("created **OR** updated in the last 36h").
- "Completed ≥ 1 month ago" — there is **no completion timestamp at all**;
  assignments carry only `created`, `updated`, `archivedAt`
  (`src/lifecycle/types.ts:59-69`), and `updated` bumps on *any* edit.
- Negation / hide.
- Boolean grouping across fields.

## Goal

A real boolean **query language** over assignments, backed by a **status
transition log** so time-based questions are expressible. The assignment `.md`
file remains the source of truth (git-tracked, human-editable); the query engine
is decoupled from storage.

## Decisions (locked during brainstorming)

1. **Expressiveness:** full boolean expressions (AND/OR/NOT + grouping), not just
   faceted qualifiers.
2. **Time data:** a **full status-transition log** stored in frontmatter (not a
   single `completedAt` field, not a DB). The file stays the source of truth.
3. **No DB for assignments.** SQLite already exists in Syntaur
   (`~/.syntaur/syntaur.db`, used by sessions/leases/proof/usage) but only for
   *operational/telemetry* data that is explicitly not hand-edited or git-tracked.
   Assignment history belongs *with* the assignment, in the file. A DB-backed
   index would only ever be a **rebuildable derived projection** if scale demanded
   it — never a second source of truth. At hundreds-to-low-thousands of
   assignments, in-memory evaluation is sub-millisecond; no index is needed.
4. **Syntax:** hybrid — GitHub-familiar `field:value` atoms + comparison operators
   for dates/durations + explicit `AND`/`OR`/`NOT` and parentheses.
5. **Surfacing:** the query string is the **canonical** filter; chips become a
   visual editor over the chip-representable subset (Option 1). Existing saved
   views upgrade losslessly.

## Architecture — three decoupled layers

```
statusHistory[] in assignment.md      ← data (source of truth, git-tracked)
        │  loader projects rows + derives virtual fields (completedAt, statusAge)
        ▼
in-memory AssignmentObject[]
        ▼
Query engine  (parse → AST → predicate fn)   ← shared, Node + browser safe
        ▲                       ▲
   CLI (--query)          Dashboard (query box + bidirectional chip sync)
```

The engine evaluates against an in-memory array and never knows whether rows came
from scanning `.md` files (today) or a derived index (hypothetical future). That
seam is what keeps a DB optional permanently. The engine module lives under
`src/utils/query/` with **no Node-only dependencies**, mirroring the existing
shared-module pattern (`src/utils/saved-view-builder.ts`, `view-prefs-schema.ts`)
that both the CLI and the dashboard frontend import.

---

## Piece 1 — `statusHistory` (data model)

A new frontmatter field: an array-of-mappings that mirrors the existing
`externalIds` serializer (`src/lifecycle/frontmatter.ts:56-61`).

```yaml
statusHistory:
  - at: 2026-06-01T14:02:11Z   # ISO, canonical UTC via nowTimestamp()
    from: null                 # null only for the creation / seed entry
    to: draft
    command: create            # transition command (start/implement/complete/reopen/seed…)
    by: claude                 # agent/assignee responsible; nullable
```

Entry fields: `at`, `from`, `to` are **required**; `command` and `by` are
recorded when known; `reason` MAY be added on `block` transitions (optional).

### Recording points
- **Creation:** seed one entry at file creation, `to:` the status the assignment
  was created with (template default is `draft`, `src/templates/assignment.ts:61`).
- **Transitions:** append `{ at: now, from: prevStatus, to: targetStatus, command,
  by: agent }` in `executeTransition` and `executeTransitionByDir`
  (`src/lifecycle/transitions.ts:115`, `:203`).
- **`executeAssign` does NOT append** — an assignee change is not a status
  transition.
- **Audit requirement:** implementation must grep every code path that writes
  `status` and ensure each appends an entry (state-machine transitions, archive,
  any direct edit). This audit is a required task in Piece 1's plan.

### New code
- `parseStatusHistory(frontmatter)` — dedicated list-of-mappings parser (the
  `externalIds` parser is the template).
- `appendStatusHistoryEntry(content, entry)` — `updateAssignmentFile` only does
  scalar replacement (`frontmatter.ts:177-179`), so appending to a YAML list
  needs bespoke handling, exactly as `externalIds` / `workspace` already do.

### Migration (one-time)
Scan all `assignment.md` files lacking `statusHistory` and seed a single synthetic
entry:

```
{ at: <updated if current status is terminal, else created>,
  from: null, to: <current status>, command: 'seed' }
```

Rationale: pre-migration history is unrecoverable. Using `updated` for currently
terminal items makes the derived `completedAt` approximately correct; `created`
for non-terminal items is the best available creation anchor. The `command: 'seed'`
marker makes synthetic entries identifiable. **Documented limitation:** old
assignments have no true intermediate history.

### Derived virtual fields (computed by the loader, not stored)
- **`completedAt`** = `at` of the transition into the current status, **iff** the
  current status is terminal (one of `DEFAULT_TERMINAL_STATUSES` = `completed`,
  `failed`, or the configured terminal set). Null if the assignment was reopened
  since (it is not *currently* completed). This exactly matches "currently
  completed, and that completion was ≥ 1 month ago."
- **`statusAge`** (duration) = `now − at(last entry)` = time in current status.
  Enables "`status:review AND statusAge > 3d`" ⇒ in review 3+ days.

---

## Piece 2 — Query engine (hybrid grammar) + CLI

### Grammar
- **Atoms**
  - `field:value` — equality / membership.
  - `field:(a, b)` — IN list (OR within the field).
  - `-field:value` or `NOT field:value` — negation.
  - `field <op> value` — comparison, ops `< > <= >= = !=` (for dates, durations,
    and ordinal `priority`).
- **Booleans:** `AND` `OR` `NOT` + parentheses. Whitespace-adjacent atoms = implicit
  AND. Precedence: `NOT` > `AND` > `OR`; parentheses override. Keywords
  case-insensitive.
- **Values:** bare word; `"quoted string"`; absolute date `YYYY-MM-DD` (compared on
  **local-day** boundaries, consistent with `dashboard/src/lib/assignmentFilter.ts`
  `matchesDateRange`); **signed duration literals** relative to now.

### Duration literals
Relative to "now": `-36h` = 36h ago, `+2d` = 2 days in the future, bare `36h`
treated as "ago". Units reuse the existing `--age` set (`src/commands/ls.ts:21-38`):
`h` (hours), `d` (days), `w` (weeks), `m` (months ≈ 30d), **plus** `mo` (explicit
month alias) and `y` (year ≈ 365d). Smallest unit is hours (no minutes).

A duration literal resolves differently depending on the field it is compared to
— this distinction must be unambiguous in the parser:
- **vs. a timestamp field** (`created`/`updated`/`completedAt`): the literal is a
  *relative point in time* (`now ± duration`). `created > -36h` ⇒ created after
  (now − 36h) ⇒ within the last 36h. `completedAt < -1mo` ⇒ completed before
  (now − 1 month) ⇒ ≥ 1 month ago.
- **vs. a duration field** (`statusAge`): the literal is a *magnitude*, no sign.
  `statusAge > 3d` ⇒ has been in the current status longer than 3 days.

### Field vocabulary
| Field | Type | Notes |
|---|---|---|
| `status` | enum | configured statuses |
| `priority` | ordinal | `low<medium<high<critical`; supports `>=`, etc. |
| `type` | enum | configured types |
| `assignee` | string | `assignee:none` → `__unassigned__` sentinel |
| `project` | string | `project:none` → `__standalone__` sentinel |
| `tag` / `tags` | list | membership (match-any) |
| `archived` | bool | |
| `title` / `search` | substring | case-insensitive |
| `created`, `updated`, `completedAt` | timestamp | comparisons + duration literals |
| `statusAge` | duration | time in current status |

### Evaluator
Parse → boolean AST → compiled `(item: AssignmentObject) => boolean`. Field
resolvers map name → accessor + comparator with coercion (duration → timestamp,
priority → ordinal). Parser returns **structured errors** (position + message:
unknown field, bad duration, unbalanced parens) for the UI to surface.

### Translators (the heart of Option 1)
- **`ViewFilters → query`** — total. Build an AST from the structured filter (AND
  of status IN…, project IN…, tags ANY…, priority IN…, type IN…, assignee IN…,
  `activity`/`dateRange` → time predicates, `search` → title substring), serialize
  to a canonical query string.
- **`query → ViewFilters`** — partial. Succeeds only when the AST is a flat
  conjunction of chip-representable atoms; otherwise returns `null` ⇒ "too complex
  for chips."

### CLI surface
Add `--query "<expr>"` to `ls` (and `views`). Existing flags (`--status`,
`--project`, `--tag`, `--age`) keep working. This proves the engine end-to-end
with zero UI risk.

---

## Piece 3 — Dashboard surfacing (Option 1)

- The query string is the **canonical** filter state. Chips read from and write to
  it via the translators (click a status chip ⇒ edits the AST; type a query ⇒ chips
  reflect it).
- When a query exceeds the chip-representable subset (nested OR/NOT, grouping),
  chips go **read-only** and the raw query is shown (Linear/Height behavior).
- Saved views gain a `query` field alongside `ViewFilters`. The saved-view builder
  already **preserves unknown keys** for forward-compat
  (`src/utils/saved-view-builder.ts:29-35`), so existing views keep working;
  at load, a view without `query` synthesizes one from its `ViewFilters` (the total
  direction). **Migration is automatic and lossless.**
- Query box gets field/value autocomplete.
- The dashboard already filters in memory (`assignmentFilter.ts`); swap in the
  shared evaluator imported from `src/utils/query/`.

---

## Decomposition → three Syntaur assignments

Each is independently shippable and testable, and gets its own spec → plan →
implementation cycle.

1. **`statusHistory` + migration + recording** (foundational, no UI). **Spec'd
   first** — its data-model decisions are load-bearing for everything downstream.
2. **Query engine + CLI** — grammar, parser, AST, evaluator, translators,
   `--query` flag.
3. **Dashboard surfacing** — query box, bidirectional chip sync, canonical-query
   saved views, autocomplete.

## Key trade-offs / accepted limitations

- Migration cannot recover real history for existing assignments (single synthetic
  seed entry; `completedAt` for old terminal items ≈ `updated`).
- v1 `statusAge` answers "time in *current* status" only. "Was in review for X
  even though now elsewhere" needs a history-scanning function — **deferred**; the
  log makes it possible later with no schema change.
- The engine must remain browser-safe (no Node-only deps) because the dashboard
  evaluates client-side.

## Out of scope (v1)

- Sort/grouping are not part of the filter query — they remain separate view config.
- Per-status historical duration queries beyond `statusAge` (current status).
- Any DB-backed index (revisit only if assignment counts reach many thousands).
