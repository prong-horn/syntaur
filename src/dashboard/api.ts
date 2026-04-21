import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { getTargetStatus, DEFAULT_STATUSES, DEFAULT_TRANSITION_TABLE, buildTransitionTable } from '../lifecycle/index.js';
import { fileExists } from '../utils/fs.js';
import { readConfig, type StatusConfig, type StatusTransition } from '../utils/config.js';
import { resolveAssignmentById, type ResolvedAssignment } from '../utils/assignment-resolver.js';
import {
  parseProject,
  parseStatus,
  parseAssignmentFull,
  parsePlan,
  parseScratchpad,
  parseHandoff,
  parseDecisionRecord,
  parseResource,
  parseMemory,
  parsePlaybook,
  parseProgress,
  parseComments,
  extractMermaidGraph,
} from './parser.js';
import { getDashboardHelp } from './help.js';
import type {
  AssignmentBoardItem,
  AssignmentDetail,
  AssignmentReference,
  AssignmentSummary,
  AssignmentsBoardResponse,
  AssignmentTransitionAction,
  AttentionItem,
  AttentionResponse,
  EditableDocumentResponse,
  EnrichedLink,
  HelpResponse,
  MemorySummary,
  ProjectDetail,
  ProjectSummary,
  OverviewResponse,
  ProgressCounts,
  NeedsAttention,
  RecentActivityItem,
  ResourceSummary,
  PlaybookSummary,
  PlaybookDetail,
} from './types.js';

const STALE_ASSIGNMENT_MS = 7 * 24 * 60 * 60 * 1000;
const ATTENTION_PAGE_LIMIT = 50;
const OVERVIEW_ATTENTION_LIMIT = 6;
const RECENT_PROJECTS_LIMIT = 6;
const RECENT_ACTIVITY_LIMIT = 12;

type AssignmentRecord = ReturnType<typeof parseAssignmentFull>;

interface ProjectRecord {
  projectPath: string;
  project: ReturnType<typeof parseProject>;
  assignments: AssignmentRecord[];
  summary: ProjectSummary;
  dependencyGraph: string | null;
}

/** A standalone assignment lives at `<assignmentsDir>/<uuid>/` and has no containing project. */
interface StandaloneRecord {
  assignmentDir: string;
  /** The UUID (folder name). */
  id: string;
  record: AssignmentRecord;
}

async function listStandaloneRecords(assignmentsDir: string | undefined): Promise<StandaloneRecord[]> {
  if (!assignmentsDir) return [];
  if (!(await fileExists(assignmentsDir))) return [];

  const entries = await readdir(assignmentsDir, { withFileTypes: true });
  const records: StandaloneRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const assignmentDir = resolve(assignmentsDir, entry.name);
    const assignmentMdPath = resolve(assignmentDir, 'assignment.md');
    if (!(await fileExists(assignmentMdPath))) continue;
    try {
      const content = await readFile(assignmentMdPath, 'utf-8');
      const record = parseAssignmentFull(content);
      records.push({ assignmentDir, id: entry.name, record });
    } catch {
      // skip unreadable
    }
  }

  records.sort((left, right) => compareTimestamps(right.record.updated, left.record.updated));
  return records;
}

interface AttentionSeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

