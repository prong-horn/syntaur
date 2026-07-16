FINDING 1  
SEVERITY: major  
LOCATION: Tasks 1/4/8/11; `src/tui/tmux/launch.ts:30-32`  
ISSUE: `hosted_by` is only written for syntaurd launches. The tmux fallback still only executes `tmux new-session`; it neither creates nor updates a session row with `hostedBy: 'tmux'`. Thus a newly created fallback-tmux session is indistinguishable from a pre-Phase-B session (`NULL`), and the UI will show `hosted: —`, failing the per-row backend-recording requirement.  
FIX: Add an explicit tmux-fallback registration/provenance path with a stable session-id strategy, persist `hostedBy: 'tmux'`, and test that a daemon-unavailable launch renders `hosted: tmux`.

FINDING 2  
SEVERITY: major  
LOCATION: Task 8 Step 8.3, plan lines 1533-1543; `src/tui/cockpit/actions.ts:49-56`  
ISSUE: The proposed attach gate ignores persisted `hostedBy`. After syntaurd is unavailable for more than the one-poll grace period, a daemon-hosted row loses `syntaurdShortId`; if its host PID remains live and tmux is installed, the code falls through to the tmux attach path. That attempts to attach a tmux session which was never created and violates the intended daemon-first backend routing.  
FIX: Make attach routing backend-aware: `hostedBy: 'syntaurd'` must never fall through to tmux. On a missing daemon short id, re-query/adopt the daemon by `sessionId`, or disable Attach with a daemon-unavailable status. Add a test for a syntaurd-hosted row with no current overlay and tmux available.

FINDING 3  
SEVERITY: major  
LOCATION: Task 4 Step 4.4, plan lines 868-891  
ISSUE: The plan deliberately swallows `appendSession` failure after successful dispatch, returns success, and states that the session becomes rail-invisible. Since `feed.ts` only overlays daemon entries onto existing session-db rows, this directly violates the launch acceptance criterion that the new session appears in the rail via the feed join.  
FIX: Make durable row creation a launch prerequisite, with compensating cleanup/terminal marking if dispatch then fails; alternatively implement a bounded registration retry plus an explicit non-success status until registration completes. Do not report “Launched via daemon” while the session cannot join the rail.

FINDING 4  
SEVERITY: minor  
LOCATION: Task 6 and Tasks 12/14  
ISSUE: There is no direct test for the load-bearing production non-spawning path. Feed tests inject `syntaurdSessionSource`, so they do not prove `queryDaemon` avoids auto-start, applies the short timeout, or that `productionSyntaurdSessionSource` maps a real `ListReply` and failure cases correctly.  
FIX: Add client/source tests covering no live pointer → `null` without spawn, live pointer → `sendRequest(..., 1000)`, send failure → `null` at the source, and list projection/filtering by `sessionId`.

FINDING 5  
SEVERITY: minor  
LOCATION: Task 10 Step 10.1 and Task 17 Step 17.1; `src/commands/__tests__/tui.test.ts:6-17`  
ISSUE: Task 10 modifies `src/commands/__tests__/tui.test.ts`, but Task 17 does not add that changed file to `tsconfig.tests.json`, despite requiring every changed test file be listed. Its new required `checkSyntaurd` dependency therefore escapes the stated test type gate.  
FIX: Add `src/commands/__tests__/tui.test.ts` to Task 17’s `files` list.

VERDICT: NEEDS REVISION