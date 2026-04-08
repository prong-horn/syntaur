export interface ManifestParams {
  slug: string;
  timestamp: string;
}

export function renderManifest(params: ManifestParams): string {
  return `---
version: "1.0"
mission: ${params.slug}
generated: "${params.timestamp}"
---

# Mission: ${params.slug}

## Overview
- [Mission Overview](./mission.md)

## Indexes
- [Assignments](./_index-assignments.md)
- [Plans](./_index-plans.md)
- [Decision Records](./_index-decisions.md)
- [Status](./_status.md)
- [Resources](./resources/_index.md)
- [Memories](./memories/_index.md)

## Config
- [Agent Instructions](./agent.md)
- [Claude Code Instructions](./claude.md)
`;
}
