# Session↔Assignment Engagement Model — Design

Date: 2026-06-23
Status: design settled, ready to plan. Reviewed twice by Codex 5.5/xhigh (read-only); all
must-fixes folded in below as decided design, not open questions.
Work breakdown: 5 assignments in project `session-engagement-model` (see "Work breakdown" at the end).

---

## Problem

Syntaur binds an assignment to a **directory** via a single scalar `<worktree>/.syntaur/context.json`
(`projectSlug`/`assignmentSlug`/`assignmentDir`). When two assignments are worked in the **same
worktree**, the second `grab-assignment`/`set-workspace` **clobbers** the first's binding, and every
cwd-resolved CLI command (`capture`, `progress`, `proof`, …) then attributes work to whichever
assignment wrote `context.json` last. A scalar file cannot represent the real relationship, which is
**many-to-many: sessions ↔ assignments**.

Adjacent goals this design also serves:
- Track **which session did which stage** (planning vs implementing vs reviewing).
- Make **per-stage cost** (plan vs implement vs review) computable.
- Stop **status drift** — status is hard to keep current today because some derive-engine facts are
  self-reported.

## Verified facts about the existing codebase

(Corrected after review; verify again before implementing each piece.)

1. **Session DB** — `src/dashboard/session-db.ts:10,17,51`: SQLite `~/.syntaur/syntaur.db`, WAL,
   `sessions` schema v5, PK `session_id`; columns incl. `project_slug`, `assignment_slug`, `path`,
   `pid`, `pid_started_at`, `transcript_path`, `original_head_sha`.
2. **Binding queries are keyed by `session_id`/`project_slug`/`assignment_slug`**
   (`src/dashboard/agent-sessions.ts:177,297`) — no cwd-keyed lookup for the assignment binding.
   NOTE: usage attribution *does* use a cwd fallback (`sessions.path = cwd` + time window,
   `src/usage/session-join.ts:69,96`), so cwd stays a join key for usage.
3. **`context.json` is a scattered fallback binding.** ~6 sites use `resolveAssignmentTarget`
   (`src/utils/assignment-target.ts:152`): `capture`, `proof`, `open`, `timeline`, `recompute`.
   Others hand-roll their own context reads — at least `progress` (`commands/progress.ts:15`),
   `workspace` (`:15`), `plan` (`commands/plan.ts:26`), `worktree` (`commands/worktree.ts:51`),
   `session` (`commands/session.ts:205`), `track-session` (`commands/track-session.ts:41`).
4. **`context.json` presence gates `workspaces-only` autotrack** (`src/sessions/scanner.ts:158,251`),
   but the **default autotrack is `'all'`** (`src/utils/config.ts:266`).
5. **Identity is resolvable but not always, and not uniformly trustworthy.** `resolveOwnSessionId`
   (`src/utils/session-id.ts`) prefers process/env over the legacy hint, but layer 3 is unimplemented
   (`:161`), the cwd transcript scan is "ambiguous under co-tenancy" (`:16`), and the legacy hint is
   still passed by real callers (`track-session.ts:41`, `session.ts:222`). It currently returns a
   bare `Promise<string | undefined>` (`:228`) with no provenance.
6. **Status is derived but stored**, not computed live. `recomputeAndWrite` writes `status`
   (`src/lifecycle/recompute.ts:277`); today's activity facts are assignment **frontmatter booleans**
   (`src/lifecycle/facts.ts:271`, `frontmatter.ts:349`); implicit recompute is gated until migration
   (`recompute.ts:67`); the path has per-assignment locking (`:203`) and skips writes when dimensions
   don't change (`:251`). Adding engagement-sourced facts is therefore not a pure source-swap.
7. **Usage is cumulative, not interval deltas.** `usage_events` PK `(session_id, model)`, UPSERT
   "mutable snapshot of cumulative tokens" (`src/db/usage-db.ts:8-13,53`). A single cumulative row
   cannot be retro-split across stages by a time-overlap join.

## Core idea

Stop binding assignment to **directory**. Bind it to the **session** via an explicit M:N **edge**,
modeled as append-only time intervals. The worktree becomes plain data on the session, never a key.

## Data model

### Entities

- **Assignment** — markdown files (git-tracked, human-editable). Identity = uuid/slug. Unchanged.
- **Session** — a running agent instance; identity = runtime session UUID; owns pid/liveness/
  transcript/cwd. cwd is **data on the session**, never the binding key.
- **Engagement** — the M:N edge as append-only intervals:

  ```sql
  engagement(
    id              PK,
    session_id      ,   -- the actor
    assignment_id   ,   -- resolved id (slug fields preserved for unattributed rows)
    stage           TEXT NOT NULL DEFAULT 'implement',  -- plan | implement | review | …
    started_at      ,
    ended_at        ,   -- NULL = open/active
    tokens_at_open  ,   -- JSON: per-(model) cumulative snapshot at open
    tokens_at_close ,   -- JSON: per-(model) cumulative snapshot at close
    close_reason        -- switch | completed | liveness_gc | abandoned
  )
  ```

