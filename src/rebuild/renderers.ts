import type {
  ParsedAssignment,
  ParsedResource,
  ParsedMemory,
  ComputedStatus,
  MissionData,
} from './types.js';

/**
 * Render _index-assignments.md
 */
export function renderIndexAssignments(params: {
  slug: string;
  timestamp: string;
  assignments: ParsedAssignment[];
  status: ComputedStatus;
}): string {
  const { slug, timestamp, assignments, status } = params;
  const p = status.progress;

  const rows = assignments
    .map((a) => {
      const link = `[${a.slug}](./assignments/${a.slug}/assignment.md)`;
      const deps =
        a.dependsOn.length > 0 ? a.dependsOn.join(', ') : '\u2014';
      const assignee = a.assignee || '\u2014';
      return `| ${link} | ${a.title} | ${a.status} | ${a.priority} | ${assignee} | ${deps} | ${a.updated} |`;
    })
    .join('\n');

  return `---
mission: ${slug}
generated: "${timestamp}"
total: ${p.total}
by_status:
  pending: ${p.pending}
  in_progress: ${p.in_progress}
  blocked: ${p.blocked}
  review: ${p.review}
  completed: ${p.completed}
  failed: ${p.failed}
---

# Assignments

| Slug | Title | Status | Priority | Assignee | Dependencies | Updated |
|------|-------|--------|----------|----------|--------------|---------|
${rows}
`;
}

/**
 * Render _index-plans.md
 */
export function renderIndexPlans(params: {
  slug: string;
  timestamp: string;
  assignments: ParsedAssignment[];
}): string {
  const { slug, timestamp, assignments } = params;

  const rows = assignments
    .map((a) => {
      const link = `[${a.slug}](./assignments/${a.slug}/plan.md)`;
      return `| ${link} | ${a.plan.status} | ${a.plan.updated} |`;
    })
    .join('\n');

  return `---
mission: ${slug}
generated: "${timestamp}"
---

# Plans

| Assignment | Plan Status | Updated |
|------------|-------------|---------|
${rows}
`;
}

/**
 * Render _index-decisions.md
 * Note: assignments with decisionCount 0 are NOT included.
 */
export function renderIndexDecisions(params: {
  slug: string;
  timestamp: string;
  assignments: ParsedAssignment[];
}): string {
  const { slug, timestamp, assignments } = params;

  const assignmentsWithDecisions = assignments.filter(
    (a) => a.decisionRecord.decisionCount > 0,
  );

  const rows = assignmentsWithDecisions
    .map((a) => {
      const dr = a.decisionRecord;
      const link = `[${a.slug}](./assignments/${a.slug}/decision-record.md)`;
      const latestTitle = dr.latestDecision
        ? dr.latestDecision.title
        : '\u2014';
      const latestStatus = dr.latestDecision
        ? dr.latestDecision.status
        : '\u2014';
      return `| ${link} | ${dr.decisionCount} | ${latestTitle} | ${latestStatus} | ${dr.updated} |`;
    })
    .join('\n');

  return `---
mission: ${slug}
generated: "${timestamp}"
---

# Decision Records

| Assignment | Count | Latest Decision | Latest Status | Updated |
|------------|-------|-----------------|---------------|---------|
${rows}
`;
}

/**
 * Render _index-sessions.md
 * Only active sessions are included.
 */
export function renderIndexSessions(params: {
  slug: string;
  timestamp: string;
  assignments: ParsedAssignment[];
}): string {
  const { slug, timestamp, assignments } = params;

  const activeSessions: Array<{
    assignmentSlug: string;
    agent: string;
    sessionId: string;
    started: string;
    status: string;
  }> = [];

  for (const a of assignments) {
    for (const s of a.sessions) {
      if (s.status === 'active') {
        activeSessions.push({
          assignmentSlug: a.slug,
          agent: s.agent,
          sessionId: s.sessionId,
          started: s.started,
          status: s.status,
        });
      }
    }
  }

  const rows = activeSessions
    .map((s) => {
      const link = `[${s.assignmentSlug}](./assignments/${s.assignmentSlug}/assignment.md)`;
      return `| ${link} | ${s.agent} | ${s.sessionId} | ${s.started} | ${s.status} |`;
    })
    .join('\n');

  return `---
mission: ${slug}
generated: "${timestamp}"
activeSessions: ${activeSessions.length}
---

# Active Sessions

| Assignment | Agent | Session ID | Started | Status |
|------------|-------|------------|---------|--------|
${rows}
`;
}

/**
 * Render _status.md
 * Includes: frontmatter with status/progress/needsAttention,
 * body with assignment checklist, Mermaid dependency graph, needs attention section.
 */
