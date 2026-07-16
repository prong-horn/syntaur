FINDING 1  
SEVERITY: major  
LOCATION: Task 4B.2b; `src/tui/claude-agents/launch.ts:8-13`  
ISSUE: The plan adds `env` to the injected `ExecFn` call but does not update `defaultExec` to pass `opts.env` to `execFile`. In production, `SYNTAUR_HOSTED_BY=claude-bg` is therefore discarded before `claude --bg` starts, so the hook cannot persist the backend stamp even when Claude’s daemon does propagate its launcher environment.  
FIX: Change the `execFile` options to include `env: opts.env`, and add a test covering that the default executor forwards it (or extract/inject the underlying execFile call).

FINDING 2  
SEVERITY: major  
LOCATION: Task 15.1; `src/tui/cockpit/__tests__/Cockpit.test.tsx`  
ISSUE: The proposed `vi.mock('../../syntaurd/launch.js', ...)` exports only `launchSyntaurd`, while Task 9.1 imports `canInjectClaudeSessionId` and `injectSessionIdArgs` from that same module for the Branch-A tmux fallback. The tmux provenance/component smoke will fail with a missing mocked export instead of testing the fallback behavior.  
FIX: Mock via `importOriginal` and spread the real module while overriding only `launchSyntaurd`, or explicitly export the two helper functions in the mock.

FINDING 3  
SEVERITY: minor  
LOCATION: Task 4B.3; `src/commands/track-session.ts:139-159`  
ISSUE: The plan changes `trackSessionCommand` for manual-registration parity, but its listed correlation tests cover only the `runSessionRegister --from-hook` path. This leaves the newly added manual path unverified, despite the plan and round-4 resolution claiming parity.  
FIX: Add a controlled-environment `trackSessionCommand` test that sets both markers, verifies placeholder reconciliation, and verifies the resulting row retains the expected `hostedBy`.

FINDING 4  
SEVERITY: minor  
LOCATION: Task 17.2  
ISSUE: The prescribed `git stash && ... && git stash pop` baseline check mutates a potentially user-dirty worktree and can conflict on pop; it also does not isolate untracked files unless further flags are used. This conflicts with the workspace preservation rules.  
FIX: Use a separate temporary worktree/clone for the baseline typecheck, or record the current diff and use non-mutating comparisons.

VERDICT: NEEDS REVISION