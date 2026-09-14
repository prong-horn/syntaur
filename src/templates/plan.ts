export interface PlanParams {
  ticketSlug: string;
  title: string;
  timestamp: string;
}

/** Unified initial plan stub (scaffold + plan create). */
export function renderPlanStub(params: {
  ticketSlug: string;
  title?: string;
  timestamp: string;
}): string {
  const date = params.timestamp.slice(0, 10);
  const heading = params.title
    ? `# Plan: ${params.title}`
    : `# ${params.ticketSlug} — Implementation Plan`;

  return `---
ticket: ${params.ticketSlug}
status: draft
created: "${params.timestamp}"
updated: "${params.timestamp}"
---

${heading}

**Date:** ${date}

## Objective

<!-- Describe the goal and success criteria. -->

## Tasks

<!-- Add the implementation tasks here. -->

## Verification

<!-- Add verification steps here. -->
`;
}

/** @deprecated Use renderPlanStub — kept for callers that pass title. */
export function renderPlan(params: PlanParams): string {
  return renderPlanStub({
    ticketSlug: params.ticketSlug,
    title: params.title,
    timestamp: params.timestamp,
  });
}
