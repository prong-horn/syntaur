export interface ProgressParams {
  assignment: string;
  timestamp: string;
}

export function renderProgress(params: ProgressParams): string {
  return `---
assignment: ${params.assignment}
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
