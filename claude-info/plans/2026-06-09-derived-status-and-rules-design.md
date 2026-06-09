# Design: Derived Status + Rules (extends the Assignment Query Language design)

- **Date:** 2026-06-09
- **Status:** Design v3 — APPROVED for implementation (two codex review rounds folded in)
- **Author:** Brennen + Claude (brainstorming)
- **Builds on:**
  - `2026-06-03-assignment-query-language-design.md` (AQL) — Piece 1 (`statusHistory`)
    **already implemented** on branch `feat/assignment-status-history-log` (8 commits,
    tested, code-reviewed; merges clean vs main per `git merge-tree`); Piece 2 (query
    engine) and Piece 3 (dashboard query UI) not built.
  - `scratch/2026-05-08-syntaur-extensibility-design-memo.md` — leases **built**
    (`src/db/leases-db.ts`); jobs (v2) **not built**.

## Revision history

**v3 (post codex round 2; final pre-implementation).**
1. **Dimension-aware `statusHistory`.** Entries gain optional
   `phaseFrom/phaseTo/dispositionFrom/dispositionTo`; `from`/`to` remain the headline
   status. Backward compatible (old entries are headline-only). `statusAge` = time
   since last entry where `from != to`; new `phaseAge` virtual filters on phase change.
2. **The ladder is ordered and regressible, not monotonic.** Regression (replan
   invalidates approval → phase drops) is intended and recorded like any transition,
   with `cause`. "Highest satisfied rung wins" already evaluates regressions correctly;
   "next" remains the rung above the current one.
3. **`status` IS the effective headline** (override folded in at write time). No
   second `effective` field for boards to ignore. The un-overridden derived headline is
   carried in API payloads only, for the "pinned to X — would otherwise be Y" display.
4. **No terminal boolean facts.** Terminal statuses are reached only via the existing
   gated `complete`/`fail`/`reopen` transitions (mutual exclusion is structural — one
   status field; linked-todo side effects stay in `executeTransition`,
   `transitions.ts:18`). Derivation **defers to terminal**: a terminal assignment is
   not re-derived until `reopen` moves it out. Override may not target a terminal
   status and may not be applied to a terminal assignment.
5. **Concurrency specified** (was "use a lock"): per-assignment advisory lockfile +
   content-CAS with bounded retry + startup reconciliation sweep. See Piece 3.
6. **Time-based facts drive payload-only flags, never persisted dimensions.** Kills
   self-oscillating rules (`statusAge > 3d` resetting itself), file churn from sweeps,
   and the periodic-write problem in one move. No timer ever writes a file.
7. **`planApproval` (asserted record) split from `planApproved` (derived bool).**
8. **Honest audit scope:** `statusHistory` is the audit for dimension transitions.
   Fact-level changes are NOT separately audited in v1 (`~/.syntaur` git backup is
   optional/on-demand, so "git history" is not claimed as a guarantee).
9. **Phase value namespace = configured status definitions** (no new `building` /
   `in_review` ids); ladder/disposition rules are validated against `statuses.definitions`;
   the Settings config writer is fixed to **preserve** the new keys (today it rebuilds
   the block and would delete them, `config.ts:1437`).
10. **Phase 2 wording fixed:** job dedupe prevents duplicate *enqueue*; once-only
    *execution* comes from atomic job claim + idempotent handlers. Leases guard the
    **dev-env the picked agent works in**, not pickup itself.

**v2 (post codex round 1).** Orthogonal phase ⊥ disposition; placeholder-AC and
`implementationStarted` facts; recompute trigger coverage; revision-bound plan
approval; fact-seeding migration; server-side fact materialization; build on the
status-history branch. (Superseded details: single first-match table; scalar-only
history; terminal booleans; "monotonic" ladder.)

---

## Problem

Two problems, one root cause.

**1. Playbooks have drifted.** Playbooks were meant to *chain skills and workflows*
(`e2e-dev-cycle.md` is a real procedure). Most are instead standing **rules**
(`keep-records-updated`, `workspace-before-code`, …) — condition→action policies with
no start or end, cited *by* real playbooks as cross-cutting concerns, toggled via
`playbooks.disabled`. Different primitive, same folder.

**2. Status is low-resolution, overloaded, and set by unreliable prompting.** Status
is **set by commands** with fixed targets (`src/lifecycle/state-machine.ts:4`);
*"workflow enforcement is handled via agent prompting, not code guards"* (the
dashboard separately enforces a `from:command` table, `state-machine.ts:23`). Getting
the right command run at the right moment depends on an agent remembering a playbook.
And one `status` enum encodes several independent dimensions — progress, blockage,
review — which collide (blocked erases how-far-along). This blocks **meaningful
views** ("where is everything, what's next") and the longer-term goal: **agents
watching status changes and autonomously picking up tickets.**

