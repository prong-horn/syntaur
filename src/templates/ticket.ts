import { escapeYamlString } from '../utils/yaml.js';

export interface TicketParams {
  id: string;
  slug: string;
  title: string;
  timestamp: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  depends_on: string[];
  links: string[];
  project?: string | null;
  template: string;
  /** Explicit lifecycle-workflow override; emitted only when provided. */
  workflow?: string | null;
  status?: string;
  acceptanceCriteria?: string[];
}

export function renderTicket(params: TicketParams): string {
  const safeTitle = escapeYamlString(params.title);
  const dependsYaml =
    params.depends_on.length === 0
      ? 'depends_on: []'
      : `depends_on:\n  - ${params.depends_on.join('\n  - ')}`;
  const linksYaml =
    params.links.length === 0
      ? 'links: []'
      : `links:\n  - ${params.links.join('\n  - ')}`;
  const projectYaml = `project: ${params.project == null ? 'null' : params.project}`;
  const templateYaml = `template: ${params.template}`;
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
${templateYaml}${workflowLine}
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
${dependsYaml}
${linksYaml}
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
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
`;
}
