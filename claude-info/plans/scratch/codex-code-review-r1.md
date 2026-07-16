No critical findings.

FINDING 1  
SEVERITY: major  
LOCATION: src/tui/cockpit/Cockpit.tsx:337  
ISSUE: The backend guard runs before the native attach branch. A correctly stamped `hostedBy: 'claude-bg'` session with a live `agentShortId` enables Attach in `buildActions`, but `handleAttach` rejects it as “Daemon unavailable” instead of calling `claude attach`. This breaks native attachment whenever the provenance environment stamp propagates successfully.  
FIX: Move the `hostedBy === 'syntaurd' || 'claude-bg'` guard below `isNativeAttachReachable`, so it only prevents tmux fall-through. Add a Cockpit test for `hostedBy: 'claude-bg'` plus a live native short ID.

FINDING 2  
SEVERITY: minor  
LOCATION: src/tui/cockpit/__tests__/Cockpit.test.tsx:648  
ISSUE: The new syntaurd-attach tests mock `runSyntaurdAttach` and only assert routing/status. They would still pass if the new branch removed `runWithMouseSuspended` and/or `suspendTerminal`, so they do not prove the required terminal/mouse sandwich contract.  
FIX: Mock or inject the mouse/suspend boundaries and assert their ordering around `runSyntaurdAttach`, including mouse re-arm on attach failure.

FINDING 3  
SEVERITY: minor  
LOCATION: src/tui/sessions/__tests__/feed.test.ts:269  
ISSUE: The claimed independent-grace-cache test supplies a native failure with no native cache, then a successful syntaurd response. A regression that shared the grace state between sources would still pass; no grace budget is consumed by the native path.  
FIX: Seed both overlays, then fail both sources on the next poll and assert each source independently reuses its own prior overlay once.

VERDICT: NEEDS REVISION