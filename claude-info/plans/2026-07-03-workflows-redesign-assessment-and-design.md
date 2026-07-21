# Workflows Redesign — Assessment & Design Proposal (v2)

**Date:** 2026-07-03
**Status:** Assessment + design direction, **adversarially stress-tested** (v2). Not yet an implementation plan.
**Prompted by:** "The workflows feature just isn't good. Facts, derive rules, the graph, transitions — it's all really confusing. I want to define workflows that different agents can use depending on the ticket, assign agents/skills/playbooks to stages, and eventually drop a ticket on a workflow and have agents move it state to state until it's done."

**Revision history:**
- **v1** (2026-07-03): initial assessment + stage-centric redesign, judgment-check addendum.
- **v2** (2026-07-03): four independent adversarial reviews (engine model, judgment checks, migration/compat, dispatch/autonomy), each grounded in code with file:line evidence. 7 blockers and ~15 serious gaps found and folded in. The core architecture survived; the semantics are now pinned down. See "Stress-test record" at the end for what was attacked, what landed, and what didn't.
- **v2.1** (2026-07-04): dispatch exec story revised — Claude-profile agents ride Claude Code's native background-agent surface (`claude --bg` + `claude agents --json` + hook-based acks; `claude -p` for judge runs) instead of a bespoke headless runner. 4b shrinks to non-Claude exec adapters. Verified against claude CLI 2.1.201 and the official agent-view/headless docs (not tmux-based — a Claude Code daemon manages the detached sessions).

---

## Part 1 — Diagnosis: why it's confusing

### 1.1 It was built three times, and all three builds are still live

| Era | What it added | Vocabulary it introduced | Still present? |
|---|---|---|---|
| Apr 2026 — customizable statuses | `statuses:` block, `from:command → to` transition table | status, command, transition, terminal | Yes — the Statuses + Transitions tabs |
| Jun 9 2026 — derived status v3 | facts, phase ladder, disposition, headline projection, AQL conditions, pin/override, recompute | fact, phase, rung, disposition, headline, derivedStatus, pin | Yes — the Derive Rules + Facts tabs |
| Jun 23 2026 — engagement model | session↔assignment edges with *stages* (plan/implement/review), stage-fact bridge | stage (a fourth meaning of "where is this ticket") | Yes — feeds `implementationStarted`/`reviewRequested`/`reworkRequested` |
| Jul 1 2026 — multiple workflows | named bundles of all of the above, binding chain, board modes | workflow, binding, resolvedWorkflow | Yes — the switcher + swimlanes |

None of the earlier layers were retired or re-conceptualized when the next landed. The result is that **the UI exposes the implementation history, not a concept**: the `/workflow` page's four tabs (Statuses · Transitions · Derive Rules · Facts) are literally the four internal subsystems in the order they were built. To express one coherent thought — *"tickets go to review when the plan is approved and the ACs are done, and my review agent handles them"* — you must touch all four tabs, and the "who handles it" part has no home at all.

### 1.2 Two engines fight over `status`, and the UI doesn't say which one moved your ticket

- **Commands** (`start`, `implement`, `complete`, …) write status directly. The CLI is *deliberately guard-free* (`state-machine.ts:9` — "workflow enforcement is handled via agent prompting, not code guards"), so the transition table you edit in the Transitions tab **only gates the dashboard's kanban picker**. Agents never see it. The graph is a picture of rules that mostly don't execute.
- **The derive engine** *also* writes status: `recomputeAndWrite` evaluates the phase ladder over facts and overwrites `status` whenever a fact changes.
- Plus **pins** (sticky overrides) and **terminal freezing** (complete/fail are command-only; derivation defers).

So "why is my ticket in this column?" has four possible answers, and nothing on the board or ticket page tells you which one applied. This is the single deepest source of the "confusing as hell" feeling: the system has no single mover.

### 1.3 The phase ladder is a ranking function, not a flow

"Highest satisfied rung wins" answers *how far along is this ticket* — it recomputes absolute position from scratch on every change. But users (and your stated goal) think in *flows*: what path does the ticket take, what happens next, can it loop. A ladder structurally cannot express loops or path-dependence, which is why `reworkRequested` had to be invented — a patch-fact whose only job is to give the memoryless ladder memory ("we went back after review"). Every future flow feature would need another patch-fact. That's the tell that the core abstraction is wrong for the goal.

A second tell, found during the v2 ground-truth check: the live default workflow defines 11 statuses but the ladder only ever *produces* some of them — `planning` and `code_review` are defined columns that no rung emits and no default transition reaches. They are dead columns today unless pinned. The current model can't even keep its own status set reachable.

### 1.4 Vocabulary sprawl

Seven-plus words describe aspects of "where is this ticket": `status`, `phase`, `disposition`, `headline`, `derivedStatus`, engagement `stage`, `workflow`, plus `type` keying the binding. Specific collisions found in the UI audit:

- **"Done" vs `terminal` vs `completed`** — three names for one concept (`StatusDefinitionsSection.tsx:120-137`).
- **Two panels both titled "Facts"** — the editor's declaration tab and the ticket's runtime panel (`FactsSection.tsx:58`, `FactsPanel.tsx:35`).
- **"stage" (engagement: plan/implement/review) vs "phase" (ladder rung)** — different axes, near-synonym names, and phase values are status ids so `in_progress` is simultaneously a status, a phase, and implied by an engagement stage.
- **`implement`** is a CLI command, an engagement stage, and a ladder condition input.
- Derive-tab jargon (*rung, disposition, headline projection*) is disconnected from the rest of the app's language.

### 1.5 Split-brain defects (found during this review)

