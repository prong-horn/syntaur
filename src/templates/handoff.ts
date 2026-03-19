export interface HandoffParams {
  assignmentSlug: string;
  timestamp: string;
}

export function renderHandoff(params: HandoffParams): string {
  return `---
assignment: ${params.assignmentSlug}
updated: "${params.timestamp}"
handoffCount: 0
---

# Handoff Log

No handoffs recorded yet.
`;
}
