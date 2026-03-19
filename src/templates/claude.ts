export interface ClaudeParams {
  slug: string;
}

export function renderClaude(params: ClaudeParams): string {
  return `# Claude Code Instructions \u2014 ${params.slug}

Read \`agent.md\` first for universal conventions and boundaries.

## Additional Claude Code Rules

<!-- Add Claude Code-specific rules here. -->
`;
}
