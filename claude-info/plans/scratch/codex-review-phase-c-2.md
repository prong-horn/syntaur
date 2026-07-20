FINDING 1  
SEVERITY: critical  
LOCATION: Task 15, especially plan.md:2145-2146 and 2238-2270  
ISSUE: The “UNBOUND” path explicitly cannot deterministically identify the launched root session, yet it still records whichever inherited-marker process arrives first and lets every later claimant take the legacy reconcile path. A subagent or `track-session --session-id <other>` can therefore claim first; the launch code suppresses the daemon placeholder for that unrelated row, while the real root may later register a separate row. This leaves the shell-alias Claude case—the stated Phase B race case—without the AC8 deterministic binding or duplicate-row guarantee.  
FIX: Do not count an unbound first-writer claim as satisfying AC8. Add a root-only identity/correlation mechanism for shell-alias launches, or retain a pending correlation record until a verifiable root registration is observed. If no root identity can be established, explicitly exclude that launch mode from the claim protocol and add a different deterministic correlation path before declaring the residual closed.

FINDING 2  
SEVERITY: major  
LOCATION: Task 16 Step 16.2, plan.md:2517-2522; `src/daemon/types.ts:43-49`  
ISSUE: The durable recovery scan treats any matching non-terminal `state.json` as proof that a runnable launch landed, but does not verify that `hostPid` still matches `hostPidStartedAt` and is alive. A pty-host crash before `finalizeExit` leaves a non-terminal state file; a lost dispatch reply would then be reported as successfully adopted even though no agent remains, preventing fallback and creating a dead active registry row. The plan’s claim that the scanner’s recycle guard covers this is inaccurate because this recovery path never invokes it.  
FIX: Validate the job’s `hostPid`/`hostPidStartedAt` with the existing process-identity/liveness helper before adopting it; treat dead or recycled hosts as unconfirmed, cancel the reservation, and degrade. Add a test for a matching non-terminal state file whose host identity is dead or mismatched.

FINDING 3  
SEVERITY: major  
LOCATION: Task 15 Step 15.1, plan.md:2181-2208 and 2222-2234; Task 16/17, plan.md:2622 and 2649  
ISSUE: Cancellation does not make the same launch identity reservable again: `cancelLaunch` only sets `canceled_at`, while `reserveLaunch` uses a plain primary-key `INSERT`. A retry with the same generated identity therefore gets `false` and proceeds on the legacy, unreserved path—the plan’s own Task 17 describes and accepts this. That avoids blocking the retry, but reopens the exact hook-race and ambiguous-landing protections AC8 is intended to provide.  
FIX: Make reserve idempotently revive a canceled reservation (clearing dispatch/claim/cancel fields and refreshing metadata) or delete canceled reservations immediately. Update the same-identity retry test to assert a fresh active reservation exists and the retry remains claim-protected.

FINDING 4  
SEVERITY: minor  
LOCATION: Task ordering, plan.md:98-103 and 313-318  
ISSUE: Task 1 is listed before Task 2 although Task 1 imports `ScreenText`, which Task 2 creates. The plan notes that Task 2 must land first or in the same commit, but that conflicts with the stated task order and creates avoidable implementation ambiguity.  
FIX: Reorder Task 2 before Task 1 in Phase 1, or formally group them as one atomic prerequisite task with Task 2’s type additions first.

VERDICT: NEEDS REVISION