Root cause: imperative, overloaded, asserted status. Fix: status **derived from
facts**, modeled as **orthogonal dimensions**; the "rules" people stuffed into
playbooks are mostly status-derivation rules and dissolve into the derive config.

---

## Goal

Status derived from observable facts, split into orthogonal dimensions, so that:
status is always accurate; views slice on phase, disposition, and raw facts
independently; "what's next" falls out of the phase ladder; and the change stream
(`statusHistory`) is observable for future autonomous pickup. The condition grammar,
field vocabulary, and transition log are **AQL's** — one engine, many consumers.

---

## The model

### Dimensions

- **`phase`** — an **ordered, regressible ladder** of progress. The highest rung whose
  AQL condition holds wins. Regression is legitimate (replan → approval invalidated →
  drops from `in_progress` back to `planning`) and is recorded with a `cause`.
  Each rung carries a `next:` label → "what's next" = the label of the rung above the
  current one. Phase ids come from `statuses.definitions` (no parallel namespace).
- **`disposition`** — orthogonal: `active | blocked | parked | terminal`. First match
  wins. Never erases phase: `disposition:blocked AND phase:ready_to_implement` is
  directly queryable.
- **flags** — payload-only booleans for views (`stale`, `needsReview`, `depsBlocked`).
  All **time-based** facts land here and only here.
- **`status` (headline)** — the single-column board projection, written to
  frontmatter: terminal/blocked/parked dispositions show themselves; otherwise the
  phase shows. **Override is folded in at write time** — `status` is always the
  effective value every existing reader already consumes
  (`AssignmentsPage.tsx`, `statusline.sh`, external tools). The un-overridden derived
  headline travels in API payloads as `derivedStatus` for the divergence display.

### Facts

