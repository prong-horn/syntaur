export interface ProgressParams {
  ticket?: string;
  timestamp: string;
}

export function renderProgress(params: ProgressParams): string {
  return `---
ticket: ${params.ticket ?? ''}
entryCount: 0
generated: "${params.timestamp}"
updated: "${params.timestamp}"
---

# Progress

No progress yet.
`;
}

export function formatProgressEntry(body: string, timestamp: string, author = 'human'): string {
  const trimmed = body.trim();
  return `## ${timestamp} · progress · ${author}\n\n${trimmed}\n`;
}
