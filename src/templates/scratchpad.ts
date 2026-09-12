export interface ScratchpadParams {
  ticketSlug?: string;
  timestamp: string;
}

export function renderScratchpad(params: ScratchpadParams): string {
  const slug = params.ticketSlug ?? '';
  return `---
ticket: ${slug}
updated: "${params.timestamp}"
---

# Scratchpad

No working notes yet.
`;
}
