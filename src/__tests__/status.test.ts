import { describe, it, expect } from 'vitest';
import {
  computeMissionStatus,
  computeStatusCounts,
  computeNeedsAttention,
  computeStatus,
} from '../rebuild/status.js';
import type { MissionData, ParsedAssignment } from '../rebuild/types.js';

function makeMissionData(
  overrides: Partial<MissionData> & {
    statuses?: string[];
  } = {},
): MissionData {
  const statuses = overrides.statuses || [];
  const assignments: ParsedAssignment[] = statuses.map(
    (status, i) => ({
      slug: `assignment-${i}`,
      title: `Assignment ${i}`,
      status,
      priority: 'medium',
      assignee: null,
      dependsOn: [],
      updated: '',
      sessions: [],
      unansweredQuestions: 0,
      plan: { assignmentSlug: `assignment-${i}`, status: 'draft', updated: '' },
      decisionRecord: {
        assignmentSlug: `assignment-${i}`,
        decisionCount: 0,
        latestDecision: null,
        updated: '',
      },
    }),
  );
  return {
    slug: 'test-mission',
    title: 'Test Mission',
    archived: overrides.archived ?? false,
    assignments: overrides.assignments ?? assignments,
    resources: overrides.resources ?? [],
    memories: overrides.memories ?? [],
  };
}

describe('computeMissionStatus', () => {
  it('Rule 1: archived override returns "archived"', () => {
    const data = makeMissionData({
      archived: true,
      statuses: ['in_progress', 'completed'],
    });
    expect(computeMissionStatus(data)).toBe('archived');
  });

  it('Rule 2: all completed returns "completed"', () => {
    const data = makeMissionData({
      statuses: ['completed', 'completed', 'completed'],
    });
    expect(computeMissionStatus(data)).toBe('completed');
  });

  it('Rule 3: any in_progress returns "active"', () => {
    const data = makeMissionData({
      statuses: ['completed', 'in_progress', 'pending'],
    });
    expect(computeMissionStatus(data)).toBe('active');
  });

  it('Rule 3: any review returns "active"', () => {
    const data = makeMissionData({
      statuses: ['completed', 'review', 'pending'],
    });
    expect(computeMissionStatus(data)).toBe('active');
  });

  it('Rule 3 takes precedence over Rule 4: in_progress + failed = active', () => {
    const data = makeMissionData({
      statuses: ['in_progress', 'failed', 'completed'],
    });
    expect(computeMissionStatus(data)).toBe('active');
  });

  it('Rule 4: any failed (no active) returns "failed"', () => {
    const data = makeMissionData({
      statuses: ['completed', 'failed', 'pending'],
    });
    expect(computeMissionStatus(data)).toBe('failed');
  });

  it('Rule 5: any blocked (no active/failed) returns "blocked"', () => {
    const data = makeMissionData({
      statuses: ['completed', 'blocked', 'pending'],
    });
    expect(computeMissionStatus(data)).toBe('blocked');
  });

  it('Rule 6: all pending returns "pending"', () => {
    const data = makeMissionData({
      statuses: ['pending', 'pending', 'pending'],
    });
    expect(computeMissionStatus(data)).toBe('pending');
  });

  it('Rule 7: mixed pending + completed returns "active"', () => {
    const data = makeMissionData({
      statuses: ['completed', 'completed', 'pending'],
    });
    expect(computeMissionStatus(data)).toBe('active');
  });

  it('Edge: zero assignments returns "pending"', () => {
    const data = makeMissionData({ statuses: [] });
    expect(computeMissionStatus(data)).toBe('pending');
  });

  it('Edge: single completed returns "completed"', () => {
    const data = makeMissionData({ statuses: ['completed'] });
    expect(computeMissionStatus(data)).toBe('completed');
  });

  it('Edge: archived overrides everything', () => {
    const data = makeMissionData({
      archived: true,
      statuses: ['completed', 'completed', 'completed'],
    });
    expect(computeMissionStatus(data)).toBe('archived');
  });
});

describe('computeStatusCounts', () => {
  it('counts each status', () => {
    const assignments = [
      { status: 'completed' },
      { status: 'in_progress' },
      { status: 'pending' },
    ];
    const counts = computeStatusCounts(assignments);
    expect(counts).toEqual({
      total: 3,
      pending: 1,
      in_progress: 1,
      blocked: 0,
      review: 0,
      completed: 1,
      failed: 0,
    });
  });

  it('returns all zeros for empty array', () => {
    const counts = computeStatusCounts([]);
    expect(counts.total).toBe(0);
  });
});

describe('computeNeedsAttention', () => {
  it('counts blocked, failed, and unanswered', () => {
    const assignments = [
      { status: 'blocked', unansweredQuestions: 0 },
      { status: 'failed', unansweredQuestions: 2 },
      { status: 'in_progress', unansweredQuestions: 1 },
    ];
    const attention = computeNeedsAttention(assignments);
    expect(attention).toEqual({
      blockedCount: 1,
      failedCount: 1,
      unansweredQuestions: 3,
    });
  });
});

describe('computeStatus', () => {
  it('returns full computed status object', () => {
    const data = makeMissionData({
      statuses: ['completed', 'in_progress', 'pending'],
    });
    const result = computeStatus(data);
    expect(result.status).toBe('active');
    expect(result.progress.total).toBe(3);
    expect(result.progress.completed).toBe(1);
    expect(result.needsAttention.blockedCount).toBe(0);
  });
});
