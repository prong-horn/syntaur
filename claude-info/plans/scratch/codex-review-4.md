FINDING 1  
SEVERITY: major  
LOCATION: Task 4B, Step 4B.2; `platforms/claude-code/hooks/session-start.sh:86-88`, `src/commands/session.ts:512-607`  
ISSUE: The plan places correlation and `SYNTAUR_HOSTED_BY` handling in `trackSessionCommand`, but Claude’s automatic SessionStart hook invokes `syntaur session register --from-hook`, which directly calls `appendSession` in `runSessionRegister`. Thus the normal Claude launch path never consumes either marker: Branch-B daemon launches retain duplicate placeholder/real rows, and native `claude --bg` rows do not receive durable `hosted_by='claude-bg'`. This invalidates the claimed round-3 fix.  
FIX: Move or share the marker validation and `reconcileLaunchPlaceholder` call in `runSessionRegister`, immediately before its `appendSession` call; retain it in `trackSessionCommand` only if manual registration also needs it. Add hook-path tests for syntaurd correlation and native `claude-bg` write-if-null provenance using controlled environment values.

FINDING 2  
SEVERITY: major  
LOCATION: Task 9, Step 9.4; `src/tui/tmux/launch.ts:1-31`  
ISSUE: The tmux `<3.2` retry explicitly removes `SYNTAUR_LAUNCH_ID` and `SYNTAUR_HOSTED_BY`. The fallback plan does not inject `--session-id` into the tmux-launched Claude argv either, even under Branch A. Consequently a Claude fallback on old tmux creates a persisted placeholder row plus an independently registered real Claude row with no provenance; the plan’s “all agents” backend-recording and no-duplicate claims do not hold. The proposed smoke test only covers a Codex fallback, so it misses this path.  
FIX: Define a correlation mechanism that survives the no-`-e` tmux path (for example, a safely quoted per-launch environment wrapper), and inject `--session-id` for eligible plain-Claude tmux launches when Branch A applies. Add Claude fallback tests for both `-e` success and the old-tmux retry, asserting one real row with `hostedBy: 'tmux'`.

FINDING 3  
SEVERITY: major  
LOCATION: Task 4B, Step 4B.1; `src/db/engagement-schema.ts:21-38`  
ISSUE: The merge path closes placeholder engagement rows and deletes the placeholder session, but `engagement.session_id` has no foreign key or cascade. This leaves orphaned, closed engagement history keyed to a deleted session ID, which can pollute assignment history/token attribution and contradicts the intended session-to-engagement model. The proposed tests assert the close/delete behavior but do not assert that no orphan remains.  
FIX: In the merge transaction, either re-key eligible placeholder engagements to the real session or delete the placeholder’s engagement rows before deleting the placeholder session; handle an already-open real engagement without violating the partial unique index. Add an assertion that no engagement row remains with the old launch ID.

FINDING 4  
SEVERITY: minor  
LOCATION: Task 9, Steps 9.1 and 9.4; `src/tui/cockpit/Cockpit.tsx:1-24`  
ISSUE: The prescribed Task 9 code uses `randomUUID`, `launchInTmuxWithPid`, `appendSession`, and `now`, but Step 9.1 does not add imports for the first three or define `now`. Implementing the listed code literally will not typecheck.  
FIX: Add imports for `randomUUID` from `node:crypto`, `appendSession`, and `launchInTmuxWithPid`; define `const now = new Date().toISOString()` at registration time (or inject a clock for tests).

VERDICT: NEEDS REVISION