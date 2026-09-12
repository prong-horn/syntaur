export interface ManifestParams {
  slug: string;
  timestamp: string;
}

export function renderManifest(params: ManifestParams): string {
  return `---
version: "2.0"
project: ${params.slug}
generated: "${params.timestamp}"
---

# Project: ${params.slug}

## Overview
- [Project Overview](./project.md)

## Indexes
- [Tickets](./_index-tickets.md)
- [Plans](./_index-plans.md)
- [Decision Records](./_index-decisions.md)
- [Status](./_status.md)
`;
}
