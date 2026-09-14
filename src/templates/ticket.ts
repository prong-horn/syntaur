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
  const seedStatus = params.status ?? 'backlog';

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
${templateYaml}
status: ${seedStatus}
priority: ${params.priority}
blocked: null
parked: null
created: "${params.timestamp}"
updated: "${params.timestamp}"
assignee: null
${dependsYaml}
${linksYaml}
tags: []
workspace:
  repository: null
  worktree: null
  branch: null
  parentBranch: null
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
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
