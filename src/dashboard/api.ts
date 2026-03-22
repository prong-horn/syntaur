import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canTransition, getTargetStatus } from '../lifecycle/index.js';
import { fileExists } from '../utils/fs.js';
import {
  parseMission,
  parseStatus,
  parseAssignmentFull,
  parsePlan,
  parseScratchpad,
  parseHandoff,
  parseDecisionRecord,
  parseResource,
  parseMemory,
  extractMermaidGraph,
} from './parser.js';
import { getDashboardHelp } from './help.js';
import type {
  AssignmentBoardItem,
  AssignmentDetail,
  AssignmentStatus,
  AssignmentSummary,
  AssignmentsBoardResponse,
  AssignmentTransitionAction,
  AttentionItem,
  AttentionResponse,
  EditableDocumentResponse,
  HelpResponse,
  MemorySummary,
  MissionDetail,
  MissionSummary,
  OverviewResponse,
  ProgressCounts,
  NeedsAttention,
  RecentActivityItem,
  ResourceSummary,
  TransitionCommand,
} from './types.js';

const STALE_ASSIGNMENT_MS = 7 * 24 * 60 * 60 * 1000;
const ATTENTION_PAGE_LIMIT = 50;
const OVERVIEW_ATTENTION_LIMIT = 6;
const RECENT_MISSIONS_LIMIT = 6;
const RECENT_ACTIVITY_LIMIT = 12;

type AssignmentRecord = ReturnType<typeof parseAssignmentFull>;

interface MissionRecord {
  missionPath: string;
  mission: ReturnType<typeof parseMission>;
  assignments: AssignmentRecord[];
  summary: MissionSummary;
  dependencyGraph: string | null;
}

interface AttentionSeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

const TRANSITION_DEFINITIONS: Array<{
  command: Exclude<TransitionCommand, 'assign'>;
  label: string;
  description: string;
  requiresReason: boolean;
}> = [
  {
    command: 'start',
    label: 'Start',
    description: 'Move pending or review work into active execution.',
    requiresReason: false,
  },
  {
    command: 'review',
    label: 'Send To Review',
    description: 'Mark the assignment ready for inspection.',
    requiresReason: false,
  },
  {
    command: 'complete',
    label: 'Complete',
    description: 'Mark the assignment done.',
    requiresReason: false,
  },
  {
    command: 'block',
    label: 'Block',
    description: 'Record an exceptional blocker and pause work.',
    requiresReason: false,
  },
  {
    command: 'unblock',
    label: 'Unblock',
    description: 'Resume active work after the blocker is cleared.',
    requiresReason: false,
  },
  {
    command: 'fail',
    label: 'Fail',
    description: 'Mark the assignment as failed when it cannot be completed as planned.',
    requiresReason: false,
  },
  {
    command: 'reopen',
    label: 'Reopen',
    description: 'Reopen a completed or failed assignment to resume work.',
    requiresReason: false,
  },
];

/**
 * List all missions with source-first summary data.
 * GET /api/missions
 */
export async function listMissions(missionsDir: string): Promise<MissionSummary[]> {
  const missionRecords = await listMissionRecords(missionsDir);
  return missionRecords.map((record) => record.summary);
}

/**
 * Get overview data used by the app landing page.
 * GET /api/overview
 */
