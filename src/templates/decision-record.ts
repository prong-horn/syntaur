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
generated: "${params.timestamp}"
---

# Decision Record

No decisions recorded yet.
`;
}
