// Shared fixtures for the schedules test suites. NOT a test file (no `.test.ts`
// suffix), so vitest's include glob never runs it as a suite.
import {
  type ScheduledJob,
  freshAttempt,
  defaultLimits,
  defaultTiming,
} from '../schedules/types.js';
import { newJobId } from '../schedules/store.js';
import type { ChatDispatcher } from '../schedules/dispatch.js';
import type { MessageTurnState } from '../chat/message-state.js';
import type { AssignmentFrontmatter, StatusHistoryEntry } from '../lifecycle/types.js';

export function sampleJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: newJobId(),
    assignmentId: 'scheduled-agents',
    agentId: 'claude',
    message: 'Pick up the plan and implement the next task.',
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
  // `Partial<T>` lets an override set a required field to `undefined`, which the
  // spread would widen — the cast pins the result back to the real shape.
  return {
    workflow: null,
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
    reworkRequested: false,
    implementationStarted: false,
    override: null,
    facts: {},
    attestations: [],
    ...overrides,
  } as AssignmentFrontmatter;
}

export function statusEntry(to: string, at: string): StatusHistoryEntry {
  return { at, from: null, to, command: 'derive', by: 'system' };
}


export interface FakeDispatcher extends ChatDispatcher {
  /** Every `send` this dispatcher accepted, in order. */
  sent: Array<{ assignmentId: string; agentId: string | null; text: string }>;
  withdrawn: Array<{ assignmentId: string; messageId: string }>;
  cancelled: Array<{ assignmentId: string; agentId: string | null }>;
}

export interface FakeDispatcherOptions {
  /** Agent ids the chat reports as attached. Default: the sample job's agent. */
  attached?: string[];
  /** Message ids handed out by `send`, in order. Default: `msg-1`, `msg-2`, … */
  messageIds?: string[];
  /** State reported for a dispatched message. Default: still running. */
  state?: MessageTurnState | null;
  /** When set, `send` rejects with it. */
  sendError?: string;
  /** Whether `withdraw` succeeds. Default false (already sent). */
  withdrawSucceeds?: boolean;
}

/** A `ChatDispatcher` with no chat behind it — the schedules suites' stand-in. */
export function fakeDispatcher(options: FakeDispatcherOptions = {}): FakeDispatcher {
  let minted = 0;
  const sent: FakeDispatcher['sent'] = [];
  const withdrawn: FakeDispatcher['withdrawn'] = [];
  const cancelled: FakeDispatcher['cancelled'] = [];
  return {
    sent,
    withdrawn,
    cancelled,
    async attachedAgents() {
      return options.attached ?? ['claude'];
    },
    async send(assignmentId, agentId, text) {
      if (options.sendError) throw new Error(options.sendError);
      sent.push({ assignmentId, agentId, text });
      minted += 1;
      return options.messageIds?.[minted - 1] ?? `msg-${minted}`;
    },
    async withdraw(assignmentId, messageId) {
      withdrawn.push({ assignmentId, messageId });
      return options.withdrawSucceeds === true;
    },
    async cancel(assignmentId, agentId) {
      cancelled.push({ assignmentId, agentId });
      return true;
    },
    async messageState() {
      return options.state === undefined ? { state: 'running' } : options.state;
    },
  };
}