const DEFAULT_TRANSITION_DEFINITIONS: Array<{
  command: string;
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
    requiresReason: true,
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

const DEFAULT_STATUS_COLORS: Record<string, string> = {
  pending: 'slate',
  in_progress: 'teal',
  blocked: 'amber',
  review: 'violet',
  completed: 'emerald',
  failed: 'rose',
};

function toTitleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function getTransitionDefinitions(config: ResolvedStatusConfig) {
  if (!config.custom) return DEFAULT_TRANSITION_DEFINITIONS;
  // Deduplicate commands from transitions
  const seen = new Set<string>();
  return config.transitions
    .filter((t) => {
      if (seen.has(t.command)) return false;
      seen.add(t.command);
      return true;
    })
    .map((t) => ({
      command: t.command,
      label: t.label ?? toTitleCase(t.command),
      description: t.description ?? `Transition via ${t.command}.`,
      requiresReason: t.requiresReason ?? false,
    }));
}

interface ResolvedStatusConfig {
  custom: boolean;
  statuses: Array<{ id: string; label: string; description?: string; color?: string; terminal?: boolean }>;
  order: string[];
  transitions: StatusTransition[];
  transitionTable: Map<string, string>;
  terminalStatuses: ReadonlySet<string>;
}

let _cachedConfig: ResolvedStatusConfig | null = null;

export async function getStatusConfig(): Promise<ResolvedStatusConfig> {
  if (_cachedConfig) return _cachedConfig;

  const config = await readConfig();

  if (config.statuses) {
    const terminalSet = new Set(
      config.statuses.statuses.filter((s) => s.terminal).map((s) => s.id),
    );
    _cachedConfig = {
      custom: true,
      statuses: config.statuses.statuses,
      order: config.statuses.order,
      transitions: config.statuses.transitions,
      transitionTable: buildTransitionTable(config.statuses.transitions),
      terminalStatuses: terminalSet.size > 0 ? terminalSet : new Set(['completed', 'failed']),
    };
  } else {
    _cachedConfig = {
      custom: false,
      statuses: DEFAULT_STATUSES.map((id) => ({
        id,
        label: toTitleCase(id),
        color: DEFAULT_STATUS_COLORS[id] ?? 'gray',
        terminal: id === 'completed' || id === 'failed',
      })),
      order: [...DEFAULT_STATUSES],
      transitions: Array.from(DEFAULT_TRANSITION_TABLE.entries()).map(([key, to]) => {
        const [from, command] = key.split(':');
        return { from, command, to };
      }),
      transitionTable: DEFAULT_TRANSITION_TABLE,
      terminalStatuses: new Set(['completed', 'failed']),
    };
  }

  return _cachedConfig;
}

export function clearStatusConfigCache(): void {
  _cachedConfig = null;
}

/**
 * List all projects with source-first summary data.
 * GET /api/projects
 */
export async function listProjects(projectsDir: string): Promise<ProjectSummary[]> {
  const projectRecords = await listProjectRecords(projectsDir);
  return projectRecords.map((record) => record.summary);
}

/**
 * Read the workspace registry file (~/.syntaur/workspaces.json).
 * Returns an array of explicitly registered workspace names.
 */
async function readWorkspaceRegistry(projectsDir: string): Promise<string[]> {
  const registryPath = resolve(dirname(projectsDir), 'workspaces.json');
  try {
    const raw = await readFile(registryPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

async function writeWorkspaceRegistry(projectsDir: string, workspaces: string[]): Promise<void> {
  const registryPath = resolve(dirname(projectsDir), 'workspaces.json');
  await writeFile(registryPath, JSON.stringify(workspaces, null, 2) + '\n', 'utf-8');
}

/**
 * List all workspaces: merge registry (explicit) with discovered (from projects).
 * GET /api/workspaces
 */
export async function listWorkspaces(projectsDir: string): Promise<{ workspaces: string[]; hasUngrouped: boolean }> {
  const [projectRecords, registered] = await Promise.all([
    listProjectRecords(projectsDir),
    readWorkspaceRegistry(projectsDir),
  ]);
  const workspaceSet = new Set<string>(registered);
  let hasUngrouped = false;
  for (const record of projectRecords) {
    if (record.project.workspace) {
      workspaceSet.add(record.project.workspace);
    } else {
      hasUngrouped = true;
    }
  }
  const workspaces = Array.from(workspaceSet).sort();
  return { workspaces, hasUngrouped };
}

/**
 * Create an empty workspace by registering it.
 * POST /api/workspaces
 */
export async function createWorkspace(projectsDir: string, name: string): Promise<void> {
  const registered = await readWorkspaceRegistry(projectsDir);
  if (!registered.includes(name)) {
    registered.push(name);
    registered.sort();
    await writeWorkspaceRegistry(projectsDir, registered);
  }
}

/**
 * Delete a workspace from the registry.
 * DELETE /api/workspaces/:name
 */
export async function deleteWorkspace(projectsDir: string, name: string): Promise<void> {
  const registered = await readWorkspaceRegistry(projectsDir);
  const filtered = registered.filter((w) => w !== name);
  await writeWorkspaceRegistry(projectsDir, filtered);
}

/**
 * Get overview data used by the app landing page.
 * GET /api/overview
 */
export async function getOverview(
  projectsDir: string,
  serversDir?: string,
  assignmentsDir?: string,
): Promise<OverviewResponse> {
  const projectRecords = await listProjectRecords(projectsDir);
  const standaloneRecords = await listStandaloneRecords(assignmentsDir);
  const attention = buildAttentionItems(projectRecords, standaloneRecords);
  const recentActivity = buildRecentActivity(projectRecords, standaloneRecords);

  let serverStats: OverviewResponse['serverStats'];
  if (serversDir) {
    try {
      const { scanAllSessions } = await import('./scanner.js');
      const servers = await scanAllSessions(serversDir, projectsDir);
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
    firstRun: projectRecords.length === 0 && standaloneRecords.length === 0,
    stats: {
      activeProjects: projectRecords.filter((record) => record.summary.status === 'active').length,
      inProgressAssignments: projectRecords.reduce(
        (total, record) => total + (record.summary.progress['in_progress'] ?? 0),
        0,
      ),
      blockedAssignments: projectRecords.reduce(
        (total, record) => total + (record.summary.progress['blocked'] ?? 0),
        0,
      ),
      reviewAssignments: projectRecords.reduce(
        (total, record) => total + (record.summary.progress['review'] ?? 0),
        0,
      ),
      failedAssignments: projectRecords.reduce(
        (total, record) => total + (record.summary.progress['failed'] ?? 0),
        0,
      ),
      staleAssignments: projectRecords.reduce(
        (total, record) =>
          total + record.assignments.filter((assignment) => isStale(assignment.updated)).length,
        0,
      ) + standaloneRecords.filter((sr) => isStale(sr.record.updated)).length,
    },
    attention: attention.slice(0, OVERVIEW_ATTENTION_LIMIT),
    recentProjects: projectRecords
      .map((record) => record.summary)
      .sort((left, right) => compareTimestamps(right.updated, left.updated))
      .slice(0, RECENT_PROJECTS_LIMIT),
    recentActivity: recentActivity.slice(0, RECENT_ACTIVITY_LIMIT),
    serverStats,
  };
}

/**
 * Get the explicit attention queue.
 * GET /api/attention
 */
export async function getAttention(
  projectsDir: string,
  serversDir?: string,
  assignmentsDir?: string,
): Promise<AttentionResponse> {
  const projectRecords = await listProjectRecords(projectsDir);
  const standaloneRecords = await listStandaloneRecords(assignmentsDir);
  const items = buildAttentionItems(projectRecords, standaloneRecords);

  if (serversDir) {
    try {
      const { scanAllSessions } = await import('./scanner.js');
      const servers = await scanAllSessions(serversDir, projectsDir);
      for (const session of servers.sessions) {
        if (!session.alive) {
          items.push({
            id: `server-dead-${session.name}`,
            severity: 'low',
            projectSlug: '',
            projectTitle: '',
            assignmentSlug: '',
            assignmentTitle: `tmux: ${session.name}`,
            status: 'failed',
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
 * Get all assignments across all projects for the global kanban board.
 * GET /api/assignments
 */
export async function listAssignmentsBoard(
  projectsDir: string,
  assignmentsDir?: string,
): Promise<AssignmentsBoardResponse> {
  const projectRecords = await listProjectRecords(projectsDir);
  const projectItems = await Promise.all(
    projectRecords.flatMap(async (record) =>
      Promise.all(
        record.assignments.map(async (assignment) =>
          toAssignmentBoardItem(projectsDir, record, assignment),
        ),
      ),
    ),
  );

  const standaloneRecords = await listStandaloneRecords(assignmentsDir);
  const standaloneItems = await Promise.all(
    standaloneRecords.map(async (sr) => toStandaloneBoardItem(sr)),
  );

  return {
    generatedAt: new Date().toISOString(),
    assignments: [...projectItems.flat(), ...standaloneItems]
      .sort((left, right) => compareTimestamps(right.updated, left.updated)),
  };
}

async function toStandaloneBoardItem(sr: StandaloneRecord): Promise<AssignmentBoardItem> {
  return {
    ...toAssignmentSummary(sr.record),
    projectSlug: null,
    projectTitle: null,
    blockedReason: sr.record.blockedReason,
    projectWorkspace: null,
    availableTransitions: await getStandaloneAvailableTransitions(sr.record),
  };
}

async function getStandaloneAvailableTransitions(
  assignment: AssignmentRecord,
): Promise<AssignmentTransitionAction[]> {
  // Standalone assignments have no dependencies, so skip dependency gating.
  const config = await getStatusConfig();
  const transitionDefs = getTransitionDefinitions(config);
  const actions: AssignmentTransitionAction[] = [];

  for (const definition of transitionDefs) {
    let warning: string | null = null;
    if (definition.command === 'start' && !assignment.assignee) {
      warning = 'No assignee set — consider assigning before starting.';
    }
    const target = getTargetStatus(assignment.status, definition.command, config.transitionTable);
    actions.push({
      command: definition.command,
      label: definition.label,
      description: definition.description,
      targetStatus: target ?? definition.command,
      disabled: false,
      disabledReason: null,
      warning,
      requiresReason: definition.requiresReason,
    });
  }

  return actions;
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
  projectsDir: string,
  documentType: EditableDocumentResponse['documentType'],
  projectSlug: string,
  assignmentSlug?: string,
): Promise<EditableDocumentResponse | null> {
  const filePath = getDocumentPath(projectsDir, documentType, projectSlug, assignmentSlug);
  if (!filePath || !(await fileExists(filePath))) {
    return null;
  }

  const content = await readFile(filePath, 'utf-8');
  const title = getEditableDocumentTitle(documentType, projectSlug, assignmentSlug);

  return {
    documentType,
    title,
    content,
    projectSlug,
    assignmentSlug,
    appendOnly: documentType === 'handoff' || documentType === 'decision-record',
  };
}

/**
 * Get full project detail with assignments, resources, and memories.
 * GET /api/projects/:slug
 */
export async function getProjectDetail(
  projectsDir: string,
  slug: string,
): Promise<ProjectDetail | null> {
  const projectPath = resolve(projectsDir, slug);
  const projectMdPath = resolve(projectPath, 'project.md');

  if (!(await fileExists(projectMdPath))) {
    return null;
  }

  const projectContent = await readFile(projectMdPath, 'utf-8');
  const project = parseProject(projectContent);
  const assignments = await listAssignmentRecords(projectPath);
  const rollup = await buildProjectRollup(projectPath, project, assignments);
  const dependencyGraph = await loadDependencyGraph(projectPath, assignments);
  const resources = await listResources(projectPath);
  const memories = await listMemories(projectPath);
  const updated = getProjectActivityTimestamp(project.updated, assignments);

  return {
    slug: project.slug || slug,
    title: project.title,
    status: rollup.status,
    statusOverride: project.statusOverride,
    archived: project.archived,
    archivedAt: project.archivedAt,
    archivedReason: project.archivedReason,
    created: project.created,
    updated,
    tags: project.tags,
    body: project.body,
    progress: rollup.progress,
    needsAttention: rollup.needsAttention,
    assignments: assignments
      .map(toAssignmentSummary)
      .sort((left, right) => compareTimestamps(right.updated, left.updated)),
    resources,
    memories,
    dependencyGraph,
    workspace: project.workspace,
  };
}

/**
 * Get full assignment detail with plan, scratchpad, handoff, and decision record.
 * GET /api/projects/:slug/assignments/:aslug
 */
export async function getAssignmentDetail(
  projectsDir: string,
  projectSlug: string,
  assignmentSlug: string,
): Promise<AssignmentDetail | null> {
  const assignmentDir = resolve(projectsDir, projectSlug, 'assignments', assignmentSlug);
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

  let progress: AssignmentDetail['progress'] = null;
  const progressPath = resolve(assignmentDir, 'progress.md');
  if (await fileExists(progressPath)) {
    const progressContent = await readFile(progressPath, 'utf-8');
    const parsed = parseProgress(progressContent);
    progress = {
      updated: parsed.updated,
      entryCount: parsed.entryCount,
      entries: parsed.entries,
    };
  }

  let comments: AssignmentDetail['comments'] = null;
  const commentsPath = resolve(assignmentDir, 'comments.md');
  if (await fileExists(commentsPath)) {
    const commentsContent = await readFile(commentsPath, 'utf-8');
    const parsed = parseComments(commentsContent);
    comments = {
      updated: parsed.updated,
      entryCount: parsed.entryCount,
      entries: parsed.entries,
    };
  }

  const detail: AssignmentDetail = {
    id: assignment.id,
    projectSlug,
    slug: assignment.slug || assignmentSlug,
    title: assignment.title,
    status: assignment.status,
    priority: assignment.priority as AssignmentDetail['priority'],
    assignee: assignment.assignee,
    dependsOn: assignment.dependsOn,
    links: assignment.links,
    reverseLinks: [],
    enrichedLinks: [],
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
    progress,
    comments,
    referencedBy: [],
    availableTransitions: await getAvailableTransitions(
      projectsDir,
      projectSlug,
      assignmentSlug,
      assignment,
    ),
  };

  // Compute reverse links and enrich all links
  const selfSlug = `${projectSlug}/${detail.slug}`;
  const projectRecords = await listProjectRecords(projectsDir);

  // Find reverse links: assignments across all projects whose links contain this assignment
  const reverseLinks: string[] = [];
  for (const mr of projectRecords) {
    for (const a of mr.assignments) {
      const qualifiedSlug = `${mr.summary.slug}/${a.slug}`;
      if (qualifiedSlug === selfSlug) continue; // skip self
      if (a.links.includes(selfSlug)) {
        reverseLinks.push(qualifiedSlug);
      }
    }
  }

  // Filter self-links and malformed links from forward links
  const isValidLinkFormat = (l: string) => {
    const parts = l.split('/');
    return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
  };
  const forwardLinks = assignment.links.filter((l) => l !== selfSlug && isValidLinkFormat(l));

  // Deduplicate: if a slug is in both forward and reverse, keep in forward only
  const forwardSet = new Set(forwardLinks);
  const dedupedReverseLinks = reverseLinks.filter((l) => !forwardSet.has(l));

  detail.links = forwardLinks;
  detail.reverseLinks = dedupedReverseLinks;

  // Build enriched links for the frontend
  const allProjectAssignments = new Map<string, { title: string; status: string }>();
  for (const mr of projectRecords) {
    for (const a of mr.assignments) {
      allProjectAssignments.set(`${mr.summary.slug}/${a.slug}`, {
        title: a.title,
        status: a.status,
      });
    }
  }

  const enrichedLinks: EnrichedLink[] = [];
  for (const linkSlug of forwardLinks) {
    const [ms, as] = linkSlug.split('/');
    const info = allProjectAssignments.get(linkSlug);
    enrichedLinks.push({
      slug: linkSlug,
      projectSlug: ms,
      assignmentSlug: as,
      title: info?.title ?? linkSlug,
      status: info?.status ?? 'pending',
      isReverse: false,
    });
  }
  for (const linkSlug of dedupedReverseLinks) {
    const [ms, as] = linkSlug.split('/');
    const info = allProjectAssignments.get(linkSlug);
    enrichedLinks.push({
      slug: linkSlug,
      projectSlug: ms,
      assignmentSlug: as,
      title: info?.title ?? linkSlug,
      status: info?.status ?? 'pending',
      isReverse: true,
    });
  }

  detail.enrichedLinks = enrichedLinks;

  // Populate referencedBy — assignments that mention this one.
  detail.referencedBy = await computeReferencedBy(
    { id: assignment.id, projectSlug, slug: detail.slug },
    projectsDir,
    undefined,
  );

  return detail;
}

const REFERENCED_BY_LIMIT = 50;

interface ReferenceTarget {
  id: string;
  projectSlug: string | null;
  slug: string;
}

/**
 * Scan every *other* assignment's Todos, progress, comments, and handoff bodies
 * for markdown links that resolve to `target`, and return an aggregated per-source
 * count (capped at 50).
 */
async function computeReferencedBy(
  target: ReferenceTarget,
  projectsDir: string,
  assignmentsDir: string | undefined,
): Promise<AssignmentReference[]> {
  const sources: Array<{
    id: string;
    slug: string;
    title: string;
    projectSlug: string | null;
    assignmentDir: string;
  }> = [];

  // project-nested
  const projectRecords = await listProjectRecords(projectsDir);
  for (const rec of projectRecords) {
    for (const a of rec.assignments) {
      sources.push({
        id: a.id,
        slug: a.slug,
        title: a.title,
        projectSlug: rec.summary.slug,
        assignmentDir: resolve(rec.projectPath, 'assignments', a.slug),
      });
    }
  }
  // standalone
  const standaloneRecords = await listStandaloneRecords(assignmentsDir);
  for (const sr of standaloneRecords) {
    sources.push({
      id: sr.id,
      slug: sr.record.slug || sr.id,
      title: sr.record.title,
      projectSlug: null,
      assignmentDir: sr.assignmentDir,
    });
  }

  const references: AssignmentReference[] = [];
  for (const source of sources) {
    if (source.id === target.id) continue; // skip self
    const mentions = await countMentionsInAssignment(source.assignmentDir, target);
    if (mentions > 0) {
      references.push({
        sourceId: source.id,
        sourceSlug: source.slug,
        sourceTitle: source.title,
        sourceProjectSlug: source.projectSlug,
        mentions,
      });
    }
    if (references.length >= REFERENCED_BY_LIMIT) break;
  }

  return references.slice(0, REFERENCED_BY_LIMIT);
}

async function countMentionsInAssignment(
  sourceDir: string,
  target: ReferenceTarget,
): Promise<number> {
  const bodies: string[] = [];

  // Todos section (from assignment.md)
  const assignmentMd = resolve(sourceDir, 'assignment.md');
  if (await fileExists(assignmentMd)) {
    const content = await readFile(assignmentMd, 'utf-8');
    const todosMatch = content.match(/^## Todos\s*$([\s\S]*?)(?=^## |$(?![\r\n]))/m);
    if (todosMatch) bodies.push(todosMatch[1]);
  }

  for (const filename of ['progress.md', 'comments.md', 'handoff.md']) {
    const path = resolve(sourceDir, filename);
    if (await fileExists(path)) {
      try {
        bodies.push(await readFile(path, 'utf-8'));
      } catch {
        // ignore
      }
    }
  }

  let total = 0;
  const patterns = buildLinkPatternsForTarget(target);
  for (const body of bodies) {
    for (const pattern of patterns) {
      const matches = body.match(pattern);
      if (matches) total += matches.length;
    }
  }
  return total;
}

function buildLinkPatternsForTarget(target: ReferenceTarget): RegExp[] {
  const patterns: RegExp[] = [];
  // Standalone absolute route
  patterns.push(new RegExp(`/assignments/${escapeRegExpLocal(target.id)}(?:/|\\b)`, 'g'));
  if (target.projectSlug) {
    // Project-nested absolute route
    patterns.push(
      new RegExp(
        `/projects/${escapeRegExpLocal(target.projectSlug)}/assignments/${escapeRegExpLocal(target.slug)}(?:/|\\b)`,
        'g',
      ),
    );
    // Project-nested relative route
    patterns.push(
      new RegExp(`\\.\\./${escapeRegExpLocal(target.slug)}(?:/|\\b)`, 'g'),
    );
  }
  return patterns;
}

function escapeRegExpLocal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve an assignment by UUID (standalone or project-nested) and return its full detail payload.
 * GET /api/assignments/:id
 */
export async function getAssignmentDetailById(
  projectsDir: string,
  assignmentsDir: string,
  id: string,
): Promise<AssignmentDetail | null> {
  const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);
  if (!resolved) return null;

  if (!resolved.standalone && resolved.projectSlug) {
    // Use the standard detail fetcher, then also scan standalone assignments
    // for backlinks.
    const detail = await getAssignmentDetail(projectsDir, resolved.projectSlug, resolved.assignmentSlug);
    if (!detail) return null;
    detail.referencedBy = await computeReferencedBy(
      { id: detail.id, projectSlug: detail.projectSlug, slug: detail.slug },
      projectsDir,
      assignmentsDir,
    );
    return detail;
  }

  // Standalone path — load companion docs directly from the resolved dir.
  const standaloneDetail = await buildStandaloneAssignmentDetail(resolved);
  if (!standaloneDetail) return null;
  standaloneDetail.referencedBy = await computeReferencedBy(
    { id: standaloneDetail.id, projectSlug: null, slug: standaloneDetail.slug },
    projectsDir,
    assignmentsDir,
  );
  return standaloneDetail;
}

async function buildStandaloneAssignmentDetail(
  resolved: ResolvedAssignment,
): Promise<AssignmentDetail | null> {
  const assignmentDir = resolved.assignmentDir;
  const assignmentMdPath = resolve(assignmentDir, 'assignment.md');
  if (!(await fileExists(assignmentMdPath))) return null;

  const assignmentContent = await readFile(assignmentMdPath, 'utf-8');
  const assignment = parseAssignmentFull(assignmentContent);

  let plan: AssignmentDetail['plan'] = null;
  const planPath = resolve(assignmentDir, 'plan.md');
  if (await fileExists(planPath)) {
    const parsed = parsePlan(await readFile(planPath, 'utf-8'));
    plan = { status: parsed.status, updated: parsed.updated, body: parsed.body };
  }

  let scratchpad: AssignmentDetail['scratchpad'] = null;
  const scratchpadPath = resolve(assignmentDir, 'scratchpad.md');
  if (await fileExists(scratchpadPath)) {
    const parsed = parseScratchpad(await readFile(scratchpadPath, 'utf-8'));
    scratchpad = { updated: parsed.updated, body: parsed.body };
  }

  let handoff: AssignmentDetail['handoff'] = null;
  const handoffPath = resolve(assignmentDir, 'handoff.md');
  if (await fileExists(handoffPath)) {
    const parsed = parseHandoff(await readFile(handoffPath, 'utf-8'));
    handoff = { updated: parsed.updated, handoffCount: parsed.handoffCount, body: parsed.body };
  }

  let decisionRecord: AssignmentDetail['decisionRecord'] = null;
  const decisionRecordPath = resolve(assignmentDir, 'decision-record.md');
  if (await fileExists(decisionRecordPath)) {
    const parsed = parseDecisionRecord(await readFile(decisionRecordPath, 'utf-8'));
    decisionRecord = { updated: parsed.updated, decisionCount: parsed.decisionCount, body: parsed.body };
  }

  let progress: AssignmentDetail['progress'] = null;
  const progressPath = resolve(assignmentDir, 'progress.md');
  if (await fileExists(progressPath)) {
    const parsed = parseProgress(await readFile(progressPath, 'utf-8'));
    progress = { updated: parsed.updated, entryCount: parsed.entryCount, entries: parsed.entries };
  }

  let comments: AssignmentDetail['comments'] = null;
  const commentsPath = resolve(assignmentDir, 'comments.md');
  if (await fileExists(commentsPath)) {
    const parsed = parseComments(await readFile(commentsPath, 'utf-8'));
    comments = { updated: parsed.updated, entryCount: parsed.entryCount, entries: parsed.entries };
  }

  const detail: AssignmentDetail = {
    id: assignment.id,
    projectSlug: null,
    slug: assignment.slug || resolved.id,
    title: assignment.title,
    status: assignment.status,
    priority: assignment.priority as AssignmentDetail['priority'],
    assignee: assignment.assignee,
    dependsOn: [], // standalone cannot declare dependencies
    links: [],
    reverseLinks: [],
    enrichedLinks: [],
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
    progress,
    comments,
    referencedBy: [],
    availableTransitions: await getStandaloneAvailableTransitions(assignment),
  };

  return detail;
}

async function listProjectRecords(projectsDir: string): Promise<ProjectRecord[]> {
  if (!(await fileExists(projectsDir))) {
    return [];
  }

  const entries = await readdir(projectsDir, { withFileTypes: true });
  const projectDirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  const records: ProjectRecord[] = [];

  for (const entry of projectDirs) {
    const projectPath = resolve(projectsDir, entry.name);
    const projectMdPath = resolve(projectPath, 'project.md');

    if (!(await fileExists(projectMdPath))) {
      continue;
    }

    const projectContent = await readFile(projectMdPath, 'utf-8');
    const project = parseProject(projectContent);
    const assignments = await listAssignmentRecords(projectPath);
    const rollup = await buildProjectRollup(projectPath, project, assignments);
    const updated = getProjectActivityTimestamp(project.updated, assignments);

    records.push({
      projectPath,
      project,
      assignments,
      dependencyGraph: await loadDependencyGraph(projectPath, assignments),
      summary: {
        slug: project.slug || entry.name,
        title: project.title,
        status: rollup.status,
        statusOverride: project.statusOverride,
        archived: project.archived,
        archivedAt: project.archivedAt,
        archivedReason: project.archivedReason,
        created: project.created,
        updated,
        tags: project.tags,
        progress: rollup.progress,
        needsAttention: rollup.needsAttention,
        workspace: project.workspace,
      },
    });
  }

  records.sort((left, right) => compareTimestamps(right.summary.updated, left.summary.updated));
  return records;
}

async function listAssignmentRecords(projectPath: string): Promise<AssignmentRecord[]> {
  const assignmentsDir = resolve(projectPath, 'assignments');
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

async function listResources(projectPath: string): Promise<ResourceSummary[]> {
  const resourcesDir = resolve(projectPath, 'resources');
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

async function listMemories(projectPath: string): Promise<MemorySummary[]> {
  const memoriesDir = resolve(projectPath, 'memories');
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
  projectPath: string,
  assignments: AssignmentRecord[],
): Promise<string | null> {
  const statusPath = resolve(projectPath, '_status.md');
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

async function buildProjectRollup(
  projectPath: string,
  project: ReturnType<typeof parseProject>,
  assignments: AssignmentRecord[],
): Promise<{
  progress: ProgressCounts;
  needsAttention: NeedsAttention;
  status: string;
}> {
  const progress: ProgressCounts = { total: assignments.length };

  let openQuestions = 0;
  for (const assignment of assignments) {
    const s = assignment.status;
    progress[s] = (progress[s] ?? 0) + 1;
    openQuestions += await countOpenQuestions(projectPath, assignment.slug);
  }

  const needsAttention: NeedsAttention = {
    blockedCount: progress['blocked'] ?? 0,
    failedCount: progress['failed'] ?? 0,
    openQuestions,
  };

  let status = 'pending';
  if (project.statusOverride) {
    status = project.statusOverride;
  } else if (project.archived) {
    status = 'archived';
  } else if (progress.total > 0 && (progress['completed'] ?? 0) === progress.total) {
    status = 'completed';
  } else if ((progress['in_progress'] ?? 0) > 0 || (progress['review'] ?? 0) > 0) {
    status = 'active';
  } else if ((progress['failed'] ?? 0) > 0) {
    status = 'failed';
  } else if ((progress['blocked'] ?? 0) > 0) {
    status = 'blocked';
  } else if (progress.total === 0 || (progress['pending'] ?? 0) === progress.total) {
    status = 'pending';
  } else {
    status = 'active';
  }

  return { progress, needsAttention, status };
}

function toAssignmentSummary(assignment: AssignmentRecord): AssignmentSummary {
  return {
    id: assignment.id,
    slug: assignment.slug,
    title: assignment.title,
    status: assignment.status,
    priority: assignment.priority as AssignmentSummary['priority'],
    assignee: assignment.assignee,
    dependsOn: assignment.dependsOn,
    links: assignment.links,
    updated: assignment.updated,
  };
}

async function toAssignmentBoardItem(
  projectsDir: string,
  projectRecord: ProjectRecord,
  assignment: AssignmentRecord,
): Promise<AssignmentBoardItem> {
  return {
    ...toAssignmentSummary(assignment),
    projectSlug: projectRecord.summary.slug,
    projectTitle: projectRecord.summary.title,
    blockedReason: assignment.blockedReason,
    projectWorkspace: projectRecord.project.workspace,
    availableTransitions: await getAvailableTransitions(
      projectsDir,
      projectRecord.summary.slug,
      assignment.slug,
      assignment,
    ),
  };
}

const DEFAULT_GRAPH_COLORS: Record<string, string> = {
  completed: 'fill:#4ea84f,stroke:#1f6b29,color:#ffffff',
  in_progress: 'fill:#1e6fd9,stroke:#0f3f8f,color:#ffffff',
  pending: 'fill:#c0ccd9,stroke:#738399,color:#163047',
  blocked: 'fill:#db5a3f,stroke:#8d2815,color:#ffffff',
  failed: 'fill:#9f2d2d,stroke:#651616,color:#ffffff',
  review: 'fill:#c6911e,stroke:#7a5a10,color:#ffffff',
};

function buildDependencyGraph(assignments: AssignmentRecord[]): string | null {
  const edges: string[] = [];
  const usedStatuses = new Set<string>();

  for (const assignment of assignments) {
    for (const dependency of assignment.dependsOn) {
      const depStatus = findAssignmentStatus(assignments, dependency);
      usedStatuses.add(depStatus);
      usedStatuses.add(assignment.status);
      edges.push(
        `    ${dependency}:::${depStatus} --> ${assignment.slug}:::${assignment.status}`,
      );
    }
  }

  if (edges.length === 0) {
    return null;
  }

  const classDefs: string[] = [];
  for (const status of usedStatuses) {
    const colors = DEFAULT_GRAPH_COLORS[status] ?? 'fill:#94a3b8,stroke:#64748b,color:#ffffff';
    classDefs.push(`    classDef ${status} ${colors}`);
  }

  return ['graph TD', ...edges, ...classDefs].join('\n');
}

function findAssignmentStatus(assignments: AssignmentRecord[], slug: string): string {
  return assignments.find((assignment) => assignment.slug === slug)?.status ?? 'pending';
}

async function getAvailableTransitions(
  projectsDir: string,
  projectSlug: string,
  assignmentSlug: string,
  assignment: AssignmentRecord,
): Promise<AssignmentTransitionAction[]> {
  const config = await getStatusConfig();
  const transitionDefs = getTransitionDefinitions(config);
  const actions: AssignmentTransitionAction[] = [];
  const projectPath = resolve(projectsDir, projectSlug);

  for (const definition of transitionDefs) {
    let warning: string | null = null;

    if (definition.command === 'start' && !assignment.assignee) {
      warning = 'No assignee set — consider assigning before starting.';
    }

    if (definition.command === 'start' && assignment.dependsOn.length > 0) {
      const unmetDependencies = await getUnmetDependencies(projectPath, assignment.dependsOn, config.terminalStatuses);
      if (unmetDependencies.length > 0) {
        warning = `Unmet dependencies: ${unmetDependencies.join(', ')}.`;
      }
    }

    const target = getTargetStatus(assignment.status, definition.command, config.transitionTable);

    actions.push({
      command: definition.command,
      label: definition.label,
      description: definition.description,
      targetStatus: target ?? definition.command,
      disabled: false,
      disabledReason: null,
      warning,
      requiresReason: definition.requiresReason,
    });
  }

  return actions;
}

async function getUnmetDependencies(projectPath: string, dependsOn: string[], terminalStatuses?: ReadonlySet<string>): Promise<string[]> {
  const terminals = terminalStatuses ?? new Set(['completed']);
  const unmet: string[] = [];

  for (const dependency of dependsOn) {
    const dependencyPath = resolve(projectPath, 'assignments', dependency, 'assignment.md');
    if (!(await fileExists(dependencyPath))) {
      unmet.push(`${dependency} (missing)`);
      continue;
    }

    const content = await readFile(dependencyPath, 'utf-8');
    const parsed = parseAssignmentFull(content);
    if (!terminals.has(parsed.status)) {
      unmet.push(`${dependency} (${parsed.status})`);
    }
  }

  return unmet;
}

function buildAttentionItems(
  projectRecords: ProjectRecord[],
  standaloneRecords: StandaloneRecord[] = [],
): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const record of projectRecords) {
    for (const assignment of record.assignments) {
      const stale = isStale(assignment.updated);
      const base = {
        projectSlug: record.summary.slug,
        projectTitle: record.summary.title,
        assignmentSlug: assignment.slug,
        assignmentTitle: assignment.title,
        status: assignment.status,
        updated: assignment.updated,
        href: `/projects/${record.summary.slug}/assignments/${assignment.slug}`,
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

  for (const sr of standaloneRecords) {
    const assignment = sr.record;
    const stale = isStale(assignment.updated);
    const base = {
      projectSlug: null,
      projectTitle: null,
      assignmentSlug: assignment.slug || sr.id,
      assignmentTitle: assignment.title,
      status: assignment.status,
      updated: assignment.updated,
      href: `/assignments/${sr.id}`,
      blockedReason: assignment.blockedReason,
      stale,
    };

    if (assignment.status === 'failed') {
      items.push({ id: `standalone:${sr.id}:failed`, severity: 'critical', reason: 'Marked failed and needs a recovery decision.', ...base });
    }
    if (assignment.status === 'blocked') {
      items.push({ id: `standalone:${sr.id}:blocked`, severity: 'high', reason: assignment.blockedReason || 'Blocked and waiting for intervention.', ...base });
    }
    if (assignment.status === 'review') {
      items.push({ id: `standalone:${sr.id}:review`, severity: 'medium', reason: 'Ready for review.', ...base });
    }
    if (stale) {
      items.push({ id: `standalone:${sr.id}:stale`, severity: 'low', reason: 'No source updates have been recorded in the last 7 days.', ...base });
    }
  }

  return items.sort(compareAttentionItems);
}

function buildRecentActivity(
  projectRecords: ProjectRecord[],
  standaloneRecords: StandaloneRecord[] = [],
): RecentActivityItem[] {
  const activity: RecentActivityItem[] = [];

  for (const record of projectRecords) {
    activity.push({
      id: `project:${record.summary.slug}`,
      type: 'project',
      title: record.summary.title,
      updated: record.summary.updated,
      href: `/projects/${record.summary.slug}`,
      projectSlug: record.summary.slug,
      projectTitle: record.summary.title,
      assignmentSlug: null,
      summary: `Project status is ${record.summary.status}.`,
    });

    for (const assignment of record.assignments) {
      activity.push({
        id: `assignment:${record.summary.slug}:${assignment.slug}`,
        type: 'assignment',
        title: assignment.title,
        updated: assignment.updated,
        href: `/projects/${record.summary.slug}/assignments/${assignment.slug}`,
        projectSlug: record.summary.slug,
        projectTitle: record.summary.title,
        assignmentSlug: assignment.slug,
        summary: `Assignment is ${assignment.status} with ${assignment.priority} priority.`,
      });
    }
  }

  for (const sr of standaloneRecords) {
    const assignment = sr.record;
    activity.push({
      id: `standalone-assignment:${sr.id}`,
      type: 'assignment',
      title: assignment.title,
      updated: assignment.updated,
      href: `/assignments/${sr.id}`,
      projectSlug: null,
      projectTitle: null,
      assignmentSlug: assignment.slug || sr.id,
      summary: `Standalone assignment is ${assignment.status} with ${assignment.priority} priority.`,
    });
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

async function countOpenQuestions(
  projectPath: string,
  assignmentSlug: string,
): Promise<number> {
  const commentsPath = resolve(
    projectPath,
    'assignments',
    assignmentSlug,
    'comments.md',
  );
  if (!(await fileExists(commentsPath))) {
    return 0;
  }
  try {
    const content = await readFile(commentsPath, 'utf-8');
    const parsed = parseComments(content);
    return parsed.entries.filter(
      (e) => e.type === 'question' && e.resolved !== true,
    ).length;
  } catch {
    return 0;
  }
}

function getProjectActivityTimestamp(projectUpdated: string, assignments: AssignmentRecord[]): string {
  let latest = projectUpdated;
  for (const assignment of assignments) {
    if (compareTimestamps(assignment.updated, latest) > 0) {
      latest = assignment.updated;
    }
  }
  return latest;
}

function getDocumentPath(
  projectsDir: string,
  documentType: EditableDocumentResponse['documentType'],
  projectSlug: string,
  assignmentSlug?: string,
): string | null {
  switch (documentType) {
    case 'project':
      return resolve(projectsDir, projectSlug, 'project.md');
    case 'assignment':
      return assignmentSlug
        ? resolve(projectsDir, projectSlug, 'assignments', assignmentSlug, 'assignment.md')
        : null;
    case 'plan':
      return assignmentSlug
        ? resolve(projectsDir, projectSlug, 'assignments', assignmentSlug, 'plan.md')
        : null;
    case 'scratchpad':
      return assignmentSlug
        ? resolve(projectsDir, projectSlug, 'assignments', assignmentSlug, 'scratchpad.md')
        : null;
    case 'handoff':
      return assignmentSlug
        ? resolve(projectsDir, projectSlug, 'assignments', assignmentSlug, 'handoff.md')
        : null;
    case 'decision-record':
      return assignmentSlug
        ? resolve(projectsDir, projectSlug, 'assignments', assignmentSlug, 'decision-record.md')
        : null;
    default:
      return null;
  }
}

function getEditableDocumentTitle(
  documentType: EditableDocumentResponse['documentType'],
  projectSlug: string,
  assignmentSlug?: string,
): string {
  switch (documentType) {
    case 'project':
      return `Edit Project: ${projectSlug}`;
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
    case 'playbook':
      return `Edit Playbook: ${projectSlug}`;
    default:
      return projectSlug;
  }
}

// --- Playbook API ---

export async function listPlaybooks(playbooksDir: string): Promise<PlaybookSummary[]> {
  if (!(await fileExists(playbooksDir))) return [];

  const entries = await readdir(playbooksDir, { withFileTypes: true });
  const playbooks: PlaybookSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('_') || entry.name === 'manifest.md') continue;

    const filePath = resolve(playbooksDir, entry.name);
    const raw = await readFile(filePath, 'utf-8');
    const parsed = parsePlaybook(raw);

    const slug = parsed.slug || entry.name.replace(/\.md$/, '');
    playbooks.push({
      slug,
      name: parsed.name || slug,
      description: parsed.description,
      whenToUse: parsed.whenToUse,
      tags: parsed.tags,
      created: parsed.created,
      updated: parsed.updated,
    });
  }

  return playbooks.sort((a, b) => (b.updated || b.created).localeCompare(a.updated || a.created));
}

export async function getPlaybookDetail(
  playbooksDir: string,
  slug: string,
): Promise<PlaybookDetail | null> {
  const filePath = resolve(playbooksDir, `${slug}.md`);
  if (!(await fileExists(filePath))) return null;

  const raw = await readFile(filePath, 'utf-8');
  const parsed = parsePlaybook(raw);

  return {
    slug: parsed.slug || slug,
    name: parsed.name || slug,
    description: parsed.description,
    whenToUse: parsed.whenToUse,
    tags: parsed.tags,
    created: parsed.created,
    updated: parsed.updated,
    body: parsed.body,
  };
}
