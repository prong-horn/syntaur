# Scheduled Agents — Design

**Status:** implemented (v1). **Source of truth for requirements:** the assignment
`scheduled-agents` (`assignment.md`) and its reviewed `plan.md`. This doc records the
shipped architecture, the deliberate divergences, and the honest v1 limitations.

## Problem

Let a user schedule an agent to run work on an assignment **unattended** — on a clock
(`at`/`in`/`cron`), after a quota window resets (`after-reset`), or when an assignment
reaches a status / its plan lands. Two payoffs: quota-window optimization (fire as
limits reset) and state-driven automation (the lifecycle becomes a set of triggers).

## Architecture

```
~/.syntaur/schedules/<id>.md     ← per-file job (intent), frontmatter = key: <JSON>
~/.syntaur/schedules/<id>.jsonl  ← append-only event log (narration, machine-readable)
```

- **Store (`src/schedules/store.ts`)** — per-file + frontmatter, auditable like an
  assignment. Mutable writes are atomic (`writeFileForce` = temp + rename). **Divergence
  from the SQLite leases/sessions precedent is deliberate**: a schedule is
  intent-as-document a human edits/reviews. Crash-safety is bought with temp+rename +
  a per-job advisory lock (mirrors `src/lifecycle/recompute.ts` `acquireLock`), not WAL.
- **Triggers (`src/schedules/triggers.ts`)** — PURE over an injected `now` + the watched
  assignment's persisted frontmatter. Clock via `croner`; state via `statusHistory`
  cursor; plan-lands via the `planApproval` field. Reports a due edge + a **dedupe key**;
  never mutates.
- **Reset window (`src/schedules/reset-window.ts`)** — `after-reset` is a **prediction**
  from a user-supplied anchor, re-verified at fire time (reschedule if not yet matured).
- **Attempt state machine (`src/schedules/attempt.ts`)** — `eligible → claimed →
  launching → running → completed/failed/launch_failed`, plus control states `held |
  cancelled | killed`. **Crash-safe exactly-once:** the claim advances the cursor +
  records the dedupe key and persists the `claimed` state **before any launch**. Claim
  lease TTL invariant: `claimTtlMs > ackTimeoutMs + launchSlackMs` (renewed on
  `launching`), so a job is never reaped inside its ack window.
- **Launch-ack (`src/schedules/launch-ack.ts`)** — "wrapper spawned" ≠ "agent running".
  `executeLaunchPlan` now returns a `LaunchHandle`; the tick polls for a **non-pending**
  runtime marker (a real `sessionId`) attributable to the launch; timeout → `launch_failed`.
- **Unattended (`src/schedules/unattended.ts`)** — distinct trust model: kill switch
  (KILL file / `SYNTAUR_SCHEDULES_DISABLED`), cooldown, max-launches/day; Warp refused.
- **Tick (`src/schedules/tick.ts`)** — the ONE authority. Evaluate → gate → claim →
  resolve-at-fire-time (`resolveLaunchPlan`) → launch → ack → reap. Mechanism, not
  policy: it records stuck/failed and stops; remediation is the control verbs.
- **launchd (`src/schedules/launchd.ts`)** — net-new LaunchAgent (`com.syntaur.schedule.tick`)
  running `schedule tick` on an interval; idempotent `bootout`→`bootstrap`.
- **CLI (`src/commands/schedule.ts`)** — every job action is a programmatic verb.
- **Dashboard (`src/dashboard/api-schedules.ts` + SPA `/schedules`)** — calls the same
  lib verbs; the watcher is a **pure accelerator** (`onAssignmentChanged` → fire-due
  tick) wired in `server.ts`, never the source of truth.

## Future-orchestrator seams (built none of it; preserved all of it)

Every action is a programmatic verb; "stuck" is derivable from disk; the event log is
the stream to tail; the tick is one of N concurrent actors (claim-lease + dedupe). An
orchestrator is itself just a future scheduled job.

## v1 scope cuts (designed-for, not built)

- **Headless** — interactive only. Seam: `terminalPreference` on the job +
  `unattendedArgvSeam(job)` is where the agent's permission-mode/allowlist flags plug in
  when the launch spec gains unattended fields.
- **Wake-from-sleep** — v1 fires only while the Mac is awake + logged in; `schedule
  install` says so honestly.
- **Orchestrator agent** — only the seams above.

## Honest v1 limitations (call them out, don't hide them)

- **`after-reset` is a heuristic prediction**, not an observed reset — there is no
  provider reset API. The anchor is the source of truth; `reschedule` corrects it.
  `src/db/usage-db.ts` has no reset-window logic; the window math is isolated for a
  future swap-in.
- **Unattended permission-mode flag injection is deferred** (overlaps headless). The
  hard-limit GATES are enforced today; injecting the agent's skip-permissions/allowlist
  flags into the launched argv is the `unattendedArgvSeam`.
- **Cron defaults to the machine's local timezone** ("run at 3am" = the user's 3am); a
  `--tz` override makes it explicit.
- **Recurring (cron) jobs re-arm** to `eligible` after a successful fire; one-shot
  triggers stay `running`. The launched session is tracked via `sessionId` + the event
  log, not the job's own state.
