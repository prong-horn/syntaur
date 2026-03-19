export interface AgentParams {
  slug: string;
  timestamp: string;
}

export function renderAgent(params: AgentParams): string {
  return `---
mission: ${params.slug}
updated: "${params.timestamp}"
---

# Agent Instructions

All agents working on this mission must follow these guidelines.

## Conventions

<!-- Coding conventions, naming standards, architectural patterns. -->

## Boundaries

<!-- What agents should NOT do. Files/systems that are off-limits. -->

## Resources

<!-- Links to key resources agents should consult. -->
`;
}