1. **`syntaur status` edits a config block that no longer exists.** It reads/writes only the legacy top-level `statuses:` block (`status.ts:66-72`), which the multi-workflow migration lifted into `workflows.default` and deleted. Today `syntaur status list` reports the built-in 6-status default instead of the real 11-status config, every mutating verb errors with "Run `syntaur status init` first," and running `init` would create a **second, conflicting source of truth** that `getWorkflowLibrary` ignores. No doctor check catches this.
2. **`complete`/`fail`/`reopen` are workflow-blind.** `runTransition` (`_lifecycle-helper.ts:29-68`) never threads the per-workflow transition table or terminal set into `executeTransition`, so custom workflows with renamed terminal statuses silently don't work from the CLI — while the derive verbs *are* per-workflow-correct. Worse (v2 finding): `executeTransition` itself takes **no lock and no CAS** (`transitions.ts:105-221` — plain read + `writeFileForce`), so the terminal path sits entirely outside the mutation protocol.
3. **Kanban grouping contradiction.** The global Assignments board's dropdown disables "Group: Workflow" in kanban ("list only", `AssignmentsPage.tsx:1484-1490`) while the same page's renderer supports it (`:1768-1790`) and ProjectDetail offers it as a normal option (`ProjectDetail.tsx:797-800`).
4. **No CLI can edit a workflow's contents.** `syntaur workflow` manages the library (new/delete/bind); statuses/transitions/derive/facts are dashboard-only — bad for the agent-first product story.
5. UI polish gaps: `window.prompt`/`window.confirm` for workflow create/duplicate/delete; saved status IDs can't be renamed (delete + orphan-resolution modal instead); graph node positions don't persist; ~12 raw backend error codes surface as save-bar copy; standalone tickets can't be rebound.

### 1.6 The feature you actually want was explicitly cut

The multiple-workflows design says: *"Out of scope (YAGNI for v1): Workflow-bound methodology (which playbooks/planning style/review gates apply per type)… Explicitly deferred; this feature is lifecycle-only."* Meanwhile the ingredients already exist as disconnected primitives:

- **Agent runner profiles** (Settings › Agents): command + model + editable `launchPrompt` (built). `resolveLaunchPlan` already accepts per-launch `agentId` and `promptOverride` (`launch/plan.ts:88-104`).
- **Playbooks**: global library with manifest, `/run-playbook`.
- **The schedules subsystem** (`src/schedules/`) — *missed in v1, found in the v2 stress test*: a shipped, state-triggered agent dispatcher with `when-status` triggers evaluated as a **cursor over persisted statusHistory** with per-edge dedupe keys (`triggers.ts:152-171`), durable job files, crash-safe claim-before-launch, launch-ack, reaping of dead launches, kill switch, cooldowns, `maxLaunchesPerDay`, and a launchd tick as the always-on floor with the dashboard watcher as a mere accelerator. This is 80% of the dispatcher this design needs.
- **The inbox/attention stack** (`src/inbox/`, `InboxPage.tsx`): triage categories (review, blocked, question, plan-approval) — the natural home for a review queue.
- **Leases**: built, designed explicitly for dev-env pools an agent claims (LRU pool claim — *not* claim-by-name; see §2.7).
- **Events DB**: `status-change` audit events (`event-emit.ts`) — best-effort by design; an audit log, not a delivery mechanism.

Nothing binds any of them to a position in a workflow. That's the gap between what exists and your vision.

### 1.7 What's genuinely good and worth keeping

- **Fact computation** (`facts.ts`) — objective, observable inputs (plan digest, real ACs, deps) instead of self-reports. The right instinct of the Jun 9 design; keep it.
- **Revision-bound attestations** (`binds: plan|commit`) — "approved *this* plan revision / *this* commit" that self-invalidates on change. Quietly the best primitive in the system; §2.5 builds on it (with sharpened semantics).
- **The mutation protocol** (`recomputeAndWrite`: lock + CAS + history + events) — verified sound under racing writers in the stress test; reused as the engine's write path.
- **The resolver seam** (`workflow-context.ts`) — one place resolves ticket → workflow; unchanged.
- **The remap/delete safety machinery** (`status-config-resolution.ts`) — stage-id-agnostic and battle-tested (630 real remap events); reused for stage edits.
- **The schedules subsystem** — see §1.6; Phase 4 generalizes it rather than building a rival.
- **statusHistory + events** — the audit spine.
- **Board modes A/B/C** and the binding chain (ticket → type-map → project default → global default) — fine as designed.

---

## Part 2 — Target model: a stage-centric state machine

### 2.1 North star

> A **workflow** is a map of **stages** a ticket travels through. Each stage answers three questions: **Who works it? What must be true to leave? Where does it go next?** Agents move tickets along the map until they reach a done stage.

One primary noun — **stage** — absorbs status, phase, rung, and column. Everything a stage needs lives *on the stage*, not spread across four tabs.

### 2.2 The shape

```yaml
# ~/.syntaur/workflows/feature.md  (one file per workflow — see §4.6)
id: feature
label: Feature
stages:
  - id: shaping
    label: Shaping
    color: "#64748b"
    guidance: Fill in the objective and acceptance criteria   # per-stage next-action prose
    work: { agent: planner, playbooks: [read-before-plan] }
    gate:
      - check: hasRealObjective        # computed
      - check: acRealTotal > 0         # computed (raw-condition escape hatch)
    next:
      - to: planning
        on: gate                       # auto-advance when the gate passes

  - id: planning
    label: Planning
    guidance: Write a plan and get it approved
    work: { agent: planner, playbooks: [create-and-plan-assignment] }
    gate:
      - check: planExists
      - check: planApproved            # revision-bound — replan re-arms it
    next:
      - to: ready

  - id: ready                          # a WAITING stage — exited by activity, not artifacts
    label: Ready to implement
    next:
      - to: implementing
        on: work-start                 # fires when an agent opens work on the ticket

  - id: implementing
    label: Implementing
    guidance: Finish the acceptance criteria, then reviews run
    work: { agent: builder, playbooks: [e2e-dev-cycle, workspace-before-code] }
    gate:
      - check: acAllChecked
      - not: codeReviewedChangesRequested   # verdict export — holds the ticket here
                                            # during rework; stales when new commits land
    next:
      - to: reviewing

  - id: reviewing
    label: Review
    gate:
      - check: codeReviewed            # JUDGED — someone must render a verdict
        by: not-author                 # implementer can't approve own work
        judge: reviewer                # runner profile that produces the verdict
        binds: commit                  # approval expires when new commits land
      - check: humanSignoff            # judged, by: human — lands in your queue
        by: human
        binds: commit
    next:
      - to: done                       # traversed when the WHOLE gate passes
    on-dissent: implementing           # any valid changes-requested verdict →
                                       # one-shot route back, note attached

  - id: done
    label: Done
    terminal: true
    reopen: ready                      # reopen re-places via the placement function,
                                       # capped at this stage

flags:                                 # orthogonal — badges, never stages/columns
  blocked: { when: blocked }           # pauses auto routes + excludes from dispatch
  parked:  { when: parked }
  hold: {}                             # per-ticket manual "don't auto-advance"
terminal_failure: failed               # `syntaur fail` target, terminal: true
```

