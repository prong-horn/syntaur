FINDING 1
SEVERITY: major
LOCATION: Task 1+2 Step 1.7 (plan.md:561); Tasks 8–9, especially Task 9 Step 9.4 (plan.md:1859); src/tui/claude-agents/launch.ts:46-55; src/commands/track-session.ts:139-153
ISSUE: Native Claude fallback remains a launch path when syntaurd is unavailable, but the plan persists `hosted_by` only for syntaurd and tmux. `SessionHostedBy` explicitly excludes `claude-bg`; Task 9 registers provenance only for `mode === 'tmux'`; and the existing native launcher plus `track-session` upsert have no backend marker. The feed’s `launcher: 'claude-bg'` is only a transient overlay, so it disappears when the Claude daemon source is unavailable. This fails AC #4’s durable “hosting backend is recorded per session row” requirement for a supported fallback path.
FIX: Add `'claude-bg'` to `SessionHostedBy` and a native-launch provenance flow: create/correlate a placeholder row before native launch, pass `SYNTAUR_LAUNCH_ID` through the native launcher environment, and let Task 4B reconcile it when Claude registers. Add persistence, feed-degradation, UI, and component tests proving a native fallback row remains `hostedBy: 'claude-bg'` after the Claude source is unavailable.

FINDING 2
SEVERITY: major
LOCATION: Task 4 Step 4.2 (plan.md:777-790) and Task 12 Step 12.2 (plan.md:2077-2088)
ISSUE: The prescribed unit test for `buildDispatchRequest` cannot pass against the prescribed implementation. Task 4 requires every dispatch payload to include `env: { SYNTAUR_LAUNCH_ID: ctx.sessionId }`, which is necessary for Task 4B correlation, but Task 12’s exact `toEqual` expectation omits `env`. Implementing either block verbatim makes the mandatory launch test fail, or removes the correlation marker.
FIX: Add `env: { SYNTAUR_LAUNCH_ID: 'uuid-1' }` to Task 12’s `buildDispatchRequest` expected payload, and retain the separate `launchSyntaurd` assertion to verify the same marker reaches the request seam.

VERDICT: NEEDS REVISION