export function renderStatus(params: {
  slug: string;
  title: string;
  timestamp: string;
  assignments: ParsedAssignment[];
  status: ComputedStatus;
}): string {
  const { slug, title, timestamp, assignments, status } = params;
  const p = status.progress;
  const na = status.needsAttention;

  // Assignment checklist
  const checklist = assignments
    .map((a) => {
      const checked = a.status === 'completed' ? 'x' : ' ';
      const link = `[${a.slug}](./assignments/${a.slug}/assignment.md)`;
      let detail = a.status;
      if (a.assignee && a.status !== 'completed' && a.status !== 'pending') {
        detail += ` (${a.assignee})`;
      }
      if (
        a.status === 'pending' &&
        a.dependsOn.length > 0
      ) {
        detail += ` (waiting on: ${a.dependsOn.join(', ')})`;
      }
      return `- [${checked}] ${link} \u2014 ${detail}`;
    })
    .join('\n');

  // Mermaid dependency graph
  const edges: string[] = [];
  const standaloneNodes: string[] = [];

  for (const a of assignments) {
    if (a.dependsOn.length === 0) {
      // Check if any assignment depends on this one
      const isDependedOn = assignments.some((other) =>
        other.dependsOn.includes(a.slug),
      );
      if (!isDependedOn) {
        standaloneNodes.push(
          `    ${a.slug}:::${a.status}`,
        );
      }
    }
    for (const dep of a.dependsOn) {
      const depAssignment = assignments.find(
        (d) => d.slug === dep,
      );
      const depStatus = depAssignment
        ? depAssignment.status
        : 'pending';
      edges.push(
        `    ${dep}:::${depStatus} --> ${a.slug}:::${a.status}`,
      );
    }
  }

  const graphLines = [...edges, ...standaloneNodes];
  const mermaidBlock =
    graphLines.length > 0
      ? `\`\`\`mermaid
graph TD
${graphLines.join('\n')}
    classDef completed fill:#22c55e
    classDef in_progress fill:#3b82f6
    classDef pending fill:#6b7280
    classDef blocked fill:#ef4444
    classDef failed fill:#dc2626
\`\`\``
      : 'No dependencies yet.';

  // Needs attention section
  const attentionLines: string[] = [];
  attentionLines.push(
    `- **${na.blockedCount} blocked** assignments`,
  );
  attentionLines.push(
    `- **${na.failedCount} failed** assignments`,
  );

  if (na.unansweredQuestions > 0) {
    // Find assignments with unanswered questions for links
    const assignmentsWithQuestions = assignments.filter(
      (a) => a.unansweredQuestions > 0,
    );
    const questionWord =
      na.unansweredQuestions === 1 ? 'question' : 'questions';
    if (assignmentsWithQuestions.length === 1) {
      const a = assignmentsWithQuestions[0];
      attentionLines.push(
        `- **${na.unansweredQuestions} unanswered** ${questionWord} in [${a.slug}](./assignments/${a.slug}/assignment.md)`,
      );
    } else {
      attentionLines.push(
        `- **${na.unansweredQuestions} unanswered** ${questionWord}`,
      );
    }
  } else {
    attentionLines.push(
      `- **0 unanswered** questions`,
    );
  }

  return `---
mission: ${slug}
generated: "${timestamp}"
status: ${status.status}
progress:
  total: ${p.total}
  completed: ${p.completed}
  in_progress: ${p.in_progress}
  blocked: ${p.blocked}
  pending: ${p.pending}
  review: ${p.review}
  failed: ${p.failed}
needsAttention:
  blockedCount: ${na.blockedCount}
  failedCount: ${na.failedCount}
  unansweredQuestions: ${na.unansweredQuestions}
---

# Mission Status: ${title}

**Status:** ${status.status}
**Progress:** ${p.completed}/${p.total} assignments complete

## Assignments

${assignments.length > 0 ? checklist : 'No assignments yet.'}

## Dependency Graph

${mermaidBlock}

## Needs Attention

${attentionLines.join('\n')}
`;
}

/**
 * Render manifest.md
 */
export function renderManifest(params: {
  slug: string;
  timestamp: string;
}): string {
  const { slug, timestamp } = params;
  return `---
version: "1.0"
mission: ${slug}
generated: "${timestamp}"
---

# Mission: ${slug}

## Overview
- [Mission Overview](./mission.md)

## Indexes
- [Assignments](./_index-assignments.md)
- [Plans](./_index-plans.md)
- [Decision Records](./_index-decisions.md)
- [Sessions](./_index-sessions.md)
- [Status](./_status.md)
- [Resources](./resources/_index.md)
- [Memories](./memories/_index.md)

## Config
- [Agent Instructions](./agent.md)
- [Claude Code Instructions](./claude.md)
`;
}

/**
 * Render resources/_index.md
 */
export function renderResourcesIndex(params: {
  slug: string;
  timestamp: string;
  resources: ParsedResource[];
}): string {
  const { slug, timestamp, resources } = params;

  const rows = resources
    .map((r) => {
      const link = `[${r.fileName}](./${r.fileName}.md)`;
      const related =
        r.relatedAssignments.length > 0
          ? r.relatedAssignments.join(', ')
          : '\u2014';
      return `| ${link} | ${r.category} | ${r.source} | ${related} | ${r.updated} |`;
    })
    .join('\n');

  return `---
mission: ${slug}
generated: "${timestamp}"
total: ${resources.length}
---

# Resources

| Name | Category | Source | Related Assignments | Updated |
|------|----------|--------|---------------------|---------|
${rows}
`;
}

/**
 * Render memories/_index.md
 */
export function renderMemoriesIndex(params: {
  slug: string;
  timestamp: string;
  memories: ParsedMemory[];
}): string {
  const { slug, timestamp, memories } = params;

  const rows = memories
    .map((m) => {
      const link = `[${m.fileName}](./${m.fileName}.md)`;
      const sourceAssignment = m.sourceAssignment || '\u2014';
      return `| ${link} | ${m.source} | ${m.scope} | ${sourceAssignment} | ${m.updated} |`;
    })
    .join('\n');

  return `---
mission: ${slug}
generated: "${timestamp}"
total: ${memories.length}
---

# Memories

| Name | Source | Scope | Source Assignment | Updated |
|------|--------|-------|------------------|---------|
${rows}
`;
}
