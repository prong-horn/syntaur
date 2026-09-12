export interface DecisionRecordParams {
  ticketSlug?: string;
  timestamp: string;
}

export function renderDecisionRecord(
  params: DecisionRecordParams,
): string {
  const slug = params.ticketSlug ?? '';
  return `---
ticket: ${slug}
updated: "${params.timestamp}"
decisionCount: 0
---

# Decision Record

No decisions recorded yet.
`;
}
