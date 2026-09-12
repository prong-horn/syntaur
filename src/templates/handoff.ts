export interface HandoffParams {
  ticketSlug?: string;
  timestamp: string;
}

export function renderHandoff(params: HandoffParams): string {
  const slug = params.ticketSlug ?? '';
  return `---
ticket: ${slug}
updated: "${params.timestamp}"
handoffCount: 0
---

# Handoff Log

No handoffs recorded yet.
`;
}
