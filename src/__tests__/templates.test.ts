import { describe, it, expect } from 'vitest';
import {
  renderManifest,
  renderMission,
  renderAgent,
  renderClaude,
  renderAssignment,
  renderPlan,
  renderScratchpad,
  renderHandoff,
  renderDecisionRecord,
  renderIndexAssignments,
  renderStatus,
  renderResourcesIndex,
  renderMemoriesIndex,
} from '../templates/index.js';

const TIMESTAMP = '2026-03-18T14:30:00Z';

describe('renderManifest', () => {
  it('produces valid frontmatter with version, mission, generated', () => {
    const out = renderManifest({ slug: 'test-mission', timestamp: TIMESTAMP });
    expect(out).toContain('version: "1.0"');
    expect(out).toContain('mission: test-mission');
    expect(out).toContain(`generated: "${TIMESTAMP}"`);
    expect(out).toContain('# Mission: test-mission');
  });

  it('includes all index links', () => {
    const out = renderManifest({ slug: 'test', timestamp: TIMESTAMP });
    expect(out).toContain('(./_index-assignments.md)');
    expect(out).toContain('(./_index-plans.md)');
    expect(out).toContain('(./_index-decisions.md)');
    expect(out).toContain('(./_status.md)');
    expect(out).toContain('(./resources/_index.md)');
    expect(out).toContain('(./memories/_index.md)');
    expect(out).toContain('(./agent.md)');
    expect(out).toContain('(./claude.md)');
    expect(out).toContain('(./mission.md)');
  });
});

describe('renderMission', () => {
  it('produces correct frontmatter fields', () => {
    const out = renderMission({
      id: 'test-uuid',
      slug: 'test-mission',
      title: 'Test Mission',
      timestamp: TIMESTAMP,
    });
    expect(out).toContain('id: test-uuid');
    expect(out).toContain('slug: test-mission');
    expect(out).toContain('title: "Test Mission"');
    expect(out).toContain('archived: false');
    expect(out).toContain('archivedAt: null');
    expect(out).toContain('archivedReason: null');
    expect(out).toContain(`created: "${TIMESTAMP}"`);
    expect(out).toContain(`updated: "${TIMESTAMP}"`);
    expect(out).toContain('externalIds: []');
    expect(out).toContain('tags: []');
  });

  it('has correct body sections', () => {
    const out = renderMission({
      id: 'id',
      slug: 's',
      title: 'T',
      timestamp: TIMESTAMP,
    });
    expect(out).toContain('# T');
    expect(out).toContain('## Overview');
    expect(out).toContain('## Notes');
  });
});

describe('renderAgent', () => {
  it('produces correct frontmatter', () => {
    const out = renderAgent({ slug: 'test', timestamp: TIMESTAMP });
    expect(out).toContain('mission: test');
    expect(out).toContain(`updated: "${TIMESTAMP}"`);
    expect(out).toContain('# Agent Instructions');
  });
});

describe('renderClaude', () => {
  it('has NO frontmatter', () => {
    const out = renderClaude({ slug: 'test' });
    expect(out).not.toMatch(/^---/);
  });

  it('starts with heading referencing slug', () => {
    const out = renderClaude({ slug: 'my-mission' });
    expect(out).toContain('# Claude Code Instructions \u2014 my-mission');
  });

  it('references agent.md', () => {
    const out = renderClaude({ slug: 'test' });
    expect(out).toContain('agent.md');
  });
});

