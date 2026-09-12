export interface ProgressParams {
  ticket?: string;
  /** @deprecated Dashboard compat until Task 2 */
  assignment?: string;
  timestamp: string;
}

export function renderProgress(params: ProgressParams): string {
  return `---
ticket: ${params.ticket ?? params.assignment ?? ''}
entryCount: 0
generated: "${params.timestamp}"
updated: "${params.timestamp}"
---

# Progress

No progress yet.
`;
}

export function formatProgressEntry(body: string, timestamp: string): string {
  const trimmed = body.trim();
  return `## ${timestamp}\n\n${trimmed}\n`;
}
