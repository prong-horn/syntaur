import { describe, it, expect } from 'vitest';
import {
  renderProject,
  renderTicket,
  renderPlan,
  renderScratchpad,
  renderHandoff,
  renderDecisionRecord,
  renderComments,
  renderProgress,
  renderConfig,
} from '../templates/index.js';

const TIMESTAMP = '2026-03-18T14:30:00Z';

describe('renderConfig', () => {
  it('stamps protocol version 2.0', () => {
    const out = renderConfig({ defaultProjectDir: '/tmp/projects' });
    expect(out).toContain('version: "2.0"');
    expect(out).toContain('defaultProjectDir: /tmp/projects');
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
    expect(out).toContain('status: backlog');
    expect(out).toContain('priority: medium');
    expect(out).toContain('assignee: null');
    expect(out).toContain('depends_on: []');
    expect(out).toContain('blocked: null');
    expect(out).toContain('parked: null');
    expect(out).toContain('repository: null');
    expect(out).toContain('worktree: null');
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

  it('renders non-empty depends_on as YAML list', () => {
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
      status: 'planning',
      template: 'feature',
  });
    expect(out).toContain('status: planning');
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
    expect(out).toContain('## Objective');
    expect(out).toContain('## Tasks');
    expect(out).toContain('## Verification');
  });
});

describe('renderComments', () => {
  it('has ticket and generated without counters', () => {
    const out = renderComments({ ticket: 'test', timestamp: TIMESTAMP });
    expect(out).toContain('ticket: test');
    expect(out).toContain(`generated: "${TIMESTAMP}"`);
    expect(out).not.toContain('entryCount');
    expect(out).not.toContain('updated:');
  });
});

describe('renderProgress template counters', () => {
  it('omits entryCount and updated', () => {
    const out = renderProgress({ ticket: 't', timestamp: TIMESTAMP });
    expect(out).not.toContain('entryCount');
    expect(out).not.toContain('updated:');
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
  it('has ticket and generated without counters', () => {
    const out = renderHandoff({
      ticketSlug: 'test',
      timestamp: TIMESTAMP,
    });
    expect(out).toContain('ticket: test');
    expect(out).toContain(`generated: "${TIMESTAMP}"`);
    expect(out).not.toContain('handoffCount');
    expect(out).not.toContain('updated:');
    expect(out).toContain('# Handoff Log');
    expect(out).toContain('No handoffs recorded yet.');
  });
});

describe('renderDecisionRecord', () => {
  it('has ticket and generated without counters', () => {
    const out = renderDecisionRecord({
      ticketSlug: 'test',
      timestamp: TIMESTAMP,
    });
    expect(out).toContain('ticket: test');
    expect(out).toContain(`generated: "${TIMESTAMP}"`);
    expect(out).not.toContain('decisionCount');
    expect(out).not.toContain('updated:');
    expect(out).toContain('# Decision Record');
    expect(out).toContain('No decisions recorded yet.');
  });
});
