export interface DecisionRecordParams {
  ticketSlug?: string;
  /** @deprecated Dashboard compat until Task 2 */
  assignmentSlug?: string;
  timestamp: string;
}

export function renderDecisionRecord(
  params: DecisionRecordParams,
): string {
  const slug = params.ticketSlug ?? params.assignmentSlug ?? '';
  return `---
ticket: ${slug}
updated: "${params.timestamp}"
decisionCount: 0
---

# Decision Record

No decisions recorded yet.
`;
}
