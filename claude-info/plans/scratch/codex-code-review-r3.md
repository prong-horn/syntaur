FINDING 1  
SEVERITY: major  
LOCATION: src/tui/syntaurd/launch.ts:168  
ISSUE: A failed request followed by one negative `list` probe is not proof that dispatch did not land. If the daemon spawns the detached pty host, loses the reply, then dies (or a replacement daemon is live before roster adoption completes), `queryDaemon({op:'list'})` returns `null`/`[]`. The code degrades to tmux/native, launching a second agent; the original detached host remains running and unregistered.  
FIX: Distinguish pre-send daemon-start failures from post-send transport failures. For the latter, never degrade on a single negative probe; retry through daemon adoption or inspect durable job state by `sessionId`. If still uncertain, surface an unknown-launch status rather than launch a fallback.

FINDING 2  
SEVERITY: major  
LOCATION: src/dashboard/agent-sessions.ts:361  
ISSUE: Launch markers remain in the worker environment after the first registration. For a normal non-alias Claude launch, the first hook registers `sessionId=L` and reconciliation no-ops. If a child/subagent SessionStart—or `syntaur track-session --session-id C`—inherits the same environment, `consumeLaunchMarkers(C)` treats the live parent row `L` as a placeholder and re-keys its session and engagement rows to `C`. The parent becomes unregistered and may later duplicate. This is distinct from the accepted shell-alias hook-race residual.  
FIX: Make correlation an atomically claimed, one-shot durable reservation bound to the intended launch/session, rather than treating any row keyed by `SYNTAUR_LAUNCH_ID` as a placeholder. At minimum, prevent Branch-A markers from reconciling a different session ID.

SEVERITY: critical — no findings.  
SEVERITY: minor — no findings.

The message-prefix ErrorReply discriminator currently has only one producer in the source, so it is not an independent production finding, though it remains brittle compared with an explicit tagged result.

`npm run typecheck` passes.

VERDICT: NEEDS REVISION