export async function getOverview(missionsDir: string, serversDir?: string): Promise<OverviewResponse> {
  const missionRecords = await listMissionRecords(missionsDir);
  const attention = buildAttentionItems(missionRecords);
  const recentActivity = buildRecentActivity(missionRecords);

  let serverStats: OverviewResponse['serverStats'];
  if (serversDir) {
    try {
      const { scanAllSessions } = await import('./scanner.js');
      const servers = await scanAllSessions(serversDir, missionsDir);
      if (servers.tmuxAvailable) {
        const alive = servers.sessions.filter(s => s.alive).length;
        const totalPorts = servers.sessions.reduce((sum, s) =>
          sum + s.windows.reduce((ws, w) =>
            ws + w.panes.reduce((ps, p) => ps + p.ports.length, 0), 0), 0);
        serverStats = {
          trackedSessions: servers.sessions.length,
          aliveSessions: alive,
          deadSessions: servers.sessions.length - alive,
          totalPorts,
        };
      }
    } catch {
      // Server scanning failure should not break overview
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    firstRun: missionRecords.length === 0,
    stats: {
      activeMissions: missionRecords.filter((record) => record.summary.status === 'active').length,
      inProgressAssignments: missionRecords.reduce(
        (total, record) => total + record.summary.progress.in_progress,
        0,
      ),
      blockedAssignments: missionRecords.reduce(
        (total, record) => total + record.summary.progress.blocked,
        0,
      ),
      reviewAssignments: missionRecords.reduce(
        (total, record) => total + record.summary.progress.review,
        0,
      ),
      failedAssignments: missionRecords.reduce(
        (total, record) => total + record.summary.progress.failed,
        0,
      ),
      staleAssignments: missionRecords.reduce(
        (total, record) =>
          total + record.assignments.filter((assignment) => isStale(assignment.updated)).length,
        0,
      ),
    },
    attention: attention.slice(0, OVERVIEW_ATTENTION_LIMIT),
    recentMissions: missionRecords
      .map((record) => record.summary)
      .sort((left, right) => compareTimestamps(right.updated, left.updated))
      .slice(0, RECENT_MISSIONS_LIMIT),
    recentActivity: recentActivity.slice(0, RECENT_ACTIVITY_LIMIT),
    serverStats,
  };
}

/**
 * Get the explicit attention queue.
 * GET /api/attention
 */
export async function getAttention(missionsDir: string, serversDir?: string): Promise<AttentionResponse> {
  const missionRecords = await listMissionRecords(missionsDir);
  const items = buildAttentionItems(missionRecords);

  if (serversDir) {
    try {
      const { scanAllSessions } = await import('./scanner.js');
      const servers = await scanAllSessions(serversDir, missionsDir);
      for (const session of servers.sessions) {
        if (!session.alive) {
          items.push({
            id: `server-dead-${session.name}`,
            severity: 'low',
            missionSlug: '',
            missionTitle: '',
            assignmentSlug: '',
            assignmentTitle: `tmux: ${session.name}`,
            status: 'failed' as AssignmentStatus,
            reason: 'Tmux session no longer exists but is still registered',
            updated: session.lastRefreshed,
            href: '/servers',
            stale: false,
            blockedReason: null,
          });
        }
      }
    } catch {
      // Server scanning failure should not break attention
    }
  }

  const pagedItems = items.slice(0, ATTENTION_PAGE_LIMIT);
  const summary: AttentionSeverityCounts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const item of pagedItems) {
    summary[item.severity]++;
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      total: pagedItems.length,
      critical: summary.critical,
      high: summary.high,
      medium: summary.medium,
      low: summary.low,
    },
    items: pagedItems,
  };
}

/**
 * Get all assignments across all missions for the global kanban board.
 * GET /api/assignments
 */
export async function listAssignmentsBoard(missionsDir: string): Promise<AssignmentsBoardResponse> {
  const missionRecords = await listMissionRecords(missionsDir);
  const assignments = await Promise.all(
    missionRecords.flatMap(async (record) =>
      Promise.all(
        record.assignments.map(async (assignment) =>
          toAssignmentBoardItem(missionsDir, record, assignment),
        ),
      ),
    ),
  );

  return {
    generatedAt: new Date().toISOString(),
    assignments: assignments
      .flat()
      .sort((left, right) => compareTimestamps(right.updated, left.updated)),
  };
}

/**
 * Get the structured help model used by Help and onboarding surfaces.
 * GET /api/help
 */
export async function getHelp(): Promise<HelpResponse> {
  return getDashboardHelp();
}

/**
 * Get a raw editable document for dashboard editor pages.
 */
export async function getEditableDocument(
  missionsDir: string,
  documentType: EditableDocumentResponse['documentType'],
  missionSlug: string,
  assignmentSlug?: string,
): Promise<EditableDocumentResponse | null> {
  const filePath = getDocumentPath(missionsDir, documentType, missionSlug, assignmentSlug);
  if (!filePath || !(await fileExists(filePath))) {
    return null;
  }

  const content = await readFile(filePath, 'utf-8');
  const title = getEditableDocumentTitle(documentType, missionSlug, assignmentSlug);

  return {
    documentType,
    title,
    content,
    missionSlug,
    assignmentSlug,
    appendOnly: documentType === 'handoff' || documentType === 'decision-record',
  };
}

