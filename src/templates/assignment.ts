import { escapeYamlString } from '../utils/yaml.js';

export interface AssignmentParams {
  id: string;
  slug: string;
  title: string;
  timestamp: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  dependsOn: string[];
}

export function renderAssignment(params: AssignmentParams): string {
  const safeTitle = escapeYamlString(params.title);
  const dependsOnYaml =
    params.dependsOn.length === 0
      ? 'dependsOn: []'
      : `dependsOn:\n  - ${params.dependsOn.join('\n  - ')}`;

  return `---
id: ${params.id}
slug: ${params.slug}
title: ${safeTitle}
status: pending
priority: ${params.priority}
created: "${params.timestamp}"
updated: "${params.timestamp}"
assignee: null
externalIds: []
${dependsOnYaml}
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# ${params.title}

## Objective

<!-- Clear description of what needs to be done and why. -->

## Acceptance Criteria

- [ ] <!-- criterion 1 -->
- [ ] <!-- criterion 2 -->
- [ ] <!-- criterion 3 -->

## Context

<!-- Links to relevant docs, code, or other assignments. -->

## Questions & Answers

No questions yet.

## Progress

No progress yet.

## Links

- [Plan](./plan.md)
- [Scratchpad](./scratchpad.md)
- [Handoff](./handoff.md)
- [Decision Record](./decision-record.md)
`;
}
