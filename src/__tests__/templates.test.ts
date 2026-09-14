import { describe, it, expect } from 'vitest';
import {
  renderManifest,
  renderProject,
  renderTicket,
  renderPlan,
  renderScratchpad,
  renderHandoff,
  renderDecisionRecord,
  renderIndexTickets,
  renderStatus,
} from '../templates/index.js';

const TIMESTAMP = '2026-03-18T14:30:00Z';

describe('renderManifest', () => {
  it('produces valid frontmatter with version, project, generated', () => {
    const out = renderManifest({ slug: 'test-project', timestamp: TIMESTAMP });
    expect(out).toContain('version: "2.0"');
    expect(out).toContain('project: test-project');
    expect(out).toContain(`generated: "${TIMESTAMP}"`);
    expect(out).toContain('# Project: test-project');
  });

  it('includes all index links', () => {
    const out = renderManifest({ slug: 'test', timestamp: TIMESTAMP });
    expect(out).toContain('(./_index-tickets.md)');
    expect(out).toContain('(./_index-plans.md)');
    expect(out).toContain('(./_index-decisions.md)');
    expect(out).toContain('(./_status.md)');
    expect(out).toContain('(./project.md)');
    expect(out).not.toContain('(./agent.md)');
    expect(out).not.toContain('(./claude.md)');
  });
});

describe('renderProject', () => {
  it('produces correct frontmatter fields', () => {
    const out = renderProject({
      id: 'test-uuid',
      slug: 'test-project',
      title: 'Test Project',
      timestamp: TIMESTAMP,
      prefix: 'TES',
      nextTicket: 1,
      defaultTemplate: 'feature',
    });
    expect(out).toContain('id: test-uuid');
    expect(out).toContain('slug: test-project');
    expect(out).toContain('prefix: TES');
    expect(out).toContain('nextTicket: 1');
    expect(out).toContain('defaultTemplate: feature');
    expect(out).toContain('title: "Test Project"');
    expect(out).toContain('archived: false');
    expect(out).toContain('archivedAt: null');
    expect(out).toContain('archivedReason: null');
    expect(out).toContain(`created: "${TIMESTAMP}"`);
    expect(out).toContain(`updated: "${TIMESTAMP}"`);
    expect(out).toContain('externalIds: []');
    expect(out).toContain('tags: []');
  });

  it('has correct body sections', () => {
    const out = renderProject({
      id: 'id',
      slug: 's',
      title: 'T',
      timestamp: TIMESTAMP,
      prefix: 'S',
    });
    expect(out).toContain('# T');
    expect(out).toContain('## Overview');
    expect(out).toContain('## Notes');
  });
});

describe('renderTicket', () => {
  it('produces correct frontmatter for new ticket', () => {
    const out = renderTicket({
      id: 'uuid-1',
      slug: 'test-ticket',
      title: 'Test Ticket',
      timestamp: TIMESTAMP,
      priority: 'medium',
      depends_on: [],
      links: [],
      template: 'feature',
  });
    expect(out).toContain('id: uuid-1');
    expect(out).toContain('slug: test-ticket');
    expect(out).toContain('status: draft');
    expect(out).toContain('priority: medium');
    expect(out).toContain('assignee: null');
    expect(out).toContain('externalIds: []');
    expect(out).toContain('depends_on: []');
    expect(out).toContain('blockedReason: null');
    expect(out).toContain('repository: null');
    expect(out).toContain('worktreePath: null');
    expect(out).toContain('branch: null');
    expect(out).toContain('parentBranch: null');
    expect(out).toContain('tags: []');
  });

  it('renders empty links as inline YAML', () => {
    const out = renderTicket({
      id: 'id',
      slug: 's',
      title: 'T',
      timestamp: TIMESTAMP,
      priority: 'medium',
      depends_on: [],
      links: [],
      template: 'feature',
  });
    expect(out).toContain('links: []');
  });

  it('renders non-empty links as YAML list', () => {
    const out = renderTicket({
      id: 'id',
      slug: 's',
      title: 'T',
      timestamp: TIMESTAMP,
      priority: 'medium',
      depends_on: [],
      links: ['project-a/task-1', 'project-b/task-2'],
      template: 'feature',
  });
    expect(out).toContain('links:');
    expect(out).toContain('  - project-a/task-1');
    expect(out).toContain('  - project-b/task-2');
    expect(out).not.toContain('links: []');
  });

  it('renders non-empty dependsOn as YAML list', () => {
    const out = renderTicket({
      id: 'id',
      slug: 's',
      title: 'T',
      timestamp: TIMESTAMP,
      priority: 'high',
      depends_on: ['dep-one', 'dep-two'],
      links: [],
      template: 'feature',
  });
    expect(out).toContain('depends_on:');
    expect(out).toContain('  - dep-one');
    expect(out).toContain('  - dep-two');
    expect(out).not.toContain('depends_on: []');
  });

  it('has correct body sections', () => {
    const out = renderTicket({
      id: 'id',
      slug: 's',
      title: 'T',
      timestamp: TIMESTAMP,
      priority: 'medium',
      depends_on: [],
      links: [],
      template: 'feature',
  });
    expect(out).toContain('## Objective');
    expect(out).toContain('## Acceptance Criteria');
    expect(out).toContain('## Context');
    expect(out).not.toContain('## Questions & Answers');
    expect(out).not.toContain('## Progress');
    expect(out).not.toContain('## Links');
  });

  it('omits ## Todos by default', () => {
    const out = renderTicket({
      id: 'id',
      slug: 's',
      title: 'T',
      timestamp: TIMESTAMP,
      priority: 'medium',
      depends_on: [],
      links: [],
      template: 'feature',
  });
    expect(out).not.toContain('## Todos');
  });

  it('uses status override when provided', () => {
    const out = renderTicket({
      id: 'id',
      slug: 's',
      title: 'T',
      timestamp: TIMESTAMP,
      priority: 'medium',
      depends_on: [],
      links: [],
      status: 'ready_for_planning',
      template: 'feature',
  });
    expect(out).toContain('status: ready_for_planning');
    expect(out).not.toContain('status: draft');
  });

  it('renders acceptanceCriteria as checkbox items when provided', () => {
    const out = renderTicket({
      id: 'id',
      slug: 's',
      title: 'T',
      timestamp: TIMESTAMP,
      priority: 'medium',
      depends_on: [],
      links: [],
      acceptanceCriteria: ['Do A', 'Do B', 'Do C'],
      template: 'feature',
  });
    expect(out).toContain('## Acceptance Criteria');
    expect(out).toContain('- [ ] Do A');
    expect(out).toContain('- [ ] Do B');
    expect(out).toContain('- [ ] Do C');
    expect(out).not.toContain('<!-- criterion 1 -->');
  });

  it('keeps the 3 placeholders when acceptanceCriteria is missing or empty', () => {
    const without = renderTicket({
      id: 'id',
      slug: 's',
      title: 'T',
      timestamp: TIMESTAMP,
      priority: 'medium',
      depends_on: [],
      links: [],
      template: 'feature',
  });
    expect(without).toContain('<!-- criterion 1 -->');
    expect(without).toContain('<!-- criterion 2 -->');
    expect(without).toContain('<!-- criterion 3 -->');

    const empty = renderTicket({
      id: 'id',
      slug: 's',
      title: 'T',
      timestamp: TIMESTAMP,
      priority: 'medium',
      depends_on: [],
      links: [],
      acceptanceCriteria: [],
      template: 'feature',
  });
    expect(empty).toContain('<!-- criterion 1 -->');
  });

  it('flattens newlines in acceptanceCriteria entries to spaces (single-line checkbox)', () => {
    const out = renderTicket({
      id: 'id',
      slug: 's',
      title: 'T',
      timestamp: TIMESTAMP,
      priority: 'medium',
      depends_on: [],
      links: [],
      acceptanceCriteria: ['Line 1\nspans two lines'],
      template: 'feature',
  });
    expect(out).toContain('- [ ] Line 1 spans two lines');
    expect(out).not.toContain('- [ ] Line 1\n');
  });
});