/**
 * Get full mission detail with assignments, resources, and memories.
 * GET /api/missions/:slug
 */
export async function getMissionDetail(
  missionsDir: string,
  slug: string,
): Promise<MissionDetail | null> {
  const missionPath = resolve(missionsDir, slug);
  const missionMdPath = resolve(missionPath, 'mission.md');

  if (!(await fileExists(missionMdPath))) {
    return null;
  }

  const missionContent = await readFile(missionMdPath, 'utf-8');
  const mission = parseMission(missionContent);
  const assignments = await listAssignmentRecords(missionPath);
  const rollup = buildMissionRollup(mission, assignments);
  const dependencyGraph = await loadDependencyGraph(missionPath, assignments);
  const resources = await listResources(missionPath);
  const memories = await listMemories(missionPath);
  const updated = getMissionActivityTimestamp(mission.updated, assignments);

  return {
    slug: mission.slug || slug,
    title: mission.title,
    status: rollup.status,
    statusOverride: mission.statusOverride,
    archived: mission.archived,
    archivedAt: mission.archivedAt,
    archivedReason: mission.archivedReason,
    created: mission.created,
    updated,
    tags: mission.tags,
    body: mission.body,
    progress: rollup.progress,
    needsAttention: rollup.needsAttention,
    assignments: assignments
      .map(toAssignmentSummary)
      .sort((left, right) => compareTimestamps(right.updated, left.updated)),
    resources,
    memories,
    dependencyGraph,
  };
}

/**
 * Get full assignment detail with plan, scratchpad, handoff, and decision record.
 * GET /api/missions/:slug/assignments/:aslug
 */
export async function getAssignmentDetail(
  missionsDir: string,
  missionSlug: string,
  assignmentSlug: string,
): Promise<AssignmentDetail | null> {
  const assignmentDir = resolve(missionsDir, missionSlug, 'assignments', assignmentSlug);
  const assignmentMdPath = resolve(assignmentDir, 'assignment.md');

  if (!(await fileExists(assignmentMdPath))) {
    return null;
  }

  const assignmentContent = await readFile(assignmentMdPath, 'utf-8');
  const assignment = parseAssignmentFull(assignmentContent);

  let plan: AssignmentDetail['plan'] = null;
  const planPath = resolve(assignmentDir, 'plan.md');
  if (await fileExists(planPath)) {
    const planContent = await readFile(planPath, 'utf-8');
    const parsed = parsePlan(planContent);
    plan = {
      status: parsed.status,
      updated: parsed.updated,
      body: parsed.body,
    };
  }

  let scratchpad: AssignmentDetail['scratchpad'] = null;
  const scratchpadPath = resolve(assignmentDir, 'scratchpad.md');
  if (await fileExists(scratchpadPath)) {
    const scratchpadContent = await readFile(scratchpadPath, 'utf-8');
    const parsed = parseScratchpad(scratchpadContent);
    scratchpad = {
      updated: parsed.updated,
      body: parsed.body,
    };
  }

  let handoff: AssignmentDetail['handoff'] = null;
  const handoffPath = resolve(assignmentDir, 'handoff.md');
  if (await fileExists(handoffPath)) {
    const handoffContent = await readFile(handoffPath, 'utf-8');
    const parsed = parseHandoff(handoffContent);
    handoff = {
      updated: parsed.updated,
      handoffCount: parsed.handoffCount,
      body: parsed.body,
    };
  }

  let decisionRecord: AssignmentDetail['decisionRecord'] = null;
  const decisionRecordPath = resolve(assignmentDir, 'decision-record.md');
  if (await fileExists(decisionRecordPath)) {
    const decisionRecordContent = await readFile(decisionRecordPath, 'utf-8');
    const parsed = parseDecisionRecord(decisionRecordContent);
    decisionRecord = {
      updated: parsed.updated,
      decisionCount: parsed.decisionCount,
      body: parsed.body,
    };
  }

  return {
    missionSlug,
    slug: assignment.slug || assignmentSlug,
    title: assignment.title,
    status: assignment.status as AssignmentDetail['status'],
    priority: assignment.priority as AssignmentDetail['priority'],
    assignee: assignment.assignee,
    dependsOn: assignment.dependsOn,
    blockedReason: assignment.blockedReason,
    workspace: assignment.workspace,
    externalIds: assignment.externalIds,
    tags: assignment.tags,
    created: assignment.created,
    updated: assignment.updated,
    body: assignment.body,
    plan,
    scratchpad,
    handoff,
    decisionRecord,
    availableTransitions: await getAvailableTransitions(
      missionsDir,
      missionSlug,
      assignmentSlug,
      assignment,
    ),
  };
}

