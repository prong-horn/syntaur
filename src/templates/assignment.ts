import { escapeYamlString } from '../utils/yaml.js';

export interface AssignmentParams {
  id: string;
  slug: string;
  title: string;
  timestamp: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  dependsOn: string[];
  links: string[];
}

export function renderAssignment(params: AssignmentParams): string {
  const safeTitle = escapeYamlString(params.title);
  const dependsOnYaml =
    params.dependsOn.length === 0
      ? 'dependsOn: []'
      : `dependsOn:\n  - ${params.dependsOn.join('\n  - ')}`;
  const linksYaml =
    params.links.length === 0
      ? 'links: []'
      : `links:\n  - ${params.links.join('\n  - ')}`;

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
${linksYaml}
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

## Todos

<!--
Checklist of work items for this assignment. Items may be simple tasks
or a markdown link to a plan file (e.g., "- [ ] Execute [plan](./plan.md)").
When a plan is superseded by a new one, mark the old todo as:
  - [x] ~~Execute [old plan](./plan.md)~~ (superseded by plan-v2)
Never delete superseded todos — preserve the history.
-->

## Context

<!-- Links to relevant docs, code, or other assignments. -->

## Questions & Answers

No questions yet.

## Progress

No progress yet.

## Links

- [Scratchpad](./scratchpad.md)
- [Handoff](./handoff.md)
- [Decision Record](./decision-record.md)
`;
}
