# Cold-start latency finding (Phase E, item 3 — warm-pool measurement spike)

**Date:** 2026-07-23 · **Assignment:** agent-mux-platform-extras · **Script:** `scripts/measure-cold-start.mjs`

## Question
Phase E's warm-pool AC says "measure before building." Does per-session cold-start
latency justify building a Claude-style spare/warm pool for the daemon?

## Method (no production code)
`scripts/measure-cold-start.mjs` is read-only. It joins the structured pre-spawn
`dispatch` record in `~/.syntaur/daemon.log` (`ts`, `short`, `agent` — added in
Task 1, stamped *before* `spawn()`) to that job's `spawned` timeline event `at`
(`~/.syntaur/jobs/<short>/timeline.jsonl`). Metric = `spawned.at − dispatch.ts` ms.
Join key is `short` (job dir); `agent` only groups the percentiles. Unspawned
(dispatch with no `spawned`) and negative/unparsable samples are reported
separately, never folded into the percentiles.

This measures **process cold-start**, not agent readiness. Agent-readiness latency
is deliberately out of scope: `runDerive` emits a `state` timeline event only when
the derived state/needs *changes*, and the initial `working` derive commonly emits
nothing, so there is no reliable "first-derive" timestamp in current artifacts.
Measuring readiness would need dedicated instrumentation — a later scoped task.

## Status / interim conclusion
The metric depends on the structured `dispatch` record introduced by this phase's
Task 1, so it only covers sessions dispatched **after** this change lands; it does
not retroactively cover pre-upgrade sessions (their dispatch lines were plaintext).
Run `node scripts/measure-cold-start.mjs` after a handful of real `syntaur bg`
dispatches to populate p50/p90/p99 per agent.

**Decision rule (recorded so the build stays deferred until data clears the bar):**
build a warm pool only if measured **p90 cold-start is a perceptible fraction of a
session's time-to-usefulness**. Sub-~250 ms cold-start does not justify the pool's
lifecycle/claim-socket complexity — and unlike Claude's pre-authable Node boot,
arbitrary agents (codex, pi, shells) are not uniformly pre-warmable, so the upside
is narrower. Warm pools therefore remain **deferred** pending this measurement.
