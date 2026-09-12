export interface HandoffParams {
  ticketSlug?: string;
  /** @deprecated Dashboard compat until Task 2 */
  assignmentSlug?: string;
  timestamp: string;
}

export function renderHandoff(params: HandoffParams): string {
  const slug = params.ticketSlug ?? params.assignmentSlug ?? '';
  return `---
ticket: ${slug}
updated: "${params.timestamp}"
handoffCount: 0
---

# Handoff Log

No handoffs recorded yet.
`;
}