### Invariant: one OPEN engagement per session

```sql
CREATE UNIQUE INDEX one_active_per_session ON engagement(session_id) WHERE ended_at IS NULL;
```

"What is session S working on now?" = its row with `ended_at IS NULL`. Switching assignment OR stage
is the same transaction (close current, open new), capturing both token snapshots:

```sql
UPDATE engagement
   SET ended_at = :now, tokens_at_close = :fresh_snapshot, close_reason = 'switch'
 WHERE id = :open_id AND started_at = :open_started_at AND ended_at IS NULL;   -- compare-and-close
INSERT INTO engagement(session_id, assignment_id, stage, started_at, tokens_at_open)
VALUES (:s, :a, :stage, :now, :fresh_snapshot);
```

Two assignments in one worktree ⇒ two sessions ⇒ two open engagements keyed by session — no
collision. The scalar assignment binding columns move **off** `sessions` onto `engagement`.

> **Compare-and-close** (`id` + `started_at` + `ended_at IS NULL`) is mandatory on every close so a
> liveness GC racing a user switch/completion cannot overwrite an already-closed interval.

## Identity & attribution

### Provenance, not just an id

`resolveOwnSessionId` must return `{ id, provenance }`. Classification:

| Provenance | Source | May silently mutate assignment state? |
|---|---|---|
| **STRONG** | env var, ancestor-process marker | yes |
| **EXPLICIT** | `--session-id` / side-channel | yes |
| **WEAK** | transcript-scan, legacy `context.json` hint | **no** — require `--assignment`/selector or fail |

### Resolution order for a command's target

1. explicit arg / `--project + slug`
2. the resolved session's **open engagement** (only if provenance is STRONG/EXPLICIT)
3. `.syntaur/context.json` **workspace marker** only — never an authoritative active-assignment scalar

### Ambient vs targeted commands

- **Ambient** (no target): resolve own session → its open engagement → that (assignment, stage).
- **Targeted** (`syntaur capture --assignment B`) while engaged on A: record the artifact against **B
  without switching** the open engagement. **Tokens are charged to the ambient stage (A)** — that's
  where the compute physically happened; the artifact is merely filed against B.
- Only stage/assignment-change commands perform the close+open transition. Targeted commands never
  silently mutate the open engagement.

### No-session / bare-human CLI

`context.json` is kept **only** as a per-directory **workspace marker** (repository / branch /
worktreePath / "this is a workspace"). With no resolvable session, a **mutating** command resolves a
target only if exactly one assignment is unambiguous; otherwise it **fails with a selector**. A
most-recently-used heuristic is offered only as a *displayed suggestion for read-only commands*,
never an implicit choice for mutations. (A scalar active-assignment fallback is rejected — it just
relocates the clobber bug.)

## Stage → Fact → Status

