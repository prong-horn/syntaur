export interface DecisionRecordParams {
  assignmentSlug: string;
  timestamp: string;
}

export function renderDecisionRecord(
  params: DecisionRecordParams,
): string {
  return `---
assignment: ${params.assignmentSlug}
updated: "${params.timestamp}"
decisionCount: 0
---

# Decision Record

No decisions recorded yet.
`;
}