**Objective facts** — materialized server-side (extend the branch's
`deriveStatusVirtuals` loader pattern, `dashboard/types.ts:229`: "loader-derived, NOT
stored"); the browser never reads the filesystem:

| Field | Type | Definition |
|---|---|---|
| `hasRealObjective` | bool | objective filled, not the template placeholder (mirror `migrate-statuses.ts:25` logic) |
| `acRealTotal` / `acRealChecked` | int | non-placeholder ACs only (template seeds `- [ ] <!-- criterion N -->`, `templates/assignment.ts:36`) |
| `acAllChecked` | bool | `acRealTotal > 0 AND acRealChecked == acRealTotal` (precomputed; leaves stay `field OP literal`) |
| `planExists` | bool | sibling `plan.md` / `plan-v*.md` present |
| `planApproved` | bool | `planApproval` record matches the **current latest** plan file **and** its digest |
| `workspaceSet` | bool | `workspace.repository` AND `workspace.branch` present (worktreePath is legitimately null per Workspace Before Code) |
| `implementationStarted` | bool | asserted flag (explicit `implement` CLI assertion; worktrees precede planning, so `workspaceSet` ≠ building) |
| `depsSatisfied` | bool | all `dependsOn` terminal (`checkDependencies`); terminal transitions trigger reverse-dependent recompute |
| `unresolvedQuestions` | int | open `question` entries in `comments.md` |
| `statusAge`, `phaseAge`, `progressStaleDays` | duration | **time-based → flags only, never phase/disposition inputs** |

**Asserted facts** — frontmatter, CLI-set (uniform across agents):

| Field | Set by | Notes |
|---|---|---|
| `blockedReason` | `block`/`unblock` (exists) | presence → `disposition: blocked`; migration seeds `"(unknown)"` where absent |
| `planApproval` | new `plan approve`/`unapprove` | record `{file, digest, by, at}`; auto-invalidates on replan or edit (digest mismatch) |
| `implementationStarted` | new `implement` assertion | bool |
| `parked` | new `park`/`unpark` | `disposition: parked` |
| `reviewRequested` | new `request-review` | feeds the review rung |
| `override` | `status pin`/`unpin` | `{status, source, reason, at}`; **non-terminal targets only; not applicable to terminal assignments** |

Terminal is **not** a fact: `completed`/`failed` remain command-gated transitions
(`complete`/`fail`/`reopen`) with their existing side effects; derivation defers.

### Derive config (in `statuses:` block of `config.md`)

```yaml
statuses:
  definitions: [ ... unchanged ... ]
  order: [ ... unchanged ... ]

  phaseLadder:        # ordered low→high; HIGHEST satisfied rung wins; regressible
    - phase: draft               when: "*"                                        next: "fill objective + acceptance criteria"
    - phase: ready_for_planning  when: "hasRealObjective:true AND acRealTotal > 0" next: "write a plan"
    - phase: planning            when: "planExists:true"                          next: "get the plan approved"
    - phase: ready_to_implement  when: "planApproved:true"                        next: "start implementing"
    - phase: in_progress         when: "planApproved:true AND implementationStarted:true" next: "finish ACs, request review"
    - phase: review              when: "acAllChecked:true OR reviewRequested:true" next: "complete or address review feedback"

  disposition:        # first match wins; orthogonal to phase
    - when: "parked:true"        is: parked
    - when: "blocked:true"       is: blocked    # blocked = blockedReason present (precomputed bool)
    - else:                      is: active
    # terminal is not a rule: terminal statuses defer derivation entirely

  headline:           # board projection; ids must exist in definitions
    terminal: passthrough        # completed/failed stay as-is
    parked:  parked              # requires a 'parked' status definition (added by migration)
    blocked: blocked
    active:  phase               # show the phase id
```

Validation: every `phase:`/`headline:` id must exist in `statuses.definitions`;
every `when:` must parse against the field registry. `syntaur doctor` checks both.
**The Settings writer preserves these keys** (fix `config.ts:1437`, which today
rebuilds the block from definitions/order/transitions and would silently delete them).

Default config ships a ladder matching `DEFAULT_STATUSES` (using `review`); Brennen's
config maps the review rung to `code_review`.

---

## Piece 2 — dimension-aware `statusHistory`

Reuses the branch's schema/parser/serializer with **optional added keys**:

```yaml
statusHistory:
  - at: 2026-06-09T18:22:04Z
    from: planning               # headline before   (unchanged semantics)
    to: ready_to_implement       # headline after
    phaseFrom: planning          # NEW, optional — present when phase changed
    phaseTo: ready_to_implement
    dispositionFrom: active      # NEW, optional — present when disposition changed
    dispositionTo: active
    command: derive              # or the CLI verb that caused it (approve/block/pin/…)
    by: agent:claude
    reason: "plan approved (plan-v2.md)"
```

- An entry is appended when **any dimension** changes. A phase change under a
  `blocked` headline is representable: `from: blocked, to: blocked,
  phaseFrom: planning, phaseTo: ready_to_implement` — honest, parseable, no namespace
  mixing.
- **`statusAge`** (branch virtual) = `now − at(last entry where from != to)` —
  corrected from "last entry regardless" so dimension-only entries don't reset it.
  **`phaseAge`** = same over phase fields. Both loader-derived, not stored.
- Old entries (no new keys) parse unchanged; `migrate-status-history` seeding is
  untouched. `renameStatusInHistory` extends to the phase/disposition keys.

---

## Piece 3 — one authoritative mutation protocol

All dimension writes go through a single `recomputeAndWrite(assignmentPath, cause, by)`:

1. **Lock** — per-assignment advisory lockfile (`<assignmentDir>/.derive.lock`,
   `O_EXCL` create with pid+timestamp; stale takeover after 30s). Serializes the CLI
   and the dashboard server (both cooperate by construction — same function).
2. **Read + CAS token** — read `assignment.md`, capture content hash.
3. **Compute** — facts → ladder/disposition/flags → headline → fold override →
   compare with cached frontmatter values.
4. **Write iff changed** — re-verify content hash (a non-cooperating writer — human
   editor — may have raced); on mismatch release, retry from (2), max 3 attempts, then
   surface a doctor warning instead of clobbering. Write `status` (+ cached
   `phase`/`disposition`) via the existing atomic-rename path and
   **`appendStatusHistoryEntry`** (`frontmatter.ts:416` — the same hook
   `executeTransition` uses at `transitions.ts:137/237`).

**Trigger set (complete):**
- **CLI fact mutations** (`approve`, `block`, `park`, `pin`, `implement`, AC edits via
  CLI…) → synchronous recompute of that assignment.
- **Dashboard watcher** (`src/dashboard/watcher.ts` — today broadcast-only) →
  recompute on assignment-file change (catches out-of-band agent/human edits),
  debounced per assignment (settled transitions; no mid-edit flutter).
- **`config.md` watch** (new — not watched today) → recompute **all** (rules changed).
- **Reverse-dependency** — when A goes terminal, recompute all assignments that
  `dependsOn` A.
- **Startup reconciliation** — dashboard server boot runs a full sweep (covers edits
  made while it was down). `syntaur recompute [--all]` exposes the same for headless.
- **Lazy read** — display paths derive in memory; they never write.

**What never happens:** no timer writes files (time-based = payload flags only); no
recompute on a terminal assignment; no write when only flags changed.

---

## Piece 4 — override + governance

- `syntaur status pin <id> <status> [--reason]` / `unpin <id>`: sets/clears
  `override` (non-terminal target; refused on terminal assignments), records source
  (human | agent:<id> from `.syntaur/context.json`) + reason, recomputes, appends
  history (`command: pin|unpin`).
- Fact-based dispositions self-clear (`blocked` ↔ `blockedReason`); only `override` is
  sticky — and visibly stale: payloads carry `derivedStatus`, the UI shows
  *"pinned to X — would otherwise be Y."*
- **Permissive:** any actor may assert/clear facts and override, by context. Human
  pins are **advisory-respected** (playbook instruction, logged-not-forbidden).
  `agentDefaults.trustLevel` is the future tightening knob; ships permissive.
  Pin churn is debounced with the watcher's settle window.
- **Audit scope (honest):** dimension transitions → `statusHistory` (actor, cause,
  reason). Intra-dimension fact edits are not separately logged in v1; a dedicated
  fact-audit log is future work (git backup is optional and not claimed).

---

## Piece 5 — `planApproval` + migration

**Revision-bound approval.** `syntaur plan approve` writes
`planApproval: {file: plan-v2.md, digest: sha256(plan-v2.md), by, at}`.
`planApproved` (derived) is true iff `file` is still the latest plan revision AND the
digest matches its current content. Replan or post-approval edit → false → phase
regresses (recorded with cause `plan changed`). Re-approval per revision aligns with
the Plan Versioning playbook.

**Migration (`syntaur migrate-derive`, one-time, idempotent):**
- Seed `blockedReason: "(unknown)"` where status is `blocked` without a reason.
- Seed `implementationStarted: true` where status is currently
  `in_progress`/`code_review`/`review` (preserves existing forward state — review
  round-2 finding: don't lose implementation/review standing).
- Seed `reviewRequested: true` where status is currently `code_review`/`review`.
- Add a `parked` status definition if `headline.parked` maps to one and it's missing.
- Terminal assignments: untouched (derivation defers to them).
- Recompute all; emit a **divergence report** (old stored vs newly derived) for
  spot-check. Statuses are **re-derived, not auto-pinned**.

---

## Piece 6 — views & CLI

Facts + dimensions are AQL fields; the engine (AQL Piece 2, `src/utils/query/`,
browser-safe) serves derive rules, `ls --query`, and dashboard filters alike:

- `disposition:blocked AND phase:ready_to_implement` — blocked but otherwise ready.
- `planApproved:true AND workspaceSet:false` — approved, no workspace.
- `phase:planning AND statusAge > 3d` — stuck planning (read-time flag, no persistence).
- Boards group by `phase`; each column's `next:` label is the per-column call to action.

**In scope now:** query engine, `ls --query`, facts/dimensions/divergence in dashboard
payloads, detail-page dimension display. **Separate follow-up assignment (as AQL
Piece 3 always was):** query box, chip sync, derive-rule editor UI.

---

## Phase 2 — autonomous pickup (sketch; needs the jobs primitive)

- A **settled** dimension transition (from the authoritative write path, not
  watcher-tailing) **enqueues a durable job** (memo jobs table,
  `dedupe_key = assignment+transition`) — durable, replayable, dashboard-down safe.
- Dedupe prevents duplicate **enqueue**; once-only **execution** comes from atomic job
  claim + idempotent handlers (memo's at-least-once semantics respected).
- The picked agent then **claims a lease for its dev-env** (leases' built purpose).
- Override gates autonomy for free: `parked`/`blocked` keep the headline out of the
  eligible set.

---

## Trade-offs / accepted limitations

- `status` is a cache/projection; source of truth = facts + rules (in-file, rebuildable).
- A stale override persists until cleared — mitigated by always-visible divergence.
- Fact-level audit deferred; `statusHistory` covers dimension transitions only.
- Non-cooperating writers can race the lock — bounded-retry CAS narrows, doesn't
  eliminate; residual risk surfaced via doctor, accepted for single-host files.
- Config-edit recompute-all may rewrite many assignment files at once — correct
  (the rules changed) and documented.

## Out of scope (v1)

Reactive pickup (Phase 2; jobs), guard + advisory layers for the remaining ex-playbook
rules, auto-clearing override predicates, dedicated fact-audit log, chips/query-box UI
(follow-up assignment), any SQLite assignment index.