async function listMissionRecords(missionsDir: string): Promise<MissionRecord[]> {
  if (!(await fileExists(missionsDir))) {
    return [];
  }

  const entries = await readdir(missionsDir, { withFileTypes: true });
  const missionDirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  const records: MissionRecord[] = [];

  for (const entry of missionDirs) {
    const missionPath = resolve(missionsDir, entry.name);
    const missionMdPath = resolve(missionPath, 'mission.md');

    if (!(await fileExists(missionMdPath))) {
      continue;
    }

    const missionContent = await readFile(missionMdPath, 'utf-8');
    const mission = parseMission(missionContent);
    const assignments = await listAssignmentRecords(missionPath);
    const rollup = buildMissionRollup(mission, assignments);
    const updated = getMissionActivityTimestamp(mission.updated, assignments);

    records.push({
      missionPath,
      mission,
      assignments,
      dependencyGraph: await loadDependencyGraph(missionPath, assignments),
      summary: {
        slug: mission.slug || entry.name,
        title: mission.title,
        status: rollup.status,
        statusOverride: mission.statusOverride,
        archived: mission.archived,
        archivedAt: mission.archivedAt,
        archivedReason: mission.archivedReason,
        created: mission.created,
        updated,
        tags: mission.tags,
        progress: rollup.progress,
        needsAttention: rollup.needsAttention,
      },
    });
  }

  records.sort((left, right) => compareTimestamps(right.summary.updated, left.summary.updated));
  return records;
}

async function listAssignmentRecords(missionPath: string): Promise<AssignmentRecord[]> {
  const assignmentsDir = resolve(missionPath, 'assignments');
  if (!(await fileExists(assignmentsDir))) {
    return [];
  }

  const entries = await readdir(assignmentsDir, { withFileTypes: true });
  const records: AssignmentRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const assignmentMd = resolve(assignmentsDir, entry.name, 'assignment.md');
    if (!(await fileExists(assignmentMd))) {
      continue;
    }

    const content = await readFile(assignmentMd, 'utf-8');
    records.push(parseAssignmentFull(content));
  }

  records.sort((left, right) => compareTimestamps(right.updated, left.updated));
  return records;
}

async function listResources(missionPath: string): Promise<ResourceSummary[]> {
  const resourcesDir = resolve(missionPath, 'resources');
  if (!(await fileExists(resourcesDir))) {
    return [];
  }

  const entries = await readdir(resourcesDir, { withFileTypes: true });
  const results: ResourceSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('_')) {
      continue;
    }

    const filePath = resolve(resourcesDir, entry.name);
    const content = await readFile(filePath, 'utf-8');
    const parsed = parseResource(content);
    results.push({
      name: parsed.name,
      slug: entry.name.replace(/\.md$/, ''),
      category: parsed.category,
      source: parsed.source,
      relatedAssignments: parsed.relatedAssignments,
      updated: parsed.updated,
    });
  }

  results.sort((left, right) => compareTimestamps(right.updated, left.updated));
  return results;
}