### 2.3 Position is stored; movement is guarded. One mover — precise semantics

This reverses the Jun 9 design's core choice, and the stress test confirmed both why the reversal is right and where it must be pinned down.

- **Jun 9's real insight:** gates must be *observable facts*, not agent self-reports — otherwise status rots. **Keep this.**
- **Jun 9's mistake:** deriving *absolute position* from facts on every change (the ladder). Position is path-dependent — loops, rework, deliberate skips — so the memoryless ladder needed `reworkRequested`, the stage-fact bridge, and pins to fake memory.

**The synthesis:** the ticket stores its position (see §4.3: the storage key stays `status:`; "stage" is UI/docs vocabulary). The engine — the *only* mover, running inside the existing `recomputeAndWrite` lock — moves it along declared routes. The stress test forced precision on every rule below; each was a v1 hand-wave that a critic broke.

**Route triggers (four kinds):**

1. **`on: gate`** (default) — auto-advance when the current stage's gate fully passes. Same trigger set as today: fact verbs, file watcher, boot sweep. Forward drift stays structurally dead (verified: the critics' "did not land" list).
2. **`on: work-start`** — fires when a session opens an engagement on the ticket. This is how **waiting stages** (`ready`) are exited: by *activity*, not artifacts. The existing stage-fact bridge fires at exactly the right moment today; it is repointed from asserting `implementationStarted` to traversing this route. *(v2: without this trigger kind, the default config cannot migrate — two of its ladder rungs encode activity, not artifacts.)*
3. **`on: manual`** — an explicit act (`syntaur move`, board drag). Manual moves past a *failing* gate require `--force` and stamp a persistent, queryable **`gate-overridden`** flag on the ticket (card badge + journey rail), self-clearing when the gate later passes. *(v2: without this, manual routes re-import status drift wholesale — a ticket parked in Review with nothing supporting it, silently.)*
4. **Verdict routes** (`on-dissent`, and gate-pass for approval) — see §2.5. **Edge-triggered, one-shot**: a verdict fires its route once, at render time; the firing is recorded (route + the (check, actor, verdict, binding) that caused it goes into the statusHistory entry, not just a best-effort event). A still-valid dissent record does *not* re-fire on re-arrival — it holds the loop-target's gate closed instead (the `not: <check>ChangesRequested` condition), which stales automatically when rework commits land. *(v2: level-triggered verdicts livelock — review→implementing→review ping-pong inside one engine call.)*

**Cascades:** multi-hop auto-advance runs as a fixpoint loop inside ONE lock hold — one history entry per hop, one debounced write and event batch, hard hop cap = stage count. The editor and doctor validate that no cycle of `on: gate` routes has simultaneously-satisfiable gates. Judgment checks are natural brakes (a verdict record can't exist before a judge renders it), so cascades cannot rocket through review.

**Regression:** every move's history entry records a compact **gate-passage snapshot** (check → value at traversal). "A check that admitted this ticket goes false" is then well-defined: the engine re-evaluates traversed-path gates, and on breakage either **flags** ("gate broken: plan changed since approval") or **auto-returns** along a declared loop route — per-check policy, default flag. Skip/`--force` passages are marked `gate-overridden` from the start (they never passed, so they can't "break"). **Terminal stages are exempt**: at the terminal transition the engine snapshots check states into frontmatter and suspends staleness/regression evaluation — otherwise every merged ticket's worktree cleanup would retroactively "break" its review gate. *(v2: all three rules were unspecified; the terminal one would have flooded the board with false flags on completed work.)*

**Staleness triggers:** commit-bound check validity is evaluated on every read path (payloads render flags live) and persisted on the next write; proactive detection comes from the dispatcher tick's HEAD poll over bound workspaces (and optionally a git post-commit hook installed at workspace-bind time). *(v2: nothing else fires when a commit lands — the file watcher watches `~/.syntaur`, not git repos; without this the design's flagship regression example never fires in real time.)*

**Ratchet protection:** advancing across a gate containing commit-bound judgment checks records the sha it advanced on; if the next evaluation finds the binding mismatched (e.g. a transient `git checkout` made a stale approval momentarily "valid" and a sweep advanced the ticket), the advance is treated as invalid → return, not merely flagged. Comparison is against the **branch tip**, not a checkout-sensitive HEAD.

**Terminal, in-engine:** terminal arrival via any route runs the engine-side terminal hooks after the successful CAS write (same slot as the status event): linked-todo completion keyed on `terminal: true` (not the hardcoded `'completed'`), the terminal disposition cache, and reverse-dependency recompute. Reopen is a declared route out of a terminal stage; its landing spot is computed by the **placement function** (below), capped at the route's target. The lockless `executeTransition` path retires into the engine. *(v2: "reuse recomputeAndWrite verbatim" was an overclaim — the engine hard-defers on terminal while the code that handles terminal today has no lock at all.)*

**The placement function — the ladder's one legitimate job survives:** "enter at the deepest stage whose upstream spine gates all pass" is a one-shot evaluation used in exactly three placement events: migration seeding, reopen, and workflow rebind. It never runs continuously — position stays a pointer. *(v2: the design deleted the ladder without replacing the three cases where position genuinely must be computed.)*

**Flags pause movement:** `blocked`/`parked`/`hold` suspend auto routes (manual moves still allowed) and exclude the ticket from dispatch. *(v2: previously only dispatch was stated.)*

**Rollout gate:** a new `stages-migrated` marker; implicit auto-advance stays dormant until stage seeding completes (same pattern as `derive-migrated`). Doctor checks: unknown/orphaned stored stage id (repair via placement function + report), unreachable stage, no terminal stage, auto-route cycles, gate referencing unknown checks.

