export interface IndexStubParams {
  slug: string;
  title: string;
  timestamp: string;
}

export function renderIndexAssignments(params: IndexStubParams): string {
  return `---
mission: ${params.slug}
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
mission: ${params.slug}
generated: "${params.timestamp}"
---

# Plans

| Assignment | Plan Status | Updated |
|------------|-------------|---------|
`;
}

export function renderIndexDecisions(params: IndexStubParams): string {
  return `---
mission: ${params.slug}
generated: "${params.timestamp}"
---

# Decision Records

| Assignment | Count | Latest Decision | Latest Status | Updated |
|------------|-------|-----------------|---------------|---------|
`;
}

export function renderStatus(params: IndexStubParams): string {
  return `---
mission: ${params.slug}
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
  unansweredQuestions: 0
---

# Mission Status: ${params.title}

**Status:** pending
**Progress:** 0/0 assignments complete

## Assignments

No assignments yet.

## Dependency Graph

No dependencies yet.

## Needs Attention

- **0 blocked** assignments
- **0 failed** assignments
- **0 unanswered** questions
`;
}

export function renderResourcesIndex(params: IndexStubParams): string {
  return `---
mission: ${params.slug}
generated: "${params.timestamp}"
total: 0
---

# Resources

| Name | Category | Source | Related Assignments | Updated |
|------|----------|--------|---------------------|---------|
`;
}

export function renderMemoriesIndex(params: IndexStubParams): string {
  return `---
mission: ${params.slug}
generated: "${params.timestamp}"
total: 0
---

# Memories

| Name | Source | Scope | Source Assignment | Updated |
|------|--------|-------|------------------|---------|
`;
}