async function listMemories(missionPath: string): Promise<MemorySummary[]> {
  const memoriesDir = resolve(missionPath, 'memories');
  if (!(await fileExists(memoriesDir))) {
    return [];
  }

  const entries = await readdir(memoriesDir, { withFileTypes: true });
  const results: MemorySummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('_')) {
      continue;
    }

    const filePath = resolve(memoriesDir, entry.name);
    const content = await readFile(filePath, 'utf-8');
    const parsed = parseMemory(content);
    results.push({
      name: parsed.name,
      slug: entry.name.replace(/\.md$/, ''),
      source: parsed.source,
      scope: parsed.scope,
      sourceAssignment: parsed.sourceAssignment,
      updated: parsed.updated,
    });
  }

  results.sort((left, right) => compareTimestamps(right.updated, left.updated));
  return results;
}

async function loadDependencyGraph(
  missionPath: string,
  assignments: AssignmentRecord[],
): Promise<string | null> {
  const statusPath = resolve(missionPath, '_status.md');
  if (await fileExists(statusPath)) {
    const statusContent = await readFile(statusPath, 'utf-8');
    const parsed = parseStatus(statusContent);
    const derivedGraph = extractMermaidGraph(parsed.body);
    if (derivedGraph) {
      return derivedGraph;
    }
  }

  return buildDependencyGraph(assignments);
}

function buildMissionRollup(
  mission: ReturnType<typeof parseMission>,
  assignments: AssignmentRecord[],
): {
  progress: ProgressCounts;
  needsAttention: NeedsAttention;
  status: string;
} {
  const progress: ProgressCounts = {
    total: assignments.length,
    completed: 0,
    in_progress: 0,
    blocked: 0,
    pending: 0,
    review: 0,
    failed: 0,
  };

  let unansweredQuestions = 0;
  for (const assignment of assignments) {
    progress[assignment.status as keyof ProgressCounts]++;
    unansweredQuestions += countPendingAnswers(assignment.body);
  }

  const needsAttention: NeedsAttention = {
    blockedCount: progress.blocked,
    failedCount: progress.failed,
    unansweredQuestions,
  };

  let status = 'pending';
  if (mission.statusOverride) {
    status = mission.statusOverride;
  } else if (mission.archived) {
    status = 'archived';
  } else if (progress.total > 0 && progress.completed === progress.total) {
    status = 'completed';
  } else if (progress.in_progress > 0 || progress.review > 0) {
    status = 'active';
  } else if (progress.failed > 0) {
    status = 'failed';
  } else if (progress.blocked > 0) {
    status = 'blocked';
  } else if (progress.total === 0 || progress.pending === progress.total) {
    status = 'pending';
  } else {
    status = 'active';
  }

  return { progress, needsAttention, status };
}

function toAssignmentSummary(assignment: AssignmentRecord): AssignmentSummary {
  return {
    slug: assignment.slug,
    title: assignment.title,
    status: assignment.status as AssignmentSummary['status'],
    priority: assignment.priority as AssignmentSummary['priority'],
    assignee: assignment.assignee,
    dependsOn: assignment.dependsOn,
    updated: assignment.updated,
  };
}

async function toAssignmentBoardItem(
  missionsDir: string,
  missionRecord: MissionRecord,
  assignment: AssignmentRecord,
): Promise<AssignmentBoardItem> {
  return {
    ...toAssignmentSummary(assignment),
    missionSlug: missionRecord.summary.slug,
    missionTitle: missionRecord.summary.title,
    blockedReason: assignment.blockedReason,
    availableTransitions: await getAvailableTransitions(
      missionsDir,
      missionRecord.summary.slug,
      assignment.slug,
      assignment,
    ),
  };
}

function buildDependencyGraph(assignments: AssignmentRecord[]): string | null {
  const edges: string[] = [];

  for (const assignment of assignments) {
    for (const dependency of assignment.dependsOn) {
      edges.push(
        `    ${dependency}:::${findAssignmentStatus(assignments, dependency)} --> ${assignment.slug}:::${assignment.status}`,
      );
    }
  }

  if (edges.length === 0) {
    return null;
  }

  return [
    'graph TD',
    ...edges,
    '    classDef completed fill:#4ea84f,stroke:#1f6b29,color:#ffffff',
    '    classDef in_progress fill:#1e6fd9,stroke:#0f3f8f,color:#ffffff',
    '    classDef pending fill:#c0ccd9,stroke:#738399,color:#163047',
    '    classDef blocked fill:#db5a3f,stroke:#8d2815,color:#ffffff',
    '    classDef failed fill:#9f2d2d,stroke:#651616,color:#ffffff',
    '    classDef review fill:#c6911e,stroke:#7a5a10,color:#ffffff',
  ].join('\n');
}

