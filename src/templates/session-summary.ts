export interface SessionSummaryParams {
  assignmentSlug: string;
  sessionId: string;
  timestamp: string;
}

export function renderSessionSummary(params: SessionSummaryParams): string {
  return `---
assignment: ${params.assignmentSlug}
sessionId: ${params.sessionId}
created: "${params.timestamp}"
updated: "${params.timestamp}"
---

# Session Summary

## Snapshot

<!-- One-paragraph orientation: what the assignment is, where work currently stands, anything load-bearing for resume. -->

## What Was Done

<!-- Bullet list of concrete actions taken during this session. -->

## What's Next

<!-- Bullet list of next steps for the resuming session. Order matters. -->

## Open Questions

<!-- Unresolved questions, ambiguities, or decisions deferred. -->

## Load-Bearing Context

<!-- Files, line numbers, command outputs, or decisions a future session must not lose. Be specific. -->
`;
}