**Every move appends** a `statusHistory` entry + event with: the route taken, the trigger kind (gate / work-start / manual / verdict / regression / placement), the gate snapshot, and the actor. "Why is my ticket here?" always has exactly one answer, displayed on the ticket.

### 2.4 Facts become "checks" — a checklist, not a rules engine

Same registry and computation underneath (`facts.ts`, `fact-registry.ts` — all keep working); different presentation:

- A stage's gate is a **checklist** built from a catalog: built-ins (*Plan exists, Plan approved, All acceptance criteria checked, Dependencies satisfied, No open questions, Workspace set*), custom booleans/numbers, attestations, and **verdict exports** (`<check>ChangesRequested` etc. — usable as gate conditions; the default workflow uses one to hold tickets in Implementing during rework). Picking from a dropdown replaces writing raw AQL — which remains as an "advanced condition" escape hatch per check (needed: real gates contain ORs).
- On the ticket page, the current stage renders its gate as a **live checklist** (✓ Plan exists · ✗ Plan approved — *approve with `syntaur plan-ready`*), under the stage's `guidance:` line (the successor of the ladder's `next:` labels — that prose migrates, it isn't dropped).
- Declaring a new check happens inline from the gate builder — the standalone Facts tab disappears.

### 2.5 Two kinds of truth: computed checks and judgment checks — precise semantics

Not every "done" is mechanically observable. Some checks the system reads off disk; others require someone — an LLM judge or a human — to *look at the work and render a verdict*. Two truth-modes of one concept:

- **Computed checks** — evaluated from files. Free, instant, continuously re-evaluated, cannot rot.
- **Judgment checks** — a qualified actor attests. Built on the existing attestation primitive: `{check, actor, verdict, note, at, binding snapshot}`, revision-bound so **judgment expires when the work changes**. This is the load-bearing property for loops: rework commits stale the prior approval, so the gate honestly fails again on the next pass — and also stale the prior *dissent*, which re-opens the implementing→reviewing path. Nobody un-approves or un-rejects by hand.

(Asserted bool/number facts survive as a low-stakes escape hatch, but "is it actually done" should be computed or judged, never self-reported.)

**A judgment check declares:**

1. **Who counts** (`by:`) — `human`, `any agent`, a specific runner profile, or `not-author`.
2. **How to solicit it** (`judge:`, optional) — a runner profile + prompt/skill that produces the verdict. A `by: human` check with no judge lands in the review queue.
3. **Quorum** (optional) — satisfied iff `valid approved records ≥ N` **and** `valid changes-requested records = 0`. Any valid dissent vetoes and takes the dissent route — mixed verdicts are never route-ambiguous. Superseded records (a judge re-attesting) are appended to an audit list, not silently erased. *(v2: without the veto rule, 2-of-3 quorum with one dissent satisfied both routes simultaneously.)*

**Verdict → route wiring (deterministic):** the **approval side is just the gate** — the `next:` route traverses when the *entire* gate passes (all judged checks hold valid approvals, all computed checks true). There is no separate "any approval advances" path — that would bypass co-required checks and race a second attester into the terminal freeze. The **dissent side** is `on-dissent:` — any valid changes-requested verdict from a qualified actor fires it, edge-triggered, one-shot, with the judge's note copied durably to the ticket (comments + the history entry, not just a best-effort event). If rework requires no new commit (the judge was wrong, plan-only fix), the dissent record stays valid and would hold the gate closed forever — the explicit escape is `syntaur review re-request`, which consumes the dissent record and re-arms solicitation. *(v2: the v1 "verdicts pick routes" wording was ambiguous by construction with two judged checks — the exact "two engines" disease this redesign exists to kill.)*

**Identity — honest scoping.** Today the attestation `actor` is a free string: `--agent whatever` is recorded verbatim, and the no-session fallback default is literally `'human'` (`derive-verbs.ts:97-109`) — so `by: human`/`not-author` are *not* enforceable on the current write path. The fix is already half-built: the provenance resolver (`session-id.ts`: STRONG/EXPLICIT/WEAK + `assertMayMutate`) exists but isn't wired into `attest`. Required: attest records `{actorKind, sessionId (full), profile?, provenance}`; WEAK provenance cannot satisfy `by:` qualifications; `--agent` demotes to a display label; `not-author` compares the attesting session against engagement rows (full session ids — today's 8-char-prefix actor strings can't join). Work done with no attributable session ⇒ `not-author` is unsatisfiable by any agent ⇒ the check routes to the human queue. **Threat model stated plainly:** this defends against honest-but-confused agents (the real problem), not adversarial ones — a local file-based CLI cannot cryptographically enforce separation of duties.

**Binding correctness.** The judge supplies the sha it actually reviewed (`attest --commit <sha>`; the dispatcher passes the sha it launched the review against) — attest-time HEAD capture is a warned fallback, because it snapshots whatever landed *while the judge was reading* (routine under headless dispatch). Validity compares against the branch tip, not HEAD. At terminal, check states freeze into frontmatter (§2.3) so worktree cleanup can't retroactively stale a done ticket's approvals.

**Solicitation is first-class state.** A `solicitations:` frontmatter list — `{check, judge, revisionBinding, at, sessionRef, state: solicited|rendered|failed}` — travels with the ticket (git-tracked, multi-machine-coherent). It is what makes the four check states computable: **pass ✓ / fail ✗ / awaiting judgment ⏳ (open solicitation for the current revision) / stale ↻ (approved, work changed since)**. Solicitation triggers on the *level condition* "(at this stage) ∧ (current revision has no solicitation for this check+judge)" — evaluated on every recompute, not on arrival events, so a mid-review push re-solicits without the ticket ever leaving the stage. Keyed per (check, judge, revision) so quorum judges 2..N aren't starved. Dead judges are reaped: a solicitation whose session is dead or past TTL flips to `failed` → re-solicit up to N per revision → then flag to the human queue. *(v2: v1 had no substrate for "awaiting" at all, and "once per revision on gate-arrival" both wedged on judge crashes and never re-solicited on mid-stage pushes.)*

Cost asymmetry is honored structurally: computed checks re-evaluate freely; judgment checks are never polled — solicited per (check, judge, revision), cached until the binding stales.

### 2.6 Blocked/parked become flags, not places

