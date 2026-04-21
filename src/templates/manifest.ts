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
- [Assignments](./_index-assignments.md)
- [Plans](./_index-plans.md)
- [Decision Records](./_index-decisions.md)
- [Status](./_status.md)
- [Resources](./resources/_index.md)
- [Memories](./memories/_index.md)
`;
}