function findAssignmentStatus(assignments: AssignmentRecord[], slug: string): AssignmentStatus {
  return (assignments.find((assignment) => assignment.slug === slug)?.status ??
    'pending') as AssignmentStatus;
}

async function getAvailableTransitions(
  missionsDir: string,
  missionSlug: string,
  assignmentSlug: string,
  assignment: AssignmentRecord,
): Promise<AssignmentTransitionAction[]> {
  const actions: AssignmentTransitionAction[] = [];
  const missionPath = resolve(missionsDir, missionSlug);

  for (const definition of TRANSITION_DEFINITIONS) {
    if (!canTransition(assignment.status as AssignmentStatus, definition.command)) {
      continue;
    }

    let warning: string | null = null;

    if (definition.command === 'start' && !assignment.assignee) {
      warning = 'No assignee set — consider assigning before starting.';
    }

    if (definition.command === 'start' && assignment.dependsOn.length > 0) {
      const unmetDependencies = await getUnmetDependencies(missionPath, assignment.dependsOn);
      if (unmetDependencies.length > 0) {
        warning = `Unmet dependencies: ${unmetDependencies.join(', ')}.`;
      }
    }

    actions.push({
      command: definition.command,
      label: definition.label,
      description: definition.description,
      targetStatus: getTargetStatus(
        assignment.status as AssignmentStatus,
        definition.command,
      ) as AssignmentStatus,
      disabled: false,
      disabledReason: null,
      warning,
      requiresReason: definition.requiresReason,
    });
  }

  return actions;
}

async function getUnmetDependencies(missionPath: string, dependsOn: string[]): Promise<string[]> {
  const unmet: string[] = [];

  for (const dependency of dependsOn) {
    const dependencyPath = resolve(missionPath, 'assignments', dependency, 'assignment.md');
    if (!(await fileExists(dependencyPath))) {
      unmet.push(`${dependency} (missing)`);
      continue;
    }

    const content = await readFile(dependencyPath, 'utf-8');
    const parsed = parseAssignmentFull(content);
    if (parsed.status !== 'completed') {
      unmet.push(`${dependency} (${parsed.status})`);
    }
  }

  return unmet;
}

function buildAttentionItems(missionRecords: MissionRecord[]): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const record of missionRecords) {
    for (const assignment of record.assignments) {
      const stale = isStale(assignment.updated);
      const base = {
        missionSlug: record.summary.slug,
        missionTitle: record.summary.title,
        assignmentSlug: assignment.slug,
        assignmentTitle: assignment.title,
        status: assignment.status as AssignmentStatus,
        updated: assignment.updated,
        href: `/missions/${record.summary.slug}/assignments/${assignment.slug}`,
        blockedReason: assignment.blockedReason,
        stale,
      };

      if (assignment.status === 'failed') {
        items.push({
          id: `${record.summary.slug}:${assignment.slug}:failed`,
          severity: 'critical',
          reason: 'Marked failed and needs a recovery decision.',
          ...base,
        });
      }

      if (assignment.status === 'blocked') {
        items.push({
          id: `${record.summary.slug}:${assignment.slug}:blocked`,
          severity: 'high',
          reason: assignment.blockedReason || 'Blocked and waiting for intervention.',
          ...base,
        });
      }

      if (assignment.status === 'review') {
        items.push({
          id: `${record.summary.slug}:${assignment.slug}:review`,
          severity: 'medium',
          reason: 'Ready for review.',
          ...base,
        });
      }

      if (stale) {
        items.push({
          id: `${record.summary.slug}:${assignment.slug}:stale`,
          severity: 'low',
          reason: 'No source updates have been recorded in the last 7 days.',
          ...base,
        });
      }
    }
  }

  return items.sort(compareAttentionItems);
}

