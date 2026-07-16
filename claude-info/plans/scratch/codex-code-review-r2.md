No critical findings.

FINDING 1  
SEVERITY: major  
LOCATION: src/tui/syntaurd/launch.ts:104; src/tui/cockpit/actions.ts:200  
ISSUE: A transport failure after syntaurd accepts `dispatch` is treated as a definite launch failure. The daemon may already have spawned and recorded the session, but `sendRequest` can reject before its reply reaches the client; `runLaunch` then falls through to claude-bg/tmux/handoff and starts a second agent. The first daemon session also has no registry row because registration occurs only after the reply.  
FIX: Make dispatch idempotent by `sessionId`, and on an ambiguous request failure retry/query that same ID before any fallback. Only fall back on a definite pre-spawn daemon error; otherwise report an unknown outcome without launching another agent.

FINDING 2  
SEVERITY: major  
LOCATION: src/tui/syntaurd/launch.ts:104; src/tui/cockpit/Cockpit.tsx:221; src/dashboard/agent-sessions.ts:364  
ISSUE: The Branch-B/shell-alias correlation race remains. Both daemon and tmux paths start the worker before inserting the placeholder row. If Claude’s hook runs in that interval, `consumeLaunchMarkers` finds no placeholder and registers the real ID; the caller then inserts the synthetic launch-ID placeholder. No later hook necessarily reconciles them, leaving duplicate active rows and engagements. Existing “hook registered first” tests still insert the placeholder before the hook, so they miss this order.  
FIX: Persist a correlation reservation before launching the worker (preferably a pending-launch record that creates no active engagement), then have the hook claim/rekey it atomically. Add a test where marker consumption and real-ID registration occur before post-dispatch placeholder activation.

FINDING 3  
SEVERITY: major  
LOCATION: src/tui/syntaurd/launch.ts:119; src/tui/sessions/feed.ts:145  
ISSUE: Hookless daemon sessions never receive a durable terminal transition. The feed renders daemon terminal state as `isLive: false`, but it does not update the session row or close its open engagement. Cleanup relies on the optional scanner; with it disabled/unavailable, the row stays `active`. Further, the stored host PID intentionally lacks `pid_started_at`, so PID reuse can make the scanner consider a dead placeholder live indefinitely.  
FIX: Add a daemon-exit reconciliation path that atomically terminalizes active registry rows and closes their engagements (`done` → completed; failed/stopped → stopped). Persist a verified host PID start time as well, or include it in the dispatch reply.

No minor findings.

VERDICT: NEEDS REVISION