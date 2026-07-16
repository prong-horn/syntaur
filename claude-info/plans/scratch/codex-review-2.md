FINDING 1  
SEVERITY: major  
LOCATION: D5 resolution / Task 9.4, plan.md:302, 1774-1776  
ISSUE: The Branch-B path knowingly leaves Claude-launched sessions uncorrelated or unrecorded: syntaurd launches may create a duplicate row, and tmux-fallback Claude rows retain `hosted_by = NULL`. This violates the “for ALL agents” and per-row backend-recording requirements. The referenced Claude SessionStart hook only merges context; it does not automatically upsert the preinserted synthetic session ID.  
FIX: Do not accept Branch B as non-blocking. Define and implement a real-ID correlation mechanism for Claude (for example, a launch-correlation record reconciled when the real Claude ID is registered), then set `hosted_by` on that real row and avoid duplicate rail rows. Cover both daemon and tmux fallback Claude paths.

FINDING 2  
SEVERITY: major  
LOCATION: Task 4.3–4.4, plan.md:825-912  
ISSUE: `LaunchSyntaurdResult` declares only `short` and `sessionId`, while `launchSyntaurd()` is declared to return that interface but returns `registered`. Task 9 consumes `res.registered`, and Task 12 asserts it, so the prescribed code fails TypeScript.  
FIX: Add `registered: boolean` to `LaunchSyntaurdResult` and keep the function signature as `Promise<LaunchSyntaurdResult>`; remove the conflicting prose-only replacement return type.

FINDING 3  
SEVERITY: major  
LOCATION: Sequencing / Tasks 9–10, plan.md:310, 1761-1765, 1835-1859; src/commands/tui.ts:32-39  
ISSUE: The plan requires every task’s verification to be green, but Task 9 makes `syntaurdAvailable` a required `CockpitProps` field before Task 10 adds that field to `CockpitRenderProps` and its `React.createElement(Cockpit, props)` call. Thus Task 9’s mandated `npm run typecheck` cannot pass.  
FIX: Move Task 10 before Task 9 (it only depends on Task 3), then make Task 9 depend on Task 10. Alternatively make the prop temporarily optional, but the former preserves the intended capability contract.

FINDING 4  
SEVERITY: major  
LOCATION: Task 9.4, plan.md:1771-1772; src/tui/cockpit/actions.ts:111-113; src/tui/tmux/launch.ts:30  
ISSUE: Changing `launchInTmux` to return `Promise<number | null>` changes `LaunchDeps.launchInTmux` because it is typed as `typeof LaunchInTmux`. The proposed Cockpit wrapper returns `Promise<void>`, contrary to the plan’s claim that it remains compatible; existing action-test mocks also return `Promise<void>`. The final test typecheck will fail.  
FIX: Make the Cockpit wrapper return `tmuxPanePid` after capture and update all typed test mocks to return `null` or a PID. Alternatively decouple `LaunchDeps.launchInTmux` from the concrete function type with an explicit return type, while retaining a separate provenance-capture seam.

FINDING 5  
SEVERITY: major  
LOCATION: Task 15.1 and 15.4, plan.md:2650-2657, 2770-2787; src/tui/cockpit/__tests__/Cockpit.test.tsx:32-39  
ISSUE: The proposed provenance smoke is not deterministic. Its suggested `../../dashboard/agent-sessions.js` mock path is wrong relative to `src/tui/cockpit/__tests__` (the correct target is `../../../dashboard/agent-sessions.js`), and the test only changes the mocked command to `codex`; Cockpit still selects the configured default agent, normally Claude. Therefore the asserted “non-claude” registration branch may not run.  
FIX: Add explicit hoisted mocks for `launchInTmux` and `appendSession` using the correct module paths, and mock/configure `readConfig`/`getAgents` so this test selects an actual Codex agent. Add a separate Claude fallback provenance test once Finding 1’s correlation behavior is defined.

VERDICT: NEEDS REVISION