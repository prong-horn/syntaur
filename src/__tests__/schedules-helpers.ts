// Shared fixtures for the schedules test suites. NOT a test file (no `.test.ts`
// suffix), so vitest's include glob never runs it as a suite.
import {
  type ScheduledJob,
  freshAttempt,
  defaultLimits,
  defaultTiming,
} from '../schedules/types.js';
import { newJobId } from '../schedules/store.js';
import type { AssignmentFrontmatter, StatusHistoryEntry } from '../lifecycle/types.js';

export function sampleJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: newJobId(),
    assignmentId: 'scheduled-agents',
    agentId: 'claude',
    promptTemplate: 'plan @assignment',
    playbook: null,
    terminalPreference: 'terminal-app',
    unattended: true,
    limits: defaultLimits(),
    trigger: { kind: 'cron', expr: '0 3 * * *' },
    timing: defaultTiming(),
    note: null,
    createdAt: '2026-06-15T00:00:00Z',
    updatedAt: '2026-06-15T00:00:00Z',
    attempt: freshAttempt(),
    ...overrides,
  };
}

export function sampleAssignment(
  overrides: Partial<AssignmentFrontmatter> = {},
): AssignmentFrontmatter {
  return {
    id: 'a-1',
    slug: 'scheduled-agents',
    title: 'Scheduled agents',
    project: 'syntaur-meta',
    type: 'feature',
    status: 'ready_for_planning',
    priority: 'high',
    created: '2026-06-15T00:00:00Z',
    updated: '2026-06-15T00:00:00Z',
    assignee: 'claude',
    externalIds: [],
    statusHistory: [],
    dependsOn: [],
    links: [],
    blockedReason: null,
    workspace: { repository: null, worktreePath: null, branch: null, parentBranch: null },
    tags: [],
    archived: false,
    archivedAt: null,
    archivedReason: null,
    phase: null,
    disposition: null,
    planApproval: null,
    parked: false,
    reviewRequested: false,
    implementationStarted: false,
    override: null,
    facts: {},
    attestations: [],
    ...overrides,
  };
}

export function statusEntry(to: string, at: string): StatusHistoryEntry {
  return { at, from: null, to, command: 'derive', by: 'system' };
}