Status already = projection of facts (fact #6). The change: source the **activity-type facts** from
engagement **stage-open** events instead of self-reporting. Status follows automatically; drift dies.

| stage-open event | fact asserted | clearing |
|---|---|---|
| `plan` opened / plan approved | `planExists` / `planApproved` | invalidated by replan |
| first `implement` opened | `implementationStarted` | monotonic |
| `review` opened | `reviewRequested` | see rework rule |
| worktree bound | `workspaceSet` | current-state (not engagement-sourced) |

Rules:
- **Facts are asserted by stage-OPEN events and are monotonic or explicitly cleared.** Engagement
  **close** (including liveness GC) NEVER retracts a fact or changes status.
- **Scope:** only the **session-stage facts** (`implementationStarted`, `reviewRequested`) are
  engagement-sourced. Current-state facts (`workspaceSet`, `acAllChecked`, `planApproved`,
  `depsSatisfied`, `blocked`, `parked`, `pinned`) keep their existing sources — they are not
  monotonic history and must not be driven from append-only events.
- **Rework / review derivation.** The default review rung is
  `acAllChecked:true OR reviewRequested:true` (`src/utils/derive-config.ts:67`), so clearing
  `reviewRequested` alone does **not** leave review when ACs stay checked. Add a `reworkRequested`
  fact and change the rung to `(acAllChecked:true OR reviewRequested:true) AND NOT reworkRequested:true`.
  Set `reworkRequested` when a new `implement` engagement opens after review; clear it when review is
  re-requested.
- **Recompute trigger.** A stage-open transition that asserts a new fact triggers `recomputeAndWrite`
  for the affected assignment. Close/switch transitions that assert no new fact do **not** recompute.
  Reuse the existing per-assignment lock (`recompute.ts:203`) and no-op-when-unchanged (`:251`); the
  writer must decide explicit-action vs implicit-trigger w.r.t. the migration gate (`:67`, gated in
  callers like `dashboard/server.ts:845` and `recompute --if-migrated`).
- Judgment/terminal states (`blocked`/`parked`/`done`/`failed`) stay explicit via the existing
  `override`; terminal defers derivation. Multi-session concurrency on one assignment is handled by
  the existing "highest-satisfied-rung-wins" ladder.

## Cost-per-stage

Because per-session engagements are non-overlapping intervals, **stage cost = tokens_at_close −
tokens_at_open** per engagement, summed by stage. This sidesteps the cumulative `usage_events`
limitation (fact #7) — we never retro-split a single cumulative row.

**Capture cannot be deferred; only reporting can.** Snapshots must be taken at every transition from
a **fresh / current** cumulative source (not a stale `usage_events` row), and not re-read after later
collector activity (which would over-attribute to the just-closed stage). The reporting query/UI is
out of scope for now.

## Liveness-driven engagement auto-close (agent-view spike fold-in)

The spike `spike/agent-view-sync` (commit `1e27330`, **not on main**) is a session-**liveness** layer:
`claude agents --json` Agent View as a better liveness source; Codex has no live feed, so a
**scheduled `syntaur session scan`** (not hooks — Codex `SessionEnd` doesn't exist and `Stop` is
turn-scoped). Two seams:

- **Seam 1 — single `sessions` migration:** remove the scalar assignment binding (→ engagement) AND
  add the spike's `activity` column in one migration.
- **Seam 2 (deliberately narrow) — liveness closes dangling INTERVALS only.** A dead session's open
  engagement is closed for hygiene (free the one-open slot) and to bound its cost window:
  `close_reason='liveness_gc'` + a `tokens_at_close` snapshot, via compare-and-close, requiring strong
  dead-evidence (especially for Codex). It does **NOT** retract facts or change status. It is
  **idempotent**: a live session whose engagement was wrongly closed simply opens a fresh one on its
  next command — no status damage either way, because facts are untouched. Reuse the scanner's
  pid-then-transcript race mitigation (`scanner.ts:323`) and the 45s autodiscovery loop
  (`autodiscovery.ts:76`); the scheduled scan covers dashboard-off.

## Migration

Backfill synthetic engagements from existing `sessions` rows: resolve `assignment_id` from
`project_slug`/`assignment_slug` **before** dropping those columns; live `active` rows → open
engagements; `stopped`/`completed` → closed intervals (`ended`, else transcript-mtime/updated/started
fallback). **Expect a large unattributed bucket** — a real sample of `~/.syntaur/syntaur.db` had
**1,367** session rows, **401** with assignment slugs, only **362** resolving to existing assignment
files (966 with no slug). Unresolved rows preserve their slug fields or land in an explicit
"unattributed" bucket; this is the common case, not an edge case.

## Decided design (formerly open questions)

- `reviewRequested` clears only via explicit lifecycle events (new `implement` after review / replan /
  explicit clear), enforced through the `reworkRequested` fact + rung change above. Never on close.
- Per-stage cost: snapshot-at-transition (fresh source) now; reporting deferred.
- No-session fallback: workspace marker only; ambiguous cwd → fail with selector (read-only MRU
  suggestion allowed).
- Targeted commands: tokens → ambient stage; artifact → explicit target. No silent switching.
- Engagement-sourced facts limited to session-stage facts; current-state facts keep their sources.
- Identity must carry provenance; only STRONG/EXPLICIT may mutate assignment state.

## Non-goals

- Rewriting the spike — its cross-agent liveness plumbing is taken as-is.
- Building the cost-per-stage *report* now — only snapshot capture is in scope.
- Removing `context.json` wholesale — its per-directory workspace-marker role stays.

## Work breakdown (assignments in `session-engagement-model`)

```
session-identity-provenance ─────────┐                 (no deps)
                                      ▼
engagement-model-session-assignment-edge   (no deps — FOUNDATION)
   │            │            │
   │            │            └──────────► liveness-engagement-autoclose   (deps: edge)
   │            └───────────────────────► stage-fact-status-bridge        (deps: edge)
   └────────────────────────────────────► engagement-attribution-command-rewiring
                                            (deps: edge + provenance)
```

1. **`engagement-model-session-assignment-edge`** (high) — engagement table, one-open invariant,
   single `sessions` migration (+`activity`), backfill w/ unattributed bucket, token-snapshot capture.
2. **`session-identity-provenance`** (high) — `{id, provenance}` resolver + confidence gate.
3. **`engagement-attribution-command-rewiring`** (high) — resolve from open engagement, rewire
   commands, ambient/targeted semantics, no-session selector, `context.json` → workspace marker only.
4. **`stage-fact-status-bridge`** (medium) — stage-open→fact, `reworkRequested` rung fix,
   fact-changing-only recompute trigger.
5. **`liveness-engagement-autoclose`** (medium) — land the liveness spike + engagement GC (Seam 2).

`engagement-model-...` is the foundation; `session-identity-provenance` is independent and can be
worked in parallel first.