Disposition was always orthogonal; the confusion came from projecting it into the status column via "headline projection." New rule: **blocked/parked/hold are badges on the card**, never columns or stages. They pause auto routes and gate dispatch. Boards get an optional "show blocked as a column" toggle — a board display setting, not workflow config. `phase`, `disposition`, `headline`, and `derivedStatus` exit the user-facing vocabulary (with query-layer aliases during deprecation, §4.5). The **`hold`** flag is the per-ticket "don't auto-advance" escape hatch and the resolved answer to v1's open pin question (§4.4).

### 2.7 Who works a stage — and how autonomy arrives

`work.agent` points at an existing runner profile; `work.playbooks` and `work.launchPrompt` compose the seeded prompt via the existing launch plumbing (`resolveLaunchPlan` already accepts per-launch agent + prompt overrides — genuinely zero new infrastructure). Rollout in three rungs, each independently useful:

1. **Launch affordance (v1):** ticket page + board card show the current stage's agent with a **Launch** button — opens the terminal with the stage-specific prompt.
2. **Suggestions inbox + review queue:** extend the existing inbox/attention stack (`src/inbox/` categories) with "stage has an agent, gate unmet" (one-click launch) and "awaiting your verdict" / "went stale" items. Human-paced batch operation.
3. **Dispatcher — generalize the schedules subsystem, don't rebuild it.** *(v2: this rung is rewritten. v1 said "consumes stage-entered events, claims via lease, launches headless" — wrong on all three nouns.)*
   - **Trigger/dedupe/claim/reap:** a stage with `dispatch: auto` materializes a standing `when-status`-style trigger per ticket in `src/schedules/` — evaluated by the existing tick as a **cursor over persisted statusHistory** (durable, replayable, dashboard-down safe) with per-edge dedupe keys, crash-safe claim-before-launch, launch-ack, dead-launch reaping, cooldowns, and `maxLaunchesPerDay`. The launchd tick is the always-on floor; the dashboard watcher is a latency accelerator. The events DB stays what it is — a best-effort audit log (no busy_timeout, no consumer API, drops writes under contention) — never a delivery mechanism.
   - **Leases** are used for what they model: dev-env *pools* a dispatched agent claims (`claimLease` is LRU-pool-claim; there is no claim-by-ticket API, and TTL-expiry on hours-long runs would double-dispatch). Ticket claiming is the scheduler's job-claim, which already has attempt states, retry, and stuck-flagging.
   - **Workspace provisioning is a dispatcher pre-launch step:** create branch + worktree, write `workspace.*`, serialized per-repo — and **refuse dispatch** (don't fall back to the shared repo root) when provisioning fails. *(v2: otherwise parallel dispatched agents land in one shared checkout, which also breaks launch-ack's per-cwd session attribution.)*
   - **Solicited judge runs** are solicitation attempts (§2.5) with the same reap/retry/poison-item handling as launches.
   - **Cost controls, specified:** an auto-hop counter on the ticket (frontmatter; per rolling window *and* per revision), decremented by the dispatcher at launch **and** at judge auto-solicitation; per-ticket and global daily launch caps (the `canFire` pattern); a global dispatch kill switch; `maxRuntimeMs` per run as the interim ceiling. Real token budgets belong to the exec adapters and are deferred *honestly* for non-Claude profiles. *(v2.1: for Claude profiles they arrive with the native adapter — `--max-budget-usd` on judge runs; on `--bg` runs the dispatcher tick polls the job's live token count and kills over-cap runs.)*
   - **Headless is a subsystem, not a bullet point — but for Claude profiles most of it ships with the CLI.** *(v2.1 — verified on claude 2.1.201 + agent-view docs.)* Every Syntaur launch path today ends in a GUI terminal window via osascript, output unobservable; the scheduler's `unattendedArgvSeam` returns `[]` — the seam is built but empty. The fill is **per-profile exec adapters**, and they are not equal-cost:
     - **`native-bg` (Claude profiles):** `claude --bg "<prompt>"` launches a detached background agent (daemon-managed — no tmux, no osascript) and returns immediately. `claude agents --json [--all] [--cwd <dir>]` is the scripting surface: `sessionId`, `cwd`, `status`, `state` (`working`/`blocked`/`done`) — the `--cwd` filter slots directly into the existing per-cwd launch-ack. `state: blocked` carries the agent's actual question (`~/.claude/jobs/<id>/state.json` `detail`), feeding the inbox's "agent needs input" category natively; `state.json` also exposes a live token count for the cost rails (undocumented internals — treat `agents --json` as the contract, `state.json` as best-effort enrichment). Per-launch policy is flags, not future work: `--permission-mode`, `--allowedTools`/`--disallowedTools`, `--settings` (inject a SessionEnd/Stop hook at dispatch for push-style completion acks; the `agents --json` poll remains the reaper floor), `--mcp-config`, `--model`. Human intervention *improves* over terminal windows: attach, steer, or answer a blocked agent from the `claude agents` view at any time.
     - **Judge runs on Claude profiles** use print mode instead: `claude -p --output-format json --max-budget-usd <cap>` — blocking, structured verdict on stdout, native per-run dollar cap (print-mode-only flag), cost/token totals in the result envelope.
     - **`exec` (Codex-style profiles):** `codex exec` and kin — the remaining real build: output capture, completion detection, per-run caps. **`terminal` (fallback):** today's osascript launch for profiles with neither.
     - Honest gaps in the native path: exit-code semantics are undocumented (detect completion by `state`, never exit code); no max-runtime flag (`maxRuntimeMs` stays a dispatcher-side kill); `--max-budget-usd` doesn't apply to `--bg` runs (see cost controls above).

     **No auto-dispatch of write-capable agents before the per-stage permission policy is decided** — for Claude profiles the enforcement *mechanism* now exists at launch (`--permission-mode`/`--allowedTools`), so that gate is a policy decision, not a build; for other profiles it still waits on their adapter. Human-verdict checks are the natural pause points throughout: the machine drives everything up to them and queues them for you.
   - **Single-host, stated:** SQLite, O_EXCL lockfiles, launchd, runtime markers — the dispatch layer is coherently single-machine, matching the product. A shared/network `~/.syntaur` is out of scope.

### 2.8 Domain generality — does this work for non-coding workflows?

Yes, by construction rather than by accident — and the audit is worth recording because it identifies the only two places where coding assumptions actually live.

**Why the core is domain-neutral:** a Syntaur ticket is a markdown record, not code. Nearly every built-in computed check reads the *record*, not a repository: `hasRealObjective`, `acRealTotal`/`acAllChecked` (checkboxes work the same for "thumbnail exported" as for "tests pass"), `planExists`/`planApproved` (any task can have a plan), `depsSatisfied`, `unresolvedQuestions`. Stages/gates/routes/flags, judgment checks (`by:`, `judge:`, quorum, dissent routes), work bindings (agent/playbooks/launchPrompt), engagement-based `on: work-start`, the journey rail, the simulator, and per-type workflow binding (`workflowByType: {video: video-production, bug: bugfix}`) are all domain-free. A content workflow is just another map: *idea → research → script → record → edit → publish*.

**The two coding-specific joints, and their generalizations:**

1. **`binds: commit` is the only git-coupled binding.** The generalization already exists in embryo: `binds: plan` is a *file-digest* binding to a named artifact. Generalize it to **`binds: file(<name-or-glob>)`** — a judgment binds to the digest of a declared deliverable in the assignment dir (`script.md`, `research-brief.md`, `cut-notes.md`). A stage may declare `deliverable: script.md`; its gate gets `deliverableExists` for free and its judgments bind to the deliverable's digest, so "editor approved the script" goes stale when the script changes — exactly the plan-approval semantics, domain-free. The judge-supplied revision (`attest --commit <sha>`) generalizes to `attest --digest <sha256>`/`--file`. `binds: commit` remains as the code-domain instance of the same idea.

2. **Dispatch workspace provisioning is git-specific.** §2.7's pre-launch worktree/branch provisioning becomes conditional: a workflow (or stage) declares `workspace: git | none`. `none` skips provisioning and launches the agent with the assignment dir as its working context. The "refuse dispatch when provisioning fails" rule applies only to `workspace: git`.

**Small catalog additions that make non-coding gates pleasant** (not required for correctness): `fileExists(<glob>)` as a general computed check (of which `planExists` is the built-in special case), and `artifactCaptured(<type>)` reading the existing typed proof-artifact system (screenshot / video / asciinema / http / text — already built for `syntaur capture`), so "demo video attached" is a computed check, not an honor-system boolean.

**The honest boundary:** checks the system cannot observe locally — "video published to YouTube," "email sent," "doc shared" — do **not** become computed checks; there are no external connectors and this design shouldn't pretend otherwise. They are exactly what judgment and asserted checks are for: a human or an agent with the relevant access attests, optionally solicited per §2.5. If connectors ever exist, they'd slot in as a third check evaluation mode (`computed-external`) without touching the model.

**Worked example — video production:**

```yaml
id: video
label: Video Production
stages:
  - id: idea
    gate: [{check: hasRealObjective}]
    next: [{to: research}]
  - id: research
    work: { agent: yt-researcher }          # the yt-research toolkit as a runner profile
    deliverable: research-brief.md
    gate:
      - check: deliverableExists
      - check: factsVerified                 # judged, by: any agent, binds: file(research-brief.md)
        judge: fact-checker
    next: [{to: scripting}]
  - id: scripting
    deliverable: script.md
    gate:
      - check: scriptApproved                # judged, by: human, binds: file(script.md)
    next: [{to: production, on: work-start}] # recording is activity, not an artifact
    on-dissent: scripting                    # notes ride along; script edits stale the dissent
  - id: production
    gate:
      - check: artifactCaptured(video)
    next: [{to: publish}]
  - id: publish
    gate:
      - check: published                     # asserted or judged — external system, honest boundary
        by: human
    next: [{to: done}]
  - id: done
    terminal: true
workspace: none
```

Everything above runs on the §2.2–§2.7 machinery unchanged: staleness, dissent loops, the review queue, dispatch (minus git provisioning), cost rails, the journey rail.

---

## Part 3 — The UX (the emphasis)

### 3.1 One editing surface: the pipeline canvas

Kill the four tabs. The `/workflow` page becomes a **direct-manipulation pipeline editor**:

- **Layout:** happy-path stages as a left-to-right spine of cards (reuse the existing ReactFlow investment + spine layout from the Jun 21 graph work); loop routes as curved return edges; terminal stages capped at the right. No disposition side-lanes — flags aren't places.
- **Stage card at rest** shows the three answers at a glance: name/color, avatar of the assigned agent, gate summary ("3 checks"), and route arrows.
- **Click a stage → inspector drawer** with four compact sections: **About** (label, color, done-toggle, guidance), **Who** (agent profile picker, playbooks, launch-prompt override), **Done when** (checklist builder + advanced condition), **Routes** (targets with trigger kind: gate / work-start / manual; dissent target for review stages). Add stage = "+" on an edge or at the end. Drag between cards to create a route (already built).
- **A "List" toggle** renders the same model as a table for bulk edits (the Jun 21 table survives as the secondary view).
- **Validation** stays quiet-chip style ("2 issues") — extended to gates (unknown check, unreachable stage, no terminal stage, auto-route cycles).

The graph stops being a *visualization of one tab* and becomes *the workflow itself*. That's the difference between the current page and Linear/GitHub-Projects-grade workflow settings.

### 3.2 The ticket "journey" view

On the assignment page, replace the scattered status/phase/disposition/pin rows with one **journey rail**:

- Its workflow's stages left-to-right, current stage highlighted, traversed stages dimmed-checked, loop traversals indicated. Legacy blocked/parked history entries render as flag toggles, not stage visits.
- Under the current stage: the `guidance:` line, the **live gate checklist** (four states: ✓ ✗ ⏳ ↻), the assigned agent + Launch button, and the route actions a human may take. A `gate-overridden` badge when a manual `--force` skipped a failing gate.
- History drawer: each move with route, trigger kind, gate snapshot, actor, timestamp — the honest answer to "who moved this and why."

### 3.3 A simulator, because trust is the product

"Test drive" button in the editor: spawn a phantom ticket, toggle checks and render phantom verdicts, watch it move (including loops, dissent routes, and regression flags). The engine is pure given a fact set, so this is cheap — and it's the fastest way to make a workflow author *believe* the machine does what the picture says. This directly attacks the "we built it three times and it still feels untrustworthy" problem.

### 3.4 Vocabulary contract

| Say | Retire |
|---|---|
| **Workflow** — the map | — |
| **Stage** — a place on the map (board column) | status (UI label), phase, rung |
| **Check** — a condition, *computed* (from files) or *judged* (by a verdict) | fact (user-facing) |
| **Gate** — a stage's exit checklist | derive rules, phase ladder |
| **Verdict** — a judge's approved / changes-requested on a check | — |
| **Judge** — the actor qualified to render a verdict (human, LLM, not-author) | — |
| **Route** — an edge (gate / work-start / manual / dissent) | transition, command table |
| **Flag** — blocked / parked / hold / gate-overridden badge | disposition, headline projection |
| **Guidance** — per-stage next-action prose | `next:` rung labels, nextAction |
| **Done stage** — `terminal: true` | "Done" toggle vs terminal drift |
| **Agent** — runner profile bound to a stage | — |

Internal names migrate lazily (and the frontmatter key does not change — §4.3); the *UI and docs* adopt this contract on day one. One glossary panel in the editor ("How workflows work" — five sentences, one diagram) replaces the current implicit demand that users reverse-engineer the engine.

### 3.5 Consistency fixes that ride along

Styled dialogs replace `window.prompt`/`confirm`; stage **rename-in-place** (the atomic rename machinery exists — the UI never exposed it); persist canvas layout per workflow; one "customize defaults" pattern everywhere; human-readable save errors; cross-links (binding UIs ↔ editor; editor shows "used by N projects / M tickets"); standalone tickets get a rebind route; fix the global-board grouping contradiction.

---

## Part 4 — Migration spec (v2: rewritten from "nothing valuable is lost" to an explicit spec)

The v2 ground-truth check (live `~/.syntaur/config.md`, all 239 real assignment files) killed the v1 claim that the default config migrates mechanically. Neither live workflow has a `derive:` block (both use the built-in ladder), the default has no `transitions:` block (routes would come from a fallback table referencing a status this workflow doesn't define), and `planning`/`code_review` are defined statuses no rung ever produces. **Every workflow migration — including the default — runs a doctor-assisted compile report with forced human decisions.** The rules:

**4.1 Compile rule (ladder → gates).** `gate(stage_i) := the full condition of rung_{i+1}` (rungs are not cumulative, so there is no clean "diff"). Retired-fact conjuncts are flagged for decision: `implementationStarted` → an `on: work-start` route; `reviewRequested`/`reworkRequested` → dropped in favor of stored position + dissent routes + the `not: <check>ChangesRequested` gate pattern. OR conditions are preserved via the raw-condition escape hatch. Semantic caveat surfaced in the report: the ladder re-ranks from scratch (a rung can hold while an earlier rung's condition fails); gates freeze earlier conditions as history — equivalent only for monotone tickets.

**4.2 Orphan stages and routes.** Stages on no rung and no route (`planning`, `code_review` in the live default) are surfaced with a forced decision: delete / wire into the spine / leave manual-only. Fallback-table routes referencing undefined stages (`pending:*`) are filtered. `order` is never used as an implicit spine (inserting `planning` between `ready_for_planning` and `ready` would change reachability). The shipped **new built-in default workflow** is hand-authored in the new model (as in §2.2), not compiled.

**4.3 Storage key: `status:` stays.** The stored stage id lives in the existing `status:` frontmatter key — "stage" is UI/docs vocabulary only. This keeps every external reader, `renameStatusInHistory`, the remap scans, the protocol docs, and old binaries working (a renamed key would make every migrated ticket read as `pending` to old readers). New history entries keep writing `from`/`to` (so `statusAge` keeps working); `phaseFrom/phaseTo` keys stop being written and `phaseAge` is retired via the alias table (4.5) rather than left to silently freeze.

**4.4 Seeding + blocked/parked conversion.** Per ticket: `stage := phase ?? (last statusHistory entry whose `to` is a non-flag stage) ?? placement function result`, with a divergence report (mirrors `migrate-derive`). The `blocked`/`parked` status definitions are deleted through the existing remap machinery; live blocked/parked tickets land at their real stage with the flag set. `block`/`unblock`/`park` become flag verbs (their 1,096 historical status events and history entries render as flag toggles in the journey rail). **Pin:** zero live pins exist, so this is a capability decision, not a data migration — pin retires; its use cases split into the `hold` flag (suppress auto-advance) and an audited admin "move to any stage" action (`trigger: manual-override`). The board's drag-anywhere affordance maps to that action, not to declared routes.

**4.5 Query/API compatibility window.** AQL registry: `phase` → alias of stage, `disposition:blocked/parked` → `blocked:true`/`parked:true`, `pinned` → deprecated (false), `phaseage` → removed with a parse-time deprecation warning; `ls --query` help rewritten in the same PR. Dashboard payloads keep `phase`/`disposition`/`derivedStatus` as deprecated mirrors for one release; `nextAction` → the stage `guidance:`. Enumerated consumers of the three retired facts to rewire: `src/inbox/index.ts:451`, `src/commands/{start,implement,review}.ts`, `stage-fact-bridge.ts`, `query/fields.ts`, `dashboard/parser.ts`.

**4.6 Per-file workflows — atomic and exclusive, or not at all.** Workflows move to `~/.syntaur/workflows/<id>.md` **in one migration that also deletes the `workflows:` block from config.md**; `getWorkflowLibrary` hard-errors (with a doctor check) if both sources exist — no transition window with two live sources (that is exactly the `syntaur status` split-brain class §1.5 diagnoses, aggravated by long-running dashboards serving stale server code). Shipping prerequisites in the same phase: a `workflows` backup category (`github-backup.ts` currently backs up only the single config file), a `workflows/` dir watcher (the config watcher is `depth: 0` on config.md — workflow edits would otherwise trigger no recompute/SSE), and doctor coverage. Format decision: add the `yaml` package as a dependency for these files (they're low-volume config; the hand-rolled parser's escaping hacks are the thing we're escaping) — a deliberate exception to the codebase's zero-YAML-dep pattern, confined to workflow files.

**4.7 What maps where (summary).**

| Today | Becomes |
|---|---|
| Status definitions + order | Stages (1:1; order = spine order, explicit) |
| Transition table | Routes with trigger kinds; CLI verbs resolve to routes (`complete` = any route into a terminal success stage; `implement` = the work-start trigger; unknown verb from a stage → "available routes are: …") |
| Phase ladder | Gates via the 4.1 compile rule + the placement function (§2.3) |
| Disposition rules | blocked/parked/hold flags |
| Headline projection | Board display setting (off by default) |
| Facts + attestations | Checks (computed / judged) — same registry and computation |
| `implementationStarted` | The `on: work-start` route trigger (engagement bridge repointed) |
| `reviewRequested` / `reworkRequested` | Stored position + dissent routes + verdict-export gate conditions |
| Pin/override | `hold` flag + audited manual-override move (4.4) |
| `next:` rung labels / nextAction | Per-stage `guidance:` |
| `recomputeAndWrite` lock/CAS/history | The engine's write path (verified reusable) — now also owning terminal |
| Remap/delete machinery, resolver seam, binding chain | Reused verbatim (verified) |
| `src/schedules/` | The dispatcher foundation (§2.7) |

---

## Part 5 — Sequencing (each phase shippable)

- **Phase 0 — stop the bleeding (small, do regardless):** thread per-workflow context through `complete`/`fail`/`reopen`; retire/redirect `syntaur status` (+ doctor check for the colliding legacy block); fix the kanban grouping contradiction; styled dialogs.
- **Phase 1 — engine:** stored stage + routes (all four trigger kinds) + gates + one mover: cascade fixpoint, gate snapshots, regression flags, `gate-overridden`, placement function, terminal-in-engine (linked todos / dependents / reopen routes), `stages-migrated` gate, doctor checks, the 4.1–4.4 migration with its report. CLI: `move`, `review re-request`, flag verbs, verb→route resolution. *(Scope grew in v2: terminal-in-engine and the placement function are real work that "reuse verbatim" hid.)*
- **Phase 2 — editor:** pipeline canvas + stage inspector + checklist gate builder + list view + simulator. Retire the four tabs. Per-file workflows land here with the 4.6 exclusivity + backup + watcher package.
- **Phase 3 — who:** `work.*` on stages, Launch button, inbox extensions (launch suggestions + review queue + stale items). Attest identity hardening (§2.5: provenance wiring, `--commit`, solicitation records) lands here — it's the precondition for trusting judged gates. The `binds: file(<deliverable>)` generalization and per-stage `deliverable:` (§2.8) ride along with the attestation work.
- **Phase 4a — unattended-but-visible dispatch:** generalize `src/schedules/` per §2.7 (stage triggers, workspace provisioning behind the `workspace: git | none` knob, solicitation attempts, cost rails). Each profile launches via its best adapter from day one: **`native-bg` for Claude profiles** (`claude --bg` — detached *and* human-attachable via `claude agents`; policy flags + hook acks per §2.7), terminal windows for the rest.
- **Phase 4b — exec adapters for the rest:** `codex exec`-style per-profile exec mode, output capture, completion detection, per-run cost caps — fills `unattendedArgvSeam` for non-Claude profiles (the Claude adapter shipped in 4a). Auto-dispatch of write-capable agents stays gated on the per-stage permission policy — enforceable at launch today for Claude profiles, adapter-dependent for others.

---

## Stress-test record (v2)

Four independent adversarial reviews (core engine, judgment checks, migration/compat vs. live data, dispatch/autonomy), each grounded in code. Summary of what happened to the design:

**Survived intact (attacks that did not land):** the stored-position reversal itself; the lock/CAS mutation protocol under racing writers; revision-bound staleness re-arming review loops; judgment checks as natural cascade brakes; forward-drift immunity; `binds:plan` consistency; the remap-machinery and resolver-seam reuse claims; statusline (reads only title/externalIds); live saved views, pins, and `reworkRequested` data (none exist on disk — capability decisions, not data migrations).

**Blockers found and folded in:** activity-triggered routes (`on: work-start`) — without them the default config cannot migrate; edge-triggered one-shot verdict routes + the `not: <check>ChangesRequested` gate pattern — without them the review loop livelocks; deterministic verdict→route rule (whole-gate approval, any-dissent veto); identity hardening for `by:`/`not-author` (today's actor strings are free text defaulting to `'human'`); dispatcher rebased onto the shipped `src/schedules/` subsystem (v1's "events → lease → headless" was wrong on all three nouns: events are best-effort audit, leases can't claim named tickets, headless doesn't exist); migration rewritten as an explicit spec with human decisions even for the default.

**Serious gaps specified in v2:** terminal-in-engine (linked todos, dependents, reopen; today's terminal path is lockless); commit-staleness triggers (nothing fires on `git commit` today) + branch-tip comparison + judge-supplied shas + ratchet protection; regression bookkeeping via gate snapshots + terminal exemption; `gate-overridden` for manual bypasses; the placement function; cascade fixpoint/caps/cycle validation; solicitation as first-class frontmatter state with reaping; quorum veto semantics; workspace provisioning before dispatch; cost rails; per-file move exclusivity + backup + watcher; `status:` as the unchanged storage key; AQL alias table.

## Open decisions for Brennen

1. **Config layout:** per-workflow files under `~/.syntaur/workflows/` with the 4.6 exclusivity package, adding `yaml` as a dependency (recommended) — vs. staying inside `config.md`.
2. **How hard to cut over the UI:** big-bang replacement of the four tabs (recommended — the tabs are the confusion) vs. keeping them behind an "advanced" toggle for one release.
3. ~~Pin~~ **Resolved in v2:** pin retires; `hold` flag + audited manual-override move replace it (§4.4).
4. **`syntaur status` fate:** alias to editing the default workflow vs. deprecating outright in favor of `syntaur workflow` subverbs (Phase 0 needs the doctor check either way).
5. **New in v2 — default workflow shape:** adopt the hand-authored §2.2 default (with `ready` as a waiting stage and judged review) as the shipped built-in, vs. compiling the current built-in ladder as-is. Recommended: hand-authored — the compile report exists for *custom* configs; the default should showcase the model.