function buildRecentActivity(missionRecords: MissionRecord[]): RecentActivityItem[] {
  const activity: RecentActivityItem[] = [];

  for (const record of missionRecords) {
    activity.push({
      id: `mission:${record.summary.slug}`,
      type: 'mission',
      title: record.summary.title,
      updated: record.summary.updated,
      href: `/missions/${record.summary.slug}`,
      missionSlug: record.summary.slug,
      missionTitle: record.summary.title,
      assignmentSlug: null,
      summary: `Mission status is ${record.summary.status}.`,
    });

    for (const assignment of record.assignments) {
      activity.push({
        id: `assignment:${record.summary.slug}:${assignment.slug}`,
        type: 'assignment',
        title: assignment.title,
        updated: assignment.updated,
        href: `/missions/${record.summary.slug}/assignments/${assignment.slug}`,
        missionSlug: record.summary.slug,
        missionTitle: record.summary.title,
        assignmentSlug: assignment.slug,
        summary: `Assignment is ${assignment.status} with ${assignment.priority} priority.`,
      });
    }
  }

  activity.sort((left, right) => compareTimestamps(right.updated, left.updated));
  return activity;
}

function compareAttentionItems(left: AttentionItem, right: AttentionItem): number {
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const severityDifference = severityRank[left.severity] - severityRank[right.severity];
  if (severityDifference !== 0) {
    return severityDifference;
  }
  return compareTimestamps(right.updated, left.updated);
}

function compareTimestamps(left: string, right: string): number {
  return parseTimestamp(left) - parseTimestamp(right);
}

function parseTimestamp(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isStale(updated: string): boolean {
  const timestamp = parseTimestamp(updated);
  if (timestamp === 0) {
    return false;
  }
  return Date.now() - timestamp > STALE_ASSIGNMENT_MS;
}

function countPendingAnswers(body: string): number {
  const matches = body.match(/^\*\*A:\*\*\s+pending\s*$/gim);
  return matches ? matches.length : 0;
}

function getMissionActivityTimestamp(missionUpdated: string, assignments: AssignmentRecord[]): string {
  let latest = missionUpdated;
  for (const assignment of assignments) {
    if (compareTimestamps(assignment.updated, latest) > 0) {
      latest = assignment.updated;
    }
  }
  return latest;
}

function getDocumentPath(
  missionsDir: string,
  documentType: EditableDocumentResponse['documentType'],
  missionSlug: string,
  assignmentSlug?: string,
): string | null {
  switch (documentType) {
    case 'mission':
      return resolve(missionsDir, missionSlug, 'mission.md');
    case 'assignment':
      return assignmentSlug
        ? resolve(missionsDir, missionSlug, 'assignments', assignmentSlug, 'assignment.md')
        : null;
    case 'plan':
      return assignmentSlug
        ? resolve(missionsDir, missionSlug, 'assignments', assignmentSlug, 'plan.md')
        : null;
    case 'scratchpad':
      return assignmentSlug
        ? resolve(missionsDir, missionSlug, 'assignments', assignmentSlug, 'scratchpad.md')
        : null;
    case 'handoff':
      return assignmentSlug
        ? resolve(missionsDir, missionSlug, 'assignments', assignmentSlug, 'handoff.md')
        : null;
    case 'decision-record':
      return assignmentSlug
        ? resolve(missionsDir, missionSlug, 'assignments', assignmentSlug, 'decision-record.md')
        : null;
    default:
      return null;
  }
}

function getEditableDocumentTitle(
  documentType: EditableDocumentResponse['documentType'],
  missionSlug: string,
  assignmentSlug?: string,
): string {
  switch (documentType) {
    case 'mission':
      return `Edit Mission: ${missionSlug}`;
    case 'assignment':
      return `Edit Assignment: ${assignmentSlug || 'assignment'}`;
    case 'plan':
      return `Edit Plan: ${assignmentSlug || 'assignment'}`;
    case 'scratchpad':
      return `Edit Scratchpad: ${assignmentSlug || 'assignment'}`;
    case 'handoff':
      return `Append Handoff: ${assignmentSlug || 'assignment'}`;
    case 'decision-record':
      return `Append Decision: ${assignmentSlug || 'assignment'}`;
    default:
      return missionSlug;
  }
}
