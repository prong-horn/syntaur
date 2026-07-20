FINDING 1  
SEVERITY: critical  
LOCATION: Task 16 Step 16.2 (plan.md:2516-2544); src/daemon/pty-host.ts:234-281  
ISSUE: The ambiguous-dispatch path scans `state.json` exactly once, then cancels the reservation and degrades if no live job is already visible. But the pty-host spawns the agent before its initial `writeJobState` (current source lines 236-280), so a daemon can accept/spawn the detached host, lose the reply and die, while the caller probes during the host’s startup gap. That scan misses the eventual job, cancels, and launches the fallback; the original host can then write state and run too. Thus the plan still cannot prove non-landing and does not close AC8’s residual for all modes.  
FIX: Make a durable startup acknowledgement authoritative before fallback is allowed—e.g. have the pty-host claim/mark the reservation before spawning the agent and retain/poll an in-doubt dispatched reservation until that acknowledgement or definite non-start evidence. Add a deterministic test where the job state is delayed until after the first failed probe; it must not degrade into a second launch.

FINDING 2  
SEVERITY: major  
LOCATION: Task 8 Step 8.1 (plan.md:1428-1452) and Step 8.3 (plan.md:1466-1478)  
ISSUE: `hasNotify` is true forever after the first `notify` event because the engine retains the session’s hook-event history. From then on the adapter bypasses screen heuristics and, after any later quiet interval with a stale/missing rollout file, returns `blocked: awaiting input`—even if the notify belonged to a prior turn and new output has since started a new one. This violates the intended “latest notify” semantics and makes Codex sessions systematically misclassify after their first completion; the proposed fixtures do not cover it.  
FIX: Track/inject output timing or generation and consider only a notify that occurred after the most recent PTY output as the active turn-boundary signal. Preserve generic heuristics for later turns. Add a fixture for “notify → new PTY output → quiet/stale rollout” that remains working (or follows the current prompt heuristic), plus one proving a currently active notify still blocks.

FINDING 3  
SEVERITY: minor  
LOCATION: Task 14 Step 14.3 (plan.md:2116-2125); src/dashboard/session-db.ts:308-324  
ISSUE: The migration-test instructions call the v7 `sessions` schema “14 columns,” but the referenced DDL contains 15: `session_id`, `agent`, `started`, `ended`, `status`, `path`, `description`, `transcript_path`, `pid`, `pid_started_at`, `original_head_sha`, `activity`, `hosted_by`, `created_at`, and `updated_at`. A hand-written 14-column fixture would not accurately exercise the production v7 schema.  
FIX: Correct the count to 15 and spell out or directly reuse the exact v7 DDL/column list in `buildV7Db`.

VERDICT: NEEDS REVISION