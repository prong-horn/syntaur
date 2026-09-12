import { escapeYamlString } from '../utils/yaml.js';

export interface TicketParams {
  id: string;
  slug: string;
  title: string;
  timestamp: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  dependsOn: string[];
  links: string[];
  project?: string | null;
  type?: string;
  /** Explicit lifecycle-workflow override; emitted only when provided. */
  workflow?: string | null;
  status?: string;
  acceptanceCriteria?: string[];
}

export function renderTicket(params: TicketParams): string {
  const safeTitle = escapeYamlString(params.title);
  const dependsOnYaml =
    params.dependsOn.length === 0
      ? 'dependsOn: []'
      : `dependsOn:\n  - ${params.dependsOn.join('\n  - ')}`;
  const linksYaml =
    params.links.length === 0
      ? 'links: []'
      : `links:\n  - ${params.links.join('\n  - ')}`;
  const projectYaml = `project: ${params.project == null ? 'null' : params.project}`;
  const typeYaml = `type: ${params.type ?? 'feature'}`;
  const workflowLine = params.workflow ? `\nworkflow: ${params.workflow}` : '';
  const seedStatus = params.status ?? 'draft';

  const criteriaLines = params.acceptanceCriteria && params.acceptanceCriteria.length > 0
    ? params.acceptanceCriteria.map((c) => `- [ ] ${c.replace(/\n/g, ' ').trim()}`).join('\n')
    : `- [ ] <!-- criterion 1 -->
- [ ] <!-- criterion 2 -->
- [ ] <!-- criterion 3 -->`;

  return `---
id: ${params.id}
slug: ${params.slug}
title: ${safeTitle}
${projectYaml}
${typeYaml}${workflowLine}
status: ${seedStatus}
priority: ${params.priority}
created: "${params.timestamp}"
updated: "${params.timestamp}"
assignee: null
externalIds: []
statusHistory:
  - at: "${params.timestamp}"
    from: null
    to: ${seedStatus}
    command: create
    by: null
${dependsOnYaml}
${linksYaml}
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
archived: false
archivedAt: null
archivedReason: null
---

# ${params.title}

## Objective

<!-- Clear description of what needs to be done and why. -->

## Acceptance Criteria

${criteriaLines}

## Context

<!-- Links to relevant docs, code, or other tickets. -->

## Links

- [Progress](./progress.md)
- [Comments](./comments.md)
- [Scratchpad](./scratchpad.md)
- [Handoff](./handoff.md) — cross-ticket outbound
- [Decision Record](./decision-record.md)
- [Sessions](./sessions/) — per-session continuity summaries (one \`<session-id>/summary.md\` per session)
`;
}