describe('renderPlan', () => {
  it('starts with status draft', () => {
    const out = renderPlan({
      ticketSlug: 'test',
      title: 'Test',
      timestamp: TIMESTAMP,
    });
    expect(out).toContain('status: draft');
    expect(out).toContain('ticket: test');
    expect(out).toContain('# Plan: Test');
    expect(out).toContain('## Approach');
    expect(out).toContain('## Tasks');
    expect(out).toContain('## Risks & Mitigations');
  });
});

describe('renderScratchpad', () => {
  it('has correct structure', () => {
    const out = renderScratchpad({
      ticketSlug: 'test',
      timestamp: TIMESTAMP,
    });
    expect(out).toContain('ticket: test');
    expect(out).toContain(`updated: "${TIMESTAMP}"`);
    expect(out).toContain('# Scratchpad');
    expect(out).toContain('No working notes yet.');
  });
});

describe('renderHandoff', () => {
  it('has handoffCount 0', () => {
    const out = renderHandoff({
      ticketSlug: 'test',
      timestamp: TIMESTAMP,
    });
    expect(out).toContain('handoffCount: 0');
    expect(out).toContain('# Handoff Log');
    expect(out).toContain('No handoffs recorded yet.');
  });
});

describe('renderDecisionRecord', () => {
  it('has decisionCount 0', () => {
    const out = renderDecisionRecord({
      ticketSlug: 'test',
      timestamp: TIMESTAMP,
    });
    expect(out).toContain('decisionCount: 0');
    expect(out).toContain('# Decision Record');
    expect(out).toContain('No decisions recorded yet.');
  });
});

describe('renderIndexTickets', () => {
  it('has all status counts at 0', () => {
    const out = renderIndexTickets({
      slug: 'test',
      title: 'Test',
      timestamp: TIMESTAMP,
    });
    expect(out).toContain('total: 0');
    expect(out).toContain('pending: 0');
    expect(out).toContain('in_progress: 0');
    expect(out).toContain('completed: 0');
    expect(out).toContain('# Tickets');
  });
});

describe('renderStatus', () => {
  it('has initial pending status with zero counts', () => {
    const out = renderStatus({ slug: 'test', title: 'Test Project', timestamp: TIMESTAMP });
    expect(out).toContain('status: pending');
    expect(out).toContain('total: 0');
    expect(out).toContain('blockedCount: 0');
    expect(out).toContain('failedCount: 0');
    expect(out).toContain('openQuestions: 0');
  });

  it('uses title in heading, not slug', () => {
    const out = renderStatus({ slug: 'test-slug', title: 'My Title', timestamp: TIMESTAMP });
    expect(out).toContain('# Project Status: My Title');
    expect(out).not.toContain('# Project Status: test-slug');
  });
});
