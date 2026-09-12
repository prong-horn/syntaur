export interface PlanParams {
  ticketSlug: string;
  title: string;
  timestamp: string;
}

export function renderPlan(params: PlanParams): string {
  return `---
ticket: ${params.ticketSlug}
status: draft
created: "${params.timestamp}"
updated: "${params.timestamp}"
---

# Plan: ${params.title}

## Approach

<!-- High-level description of how to accomplish the objective. -->

## Tasks

- [ ] <!-- step 1 -->
- [ ] <!-- step 2 -->
- [ ] <!-- step 3 -->

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| <!-- risk --> | <!-- mitigation --> |
`;
}
