export interface ScratchpadParams {
  assignmentSlug: string;
  timestamp: string;
}

export function renderScratchpad(params: ScratchpadParams): string {
  return `---
assignment: ${params.assignmentSlug}
updated: "${params.timestamp}"
---

# Scratchpad

No working notes yet.
`;
}