describe('renderAssignment', () => {
  it('produces correct frontmatter for new assignment', () => {
    const out = renderAssignment({
      id: 'uuid-1',
      slug: 'test-assignment',
      title: 'Test Assignment',
      timestamp: TIMESTAMP,
      priority: 'medium',
      dependsOn: [],
    });
    expect(out).toContain('id: uuid-1');
    expect(out).toContain('slug: test-assignment');
    expect(out).toContain('status: pending');
    expect(out).toContain('priority: medium');
    expect(out).toContain('assignee: null');
    expect(out).toContain('externalIds: []');
    expect(out).toContain('dependsOn: []');
    expect(out).toContain('blockedReason: null');
    expect(out).toContain('repository: null');
    expect(out).toContain('worktreePath: null');
    expect(out).toContain('branch: null');
    expect(out).toContain('parentBranch: null');
    expect(out).toContain('tags: []');
  });

  it('renders non-empty dependsOn as YAML list', () => {
    const out = renderAssignment({
      id: 'id',
      slug: 's',
      title: 'T',
      timestamp: TIMESTAMP,
      priority: 'high',
      dependsOn: ['dep-one', 'dep-two'],
    });
    expect(out).toContain('dependsOn:');
    expect(out).toContain('  - dep-one');
    expect(out).toContain('  - dep-two');
    expect(out).not.toContain('dependsOn: []');
  });

  it('has correct body sections', () => {
    const out = renderAssignment({
      id: 'id',
      slug: 's',
      title: 'T',
      timestamp: TIMESTAMP,
      priority: 'medium',
      dependsOn: [],
    });
    expect(out).toContain('## Objective');
    expect(out).toContain('## Acceptance Criteria');
    expect(out).toContain('## Context');
    expect(out).toContain('## Questions & Answers');
    expect(out).toContain('## Progress');
    expect(out).toContain('## Links');
    expect(out).toContain('(./plan.md)');
    expect(out).toContain('(./scratchpad.md)');
    expect(out).toContain('(./handoff.md)');
    expect(out).toContain('(./decision-record.md)');
  });
});

describe('renderPlan', () => {
  it('starts with status draft', () => {
    const out = renderPlan({
      assignmentSlug: 'test',
      title: 'Test',
      timestamp: TIMESTAMP,
    });
    expect(out).toContain('status: draft');
    expect(out).toContain('assignment: test');
    expect(out).toContain('# Plan: Test');
    expect(out).toContain('## Approach');
    expect(out).toContain('## Tasks');
    expect(out).toContain('## Risks & Mitigations');
  });
});

describe('renderScratchpad', () => {
  it('has correct structure', () => {
    const out = renderScratchpad({
      assignmentSlug: 'test',
      timestamp: TIMESTAMP,
    });
    expect(out).toContain('assignment: test');
    expect(out).toContain(`updated: "${TIMESTAMP}"`);
    expect(out).toContain('# Scratchpad');
    expect(out).toContain('No working notes yet.');
  });
});

describe('renderHandoff', () => {
  it('has handoffCount 0', () => {
    const out = renderHandoff({
      assignmentSlug: 'test',
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
      assignmentSlug: 'test',
      timestamp: TIMESTAMP,
    });
    expect(out).toContain('decisionCount: 0');
    expect(out).toContain('# Decision Record');
    expect(out).toContain('No decisions recorded yet.');
  });
});

describe('renderIndexAssignments', () => {
  it('has all status counts at 0', () => {
    const out = renderIndexAssignments({
      slug: 'test',
      title: 'Test',
      timestamp: TIMESTAMP,
    });
    expect(out).toContain('total: 0');
    expect(out).toContain('pending: 0');
    expect(out).toContain('in_progress: 0');
    expect(out).toContain('completed: 0');
    expect(out).toContain('# Assignments');
  });
});

describe('renderStatus', () => {
  it('has initial pending status with zero counts', () => {
    const out = renderStatus({ slug: 'test', title: 'Test Mission', timestamp: TIMESTAMP });
    expect(out).toContain('status: pending');
    expect(out).toContain('total: 0');
    expect(out).toContain('blockedCount: 0');
    expect(out).toContain('failedCount: 0');
    expect(out).toContain('unansweredQuestions: 0');
  });

  it('uses title in heading, not slug', () => {
    const out = renderStatus({ slug: 'test-slug', title: 'My Title', timestamp: TIMESTAMP });
    expect(out).toContain('# Mission Status: My Title');
    expect(out).not.toContain('# Mission Status: test-slug');
  });
});

describe('renderResourcesIndex', () => {
  it('has correct structure', () => {
    const out = renderResourcesIndex({
      slug: 'test',
      title: 'Test',
      timestamp: TIMESTAMP,
    });
    expect(out).toContain('mission: test');
    expect(out).toContain('total: 0');
    expect(out).toContain('# Resources');
  });
});

describe('renderMemoriesIndex', () => {
  it('has correct structure', () => {
    const out = renderMemoriesIndex({
      slug: 'test',
      title: 'Test',
      timestamp: TIMESTAMP,
    });
    expect(out).toContain('mission: test');
    expect(out).toContain('total: 0');
    expect(out).toContain('# Memories');
  });
});
