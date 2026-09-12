export interface ScratchpadParams {
  ticketSlug?: string;
  /** @deprecated Dashboard compat until Task 2 */
  assignmentSlug?: string;
  timestamp: string;
}

export function renderScratchpad(params: ScratchpadParams): string {
  const slug = params.ticketSlug ?? params.assignmentSlug ?? '';
  return `---
ticket: ${slug}
updated: "${params.timestamp}"
---

# Scratchpad

No working notes yet.
`;
}
