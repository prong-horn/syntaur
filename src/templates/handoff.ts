export interface HandoffParams {
  ticketSlug?: string;
  timestamp: string;
}

export function renderHandoff(params: HandoffParams): string {
  const slug = params.ticketSlug ?? '';
  return `---
ticket: ${slug}
generated: "${params.timestamp}"
---

# Handoff Log

No handoffs recorded yet.
`;
}
