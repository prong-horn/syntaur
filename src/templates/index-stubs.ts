import { escapeYamlString } from '../utils/yaml.js';

export interface IndexStubParams {
  slug: string;
  title: string;
  timestamp: string;
}

export function renderIndexAssignments(params: IndexStubParams): string {
  return `---
project: ${params.slug}
generated: "${params.timestamp}"
total: 0
by_status:
  pending: 0
  in_progress: 0
  blocked: 0
  review: 0
  completed: 0
  failed: 0
---

# Assignments

| Slug | Title | Status | Priority | Assignee | Dependencies | Updated |
|------|-------|--------|----------|----------|--------------|---------|
`;
}

export function renderIndexPlans(params: IndexStubParams): string {
  return `---
project: ${params.slug}
generated: "${params.timestamp}"
---

# Plans

| Assignment | Plan Status | Updated |
|------------|-------------|---------|
`;
}

export function renderIndexDecisions(params: IndexStubParams): string {
  return `---
project: ${params.slug}
generated: "${params.timestamp}"
---

# Decision Records

| Assignment | Count | Latest Decision | Latest Status | Updated |
|------------|-------|-----------------|---------------|---------|
`;
}

export function renderStatus(params: IndexStubParams): string {
  return `---
project: ${params.slug}
generated: "${params.timestamp}"
status: pending
progress:
  total: 0
  completed: 0
  in_progress: 0
  blocked: 0
  pending: 0
  review: 0
  failed: 0
needsAttention:
  blockedCount: 0
  failedCount: 0
  openQuestions: 0
---

# Project Status: ${params.title}

**Status:** pending
**Progress:** 0/0 assignments complete

## Assignments

No tickets yet.

## Dependency Graph

No dependencies yet.

## Needs Attention

- **0 blocked** assignments
- **0 failed** assignments
- **0 unanswered** questions
`;
}
