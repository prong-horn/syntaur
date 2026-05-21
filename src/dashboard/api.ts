import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { getTargetStatus, DEFAULT_STATUSES, DEFAULT_TRANSITION_TABLE, buildTransitionTable } from '../lifecycle/index.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { readConfig, type StatusConfig, type StatusTransition } from '../utils/config.js';
import { resolvePlaybookSlug } from '../utils/playbooks.js';
import { migrateLegacyProjectFiles } from '../utils/fs-migration.js';
import { resolveAssignmentById, type ResolvedAssignment } from '../utils/assignment-resolver.js';

/**
 * Thrown by `deleteWorkspace` when references exist and cascade is false.
 * Routers map this to a 409 response carrying the blocker payload.
 */
export class WorkspaceBlockedError extends Error {
  readonly blockedBy: { projects: string[]; standalones: string[] };
  constructor(blockedBy: { projects: string[]; standalones: string[] }) {
    super(
      `Workspace is referenced by ${blockedBy.projects.length} project(s) and ${blockedBy.standalones.length} standalone(s).`,
    );
    this.name = 'WorkspaceBlockedError';
    this.blockedBy = blockedBy;
  }
}

/**
 * Clear a single top-level frontmatter scalar field (regex-replace; assumes
 * the file already starts with `---` and the field exists). Used by the
 * cascade workspace delete to set `workspace:`/`workspaceGroup:` to `null`.
 */
function clearFrontmatterField(content: string, key: string): string {
  const fieldRegex = new RegExp(`^(${escapeRegExp(key)}:)\\s*.*$`, 'm');
  return content.replace(fieldRegex, `$1 null`);
}

function setUpdatedField(content: string, value: string): string {
  const fieldRegex = /^(updated:)\s*.*$/m;
  if (fieldRegex.test(content)) {
    return content.replace(fieldRegex, `$1 "${value}"`);
  }
  return content;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
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
  EditableDocumentResponse,
  EnrichedLink,
  HelpResponse,
  MemoryDetail,
  MemorySummary,
  MemorySummaryWithProject,
  ProjectDetail,
  ProjectSummary,
  OverviewResponse,
  OverviewSegmentId,
  OverviewSegments,
  OverviewHeroRecommendation,
  OverviewHeroKind,
  OverviewSegmentPayload,
  OverviewStaleSegmentPayload,
  ProgressCounts,
  NeedsAttention,
  RecentActivityItem,
  ResourceDetail,
  ResourceSummary,
  ResourceSummaryWithProject,
  PlaybookSummary,
  PlaybookDetail,
} from './types.js';
import { listAllSessions } from './agent-sessions.js';
import { SEGMENT_REASON } from './overviewCopy.js';

const STALE_ASSIGNMENT_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_PROJECTS_LIMIT = 6;
const RECENT_ACTIVITY_LIMIT = 12;
const RECENT_SESSIONS_LIMIT = 10;
const NEWEST_CREATED_LIMIT = 5;
const SEGMENT_DISPLAY_CAP = 5;
const STALE_LIMIT_DEFAULT = 50;
const STALE_LIMIT_MAX = 200;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'archived']);

// ---------------------------------------------------------------------------
// Overview perf instrumentation (opt-in via SYNTAUR_PERF_TRACE=1).
// Used by getOverview() and helpers it calls. Inactive when traces is undefined.
// ---------------------------------------------------------------------------

interface TraceEntry {
  label: string;
  ms: number;
}

interface OverviewTraces {
  entries: TraceEntry[];
  subPhases: Map<string, number>;
}

function createTraces(): OverviewTraces {
  return { entries: [], subPhases: new Map() };
}

async function timed<T>(
  traces: OverviewTraces | undefined,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!traces) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    traces.entries.push({ label, ms: performance.now() - start });
  }
}

function accumulatePhase(
  traces: OverviewTraces | undefined,
  label: string,
  ms: number,
): void {
  if (!traces) return;
  traces.subPhases.set(label, (traces.subPhases.get(label) ?? 0) + ms);
}

function emitTrace(traces: OverviewTraces, meta: Record<string, unknown>): void {
  if (process.env.SYNTAUR_PERF_TRACE !== '1') return;
  const totalMs = traces.entries.reduce((sum, entry) => sum + entry.ms, 0);
  const subPhases = Object.fromEntries(traces.subPhases);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({ kind: 'overview-trace', totalMs, phases: traces.entries, subPhases, ...meta }),
  );
}

const STATUS_TO_SEGMENT: Readonly<Record<string, OverviewSegmentId>> = {
  review: 'readyForReview',
  ready_to_implement: 'readyToImplement',
  ready_for_planning: 'readyForPlanning',
  in_progress: 'inProgress',
  draft: 'drafts',
  blocked: 'blocked',
};

const HERO_PRIORITY: ReadonlyArray<[OverviewSegmentId, OverviewHeroKind]> = [
  ['readyForReview', 'review'],
  ['readyToImplement', 'ready_to_implement'],
  ['readyForPlanning', 'ready_for_planning'],
  ['inProgress', 'in_progress'],
  ['drafts', 'draft'],
  ['blocked', 'blocked'],
  ['stale', 'stale'],
];

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
    command: 'shape',
    label: 'Shape',
    description: 'Promote a draft assignment to ready_for_planning once the Objective and Acceptance Criteria are fleshed out.',
    requiresReason: false,
  },
  {
    command: 'plan-ready',
    label: 'Plan Ready',
    description: 'Promote a ready_for_planning assignment to ready_to_implement after the plan is written and approved.',
    requiresReason: false,
  },
  {
    command: 'implement',
    label: 'Implement',
    description: 'Move a ready_to_implement assignment into in_progress when coding begins.',
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
 * List all workspaces: merge registry (explicit) with workspaces discovered from
 * project `workspace:` fields and standalone-assignment `workspaceGroup` fields.
 * Standalones with no `workspaceGroup` contribute to `hasUngrouped`.
 * GET /api/workspaces
 */
export async function listWorkspaces(
  projectsDir: string,
  assignmentsDir?: string,
): Promise<{ workspaces: string[]; hasUngrouped: boolean }> {
  const [projectRecords, registered, standaloneRecords] = await Promise.all([
    listProjectRecords(projectsDir),
    readWorkspaceRegistry(projectsDir),
    listStandaloneRecords(assignmentsDir),
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
  for (const sr of standaloneRecords) {
    if (sr.record.workspaceGroup) {
      workspaceSet.add(sr.record.workspaceGroup);
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
 *
 * Modes:
 * - `cascade: false` (default): if any project or standalone still references
 *   this workspace, throw `WorkspaceBlockedError` with the blocker lists.
 *   Otherwise remove from the registry.
 * - `cascade: true`: rewrite every referencing project's `workspace:` field
 *   and every referencing standalone's `workspaceGroup:` field to `null`,
 *   then remove the registry entry.
 *
 * Returns `{ rewroteFiles }` so callers (server.ts) can decide whether the
 * explicit registry-level broadcast is still needed (watchers already emit
 * project-updated/assignment-updated for rewritten files).
 *
 * DELETE /api/workspaces/:name[?cascade=true]
 */
export async function deleteWorkspace(
  projectsDir: string,
  name: string,
  opts: { cascade?: boolean; assignmentsDir?: string } = {},
): Promise<{ rewroteFiles: boolean }> {
  const cascade = Boolean(opts.cascade);
  const projectRecords = await listProjectRecords(projectsDir);
  const standaloneRecords = await listStandaloneRecords(opts.assignmentsDir);

  const projectsReferencing = projectRecords
    .filter((record) => record.project.workspace === name)
    .map((record) => record.project.slug);
  const standalonesReferencing = standaloneRecords
    .filter((record) => record.record.workspaceGroup === name)
    .map((record) => record.id);

  if (projectsReferencing.length + standalonesReferencing.length > 0 && !cascade) {
    throw new WorkspaceBlockedError({
      projects: projectsReferencing,
      standalones: standalonesReferencing,
    });
  }

  let rewroteFiles = false;
  if (cascade) {
    const timestamp = nowTimestamp();

    for (const slug of projectsReferencing) {
      const path = resolve(projectsDir, slug, 'project.md');
      const raw = await readFile(path, 'utf-8');
      let next = clearFrontmatterField(raw, 'workspace');
      next = setUpdatedField(next, timestamp);
      await writeFileForce(path, next);
      rewroteFiles = true;
    }

    for (const id of standalonesReferencing) {
      if (!opts.assignmentsDir) break;
      const path = resolve(opts.assignmentsDir, id, 'assignment.md');
      const raw = await readFile(path, 'utf-8');
      let next = clearFrontmatterField(raw, 'workspaceGroup');
      next = setUpdatedField(next, timestamp);
      await writeFileForce(path, next);
      rewroteFiles = true;
    }
  }

  const registered = await readWorkspaceRegistry(projectsDir);
  const filtered = registered.filter((w) => w !== name);
  await writeWorkspaceRegistry(projectsDir, filtered);

  return { rewroteFiles };
}

/**
 * Get overview data used by the app landing page.
 * GET /api/overview?staleLimit=&staleOffset=
 */
export async function getOverview(
  projectsDir: string,
  serversDir?: string,
  assignmentsDir?: string,
  options: { staleLimit?: number; staleOffset?: number } = {},
): Promise<OverviewResponse> {
  const traceEnabled = process.env.SYNTAUR_PERF_TRACE === '1';
  const traces: OverviewTraces | undefined = traceEnabled ? createTraces() : undefined;
  const overallStart = traceEnabled ? performance.now() : 0;

  const projectRecords = await timed(traces, 'list-project-records', () =>
    listProjectRecords(projectsDir, traces),
  );
  const standaloneRecords = await timed(traces, 'list-standalone-records', () =>
    listStandaloneRecords(assignmentsDir),
  );
  const recentActivity = buildRecentActivity(projectRecords, standaloneRecords);

  const staleLimit = clamp(
    Number.isFinite(options.staleLimit) ? Number(options.staleLimit) : STALE_LIMIT_DEFAULT,
    1,
    STALE_LIMIT_MAX,
  );
  const staleOffset = Math.max(0, Number.isFinite(options.staleOffset) ? Number(options.staleOffset) : 0);

  const buckets = await timed(traces, 'build-segment-buckets', () =>
    buildOverviewSegmentBuckets(projectsDir, projectRecords, standaloneRecords, traces),
  );
  const segments = toOverviewSegments(buckets, { staleLimit, staleOffset });
  const hero = pickOverviewHero(buckets);

  let recentSessions: OverviewResponse['recentSessions'] = [];
  try {
    const all = await timed(traces, 'list-recent-sessions', () => listAllSessions(projectsDir));
    recentSessions = all.slice(0, RECENT_SESSIONS_LIMIT);
  } catch {
    // Sessions failure should not break overview.
  }

  let serverStats: OverviewResponse['serverStats'];
  if (serversDir) {
    try {
      const { scanAllSessions } = await import('./scanner.js');
      const servers = await timed(traces, 'scan-tmux-sessions', () =>
        scanAllSessions(serversDir, projectsDir, { assignmentsDir }),
      );
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

  if (traces) {
    const wallMs = performance.now() - overallStart;
    const totalAssignments =
      projectRecords.reduce((sum, r) => sum + r.assignments.length, 0) + standaloneRecords.length;
    emitTrace(traces, {
      wallMs,
      fixture: { projects: projectRecords.length, assignments: totalAssignments },
    });
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
    hero,
    segments,
    recentSessions,
    recentProjects: projectRecords
      .map((record) => record.summary)
      .sort((left, right) => compareTimestamps(right.updated, left.updated))
      .slice(0, RECENT_PROJECTS_LIMIT),
    recentActivity: recentActivity.slice(0, RECENT_ACTIVITY_LIMIT),
    serverStats,
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
    projectWorkspace: sr.record.workspaceGroup ?? null,
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
    const target = getTargetStatus(assignment.status, definition.command, config.transitionTable);
    // Only valid transitions reach the client; the kanban inline picker renders them directly.
    if (target === null) continue;

    let warning: string | null = null;
    if (definition.command === 'start' && !assignment.assignee) {
      warning = 'No assignee set — consider assigning before starting.';
    }
    actions.push({
      command: definition.command,
      label: definition.label,
      description: definition.description,
      targetStatus: target,
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
 * Resolve an assignment by UUID (standalone or project-nested) and return its
 * editable document payload for the given type.
 */
export async function getEditableDocumentById(
  projectsDir: string,
  assignmentsDir: string,
  documentType: EditableDocumentResponse['documentType'],
  id: string,
): Promise<EditableDocumentResponse | null> {
  const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);
  if (!resolved) return null;

  if (!resolved.standalone && resolved.projectSlug) {
    return getEditableDocument(
      projectsDir,
      documentType,
      resolved.projectSlug,
      resolved.assignmentSlug,
    );
  }

  const fileName =
    documentType === 'assignment'
      ? 'assignment.md'
      : documentType === 'plan'
        ? 'plan.md'
        : documentType === 'scratchpad'
          ? 'scratchpad.md'
          : documentType === 'handoff'
            ? 'handoff.md'
            : documentType === 'decision-record'
              ? 'decision-record.md'
              : null;
  if (!fileName) return null;
  const filePath = resolve(resolved.assignmentDir, fileName);
  if (!(await fileExists(filePath))) return null;

  const content = await readFile(filePath, 'utf-8');
  const label = resolved.id;
  const title =
    documentType === 'assignment'
      ? `Edit Assignment: ${label}`
      : documentType === 'plan'
        ? `Edit Plan: ${label}`
        : documentType === 'scratchpad'
          ? `Edit Scratchpad: ${label}`
          : documentType === 'handoff'
            ? `Append Handoff: ${label}`
            : `Append Decision: ${label}`;

  return {
    documentType,
    title,
    content,
    projectSlug: null,
    assignmentSlug: undefined,
    assignmentId: resolved.id,
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
    externalIds: project.externalIds,
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
    repositories: project.repositories,
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

  let projectWorkspace: string | null = null;
  const projectMdPath = resolve(projectsDir, projectSlug, 'project.md');
  if (await fileExists(projectMdPath)) {
    const projectContent = await readFile(projectMdPath, 'utf-8');
    projectWorkspace = parseProject(projectContent).workspace;
  }

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
    projectWorkspace,
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
    projectWorkspace: assignment.workspaceGroup,
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

// Guard so legacy-file renames run at most once per `projectsDir` per process
// lifetime. Keyed by absolute path to tolerate test suites that open multiple
// sandboxes in the same process.
const migratedProjectsDirs = new Set<string>();

async function listProjectRecords(
  projectsDir: string,
  traces?: OverviewTraces,
): Promise<ProjectRecord[]> {
  if (!(await fileExists(projectsDir))) {
    return [];
  }

  if (!migratedProjectsDirs.has(projectsDir)) {
    migratedProjectsDirs.add(projectsDir);
    await migrateLegacyProjectFiles(projectsDir);
  }

  const entries = await readdir(projectsDir, { withFileTypes: true });
  const projectDirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));

  const maybeRecords = await Promise.all(
    projectDirs.map(async (entry): Promise<ProjectRecord | null> => {
      const projectPath = resolve(projectsDir, entry.name);
      const projectMdPath = resolve(projectPath, 'project.md');

      if (!(await fileExists(projectMdPath))) {
        return null;
      }

      const t0 = traces ? performance.now() : 0;
      const projectContent = await readFile(projectMdPath, 'utf-8');
      const project = parseProject(projectContent);
      if (traces) accumulatePhase(traces, 'parse-project-md', performance.now() - t0);

      const t1 = traces ? performance.now() : 0;
      const assignments = await listAssignmentRecords(projectPath, traces);
      if (traces) accumulatePhase(traces, 'list-assignments', performance.now() - t1);

      const t2 = traces ? performance.now() : 0;
      const rollup = await buildProjectRollup(projectPath, project, assignments, traces);
      if (traces) accumulatePhase(traces, 'build-rollup', performance.now() - t2);

      const updated = getProjectActivityTimestamp(project.updated, assignments);

      const t3 = traces ? performance.now() : 0;
      const dependencyGraph = await loadDependencyGraph(projectPath, assignments);
      if (traces) accumulatePhase(traces, 'load-dep-graph', performance.now() - t3);

      return {
        projectPath,
        project,
        assignments,
        dependencyGraph,
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
      };
    }),
  );

  const records = maybeRecords.filter((r): r is ProjectRecord => r !== null);
  records.sort((left, right) => compareTimestamps(right.summary.updated, left.summary.updated));
  return records;
}

async function listAssignmentRecords(
  projectPath: string,
  traces?: OverviewTraces,
): Promise<AssignmentRecord[]> {
  const assignmentsDir = resolve(projectPath, 'assignments');
  if (!(await fileExists(assignmentsDir))) {
    return [];
  }

  const entries = await readdir(assignmentsDir, { withFileTypes: true });
  const dirEntries = entries.filter((entry) => entry.isDirectory());

  const maybeRecords = await Promise.all(
    dirEntries.map(async (entry): Promise<AssignmentRecord | null> => {
      const assignmentMd = resolve(assignmentsDir, entry.name, 'assignment.md');
      if (!(await fileExists(assignmentMd))) {
        return null;
      }
      const t0 = traces ? performance.now() : 0;
      const content = await readFile(assignmentMd, 'utf-8');
      const parsed = parseAssignmentFull(content);
      if (traces) accumulatePhase(traces, 'read-assignment-md', performance.now() - t0);
      return parsed;
    }),
  );

  const records = maybeRecords.filter((r): r is AssignmentRecord => r !== null);
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
      relatedAssignments: parsed.relatedAssignments,
      updated: parsed.updated,
    });
  }

  results.sort((left, right) => compareTimestamps(right.updated, left.updated));
  return results;
}

/**
 * Walk every project and return its memories enriched with project context.
 *
 * `projectSlug` is the on-disk directory name (used for path-based routes like
 * `/api/projects/:slug/memories/:itemSlug` and the `/projects/:slug/...` UI routes).
 * In typical projects this equals the frontmatter `slug`, but fixtures/legacy projects
 * may differ — and the directory name is what every path-based route resolves against.
 */
export async function listAllMemories(
  projectsDir: string,
): Promise<MemorySummaryWithProject[]> {
  const projectRecords = await listProjectRecords(projectsDir);
  const all: MemorySummaryWithProject[] = [];
  for (const record of projectRecords) {
    const memories = await listMemories(record.projectPath);
    for (const memory of memories) {
      all.push({
        ...memory,
        projectSlug: basename(record.projectPath),
        projectTitle: record.summary.title,
      });
    }
  }
  all.sort((left, right) => compareTimestamps(right.updated, left.updated));
  return all;
}

/** Walk every project and return its resources enriched with project context. */
export async function listAllResources(
  projectsDir: string,
): Promise<ResourceSummaryWithProject[]> {
  const projectRecords = await listProjectRecords(projectsDir);
  const all: ResourceSummaryWithProject[] = [];
  for (const record of projectRecords) {
    const resources = await listResources(record.projectPath);
    for (const resource of resources) {
      all.push({
        ...resource,
        projectSlug: basename(record.projectPath),
        projectTitle: record.summary.title,
      });
    }
  }
  all.sort((left, right) => compareTimestamps(right.updated, left.updated));
  return all;
}

/**
 * Resolve a project slug to its on-disk directory path.
 * Tries the dir-name match first (the typical case); falls back to scanning every project
 * for a frontmatter-slug match. Returns `null` when no project matches.
 */
export async function resolveProjectPath(
  projectsDir: string,
  projectSlug: string,
): Promise<string | null> {
  const direct = resolve(projectsDir, projectSlug);
  if (await fileExists(resolve(direct, 'project.md'))) return direct;
  const records = await listProjectRecords(projectsDir);
  const match = records.find((r) => r.summary.slug === projectSlug);
  return match ? match.projectPath : null;
}

export async function getMemoryDetail(
  projectsDir: string,
  projectSlug: string,
  itemSlug: string,
): Promise<MemoryDetail | null> {
  if (itemSlug.startsWith('_')) return null;

  const projectRecords = await listProjectRecords(projectsDir);
  // Match by directory name first (the path-based routing convention) and fall back to
  // the frontmatter slug — covers fixtures/legacy projects whose dir name differs from slug.
  const projectRecord = projectRecords.find(
    (p) => basename(p.projectPath) === projectSlug || p.summary.slug === projectSlug,
  );
  if (!projectRecord) return null;

  const filePath = resolve(projectRecord.projectPath, 'memories', `${itemSlug}.md`);
  if (!(await fileExists(filePath))) return null;

  const content = await readFile(filePath, 'utf-8');
  const parsed = parseMemory(content);
  return {
    name: parsed.name,
    slug: itemSlug,
    source: parsed.source,
    scope: parsed.scope,
    sourceAssignment: parsed.sourceAssignment,
    relatedAssignments: parsed.relatedAssignments,
    updated: parsed.updated,
    created: parsed.created,
    body: parsed.body,
    tags: parsed.tags,
    projectSlug: basename(projectRecord.projectPath),
    projectTitle: projectRecord.summary.title,
  };
}

export async function getResourceDetail(
  projectsDir: string,
  projectSlug: string,
  itemSlug: string,
): Promise<ResourceDetail | null> {
  if (itemSlug.startsWith('_')) return null;

  const projectRecords = await listProjectRecords(projectsDir);
  const projectRecord = projectRecords.find(
    (p) => basename(p.projectPath) === projectSlug || p.summary.slug === projectSlug,
  );
  if (!projectRecord) return null;

  const filePath = resolve(projectRecord.projectPath, 'resources', `${itemSlug}.md`);
  if (!(await fileExists(filePath))) return null;

  const content = await readFile(filePath, 'utf-8');
  const parsed = parseResource(content);
  return {
    name: parsed.name,
    slug: itemSlug,
    category: parsed.category,
    source: parsed.source,
    relatedAssignments: parsed.relatedAssignments,
    updated: parsed.updated,
    created: parsed.created,
    body: parsed.body,
    projectSlug: basename(projectRecord.projectPath),
    projectTitle: projectRecord.summary.title,
  };
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
  traces?: OverviewTraces,
): Promise<{
  progress: ProgressCounts;
  needsAttention: NeedsAttention;
  status: string;
}> {
  const progress: ProgressCounts = { total: assignments.length };

  // Map: read every comments.md in parallel. Reduce: fold the per-assignment
  // results into progress counters + openQuestions sum.
  const perAssignment = await Promise.all(
    assignments.map(async (assignment) => {
      const t0 = traces ? performance.now() : 0;
      const openQuestions = await countOpenQuestions(projectPath, assignment.slug);
      if (traces) accumulatePhase(traces, 'count-open-questions', performance.now() - t0);
      return { status: assignment.status, openQuestions };
    }),
  );

  let openQuestions = 0;
  for (const entry of perAssignment) {
    progress[entry.status] = (progress[entry.status] ?? 0) + 1;
    openQuestions += entry.openQuestions;
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
  options?: {
    dependencyStatusMap?: ReadonlyMap<string, string>;
    traces?: OverviewTraces;
  },
): Promise<AssignmentTransitionAction[]> {
  const config = await getStatusConfig();
  const transitionDefs = getTransitionDefinitions(config);
  const actions: AssignmentTransitionAction[] = [];
  const projectPath = resolve(projectsDir, projectSlug);
  const traces = options?.traces;

  for (const definition of transitionDefs) {
    const target = getTargetStatus(assignment.status, definition.command, config.transitionTable);
    // Only valid transitions reach the client; the kanban inline picker renders them directly.
    if (target === null) continue;

    let warning: string | null = null;

    if (definition.command === 'start' && !assignment.assignee) {
      warning = 'No assignee set — consider assigning before starting.';
    }

    if (definition.command === 'start' && assignment.dependsOn.length > 0) {
      const t0 = traces ? performance.now() : 0;
      const unmetDependencies = await getUnmetDependencies(
        projectPath,
        assignment.dependsOn,
        config.terminalStatuses,
        options?.dependencyStatusMap,
      );
      if (traces) accumulatePhase(traces, 'get-unmet-dependencies', performance.now() - t0);
      if (unmetDependencies.length > 0) {
        warning = `Unmet dependencies: ${unmetDependencies.join(', ')}.`;
      }
    }

    actions.push({
      command: definition.command,
      label: definition.label,
      description: definition.description,
      targetStatus: target,
      disabled: false,
      disabledReason: null,
      warning,
      requiresReason: definition.requiresReason,
    });
  }

  return actions;
}

async function getUnmetDependencies(
  projectPath: string,
  dependsOn: string[],
  terminalStatuses?: ReadonlySet<string>,
  dependencyStatusMap?: ReadonlyMap<string, string>,
): Promise<string[]> {
  const terminals = terminalStatuses ?? new Set(['completed']);
  const unmet: string[] = [];

  for (const dependency of dependsOn) {
    // Fast path: in-memory map (built once by the overview pass over already-parsed records).
    if (dependencyStatusMap) {
      const mappedStatus = dependencyStatusMap.get(dependency);
      if (mappedStatus !== undefined) {
        if (!terminals.has(mappedStatus)) {
          unmet.push(`${dependency} (${mappedStatus})`);
        }
        continue;
      }
      // Fall through to disk read only if the map didn't know about this dependency.
    }

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

interface OverviewSegmentBuckets {
  readyForReview: AttentionItem[];
  readyToImplement: AttentionItem[];
  readyForPlanning: AttentionItem[];
  inProgress: AttentionItem[];
  drafts: AttentionItem[];
  blocked: AttentionItem[];
  newestCreated: AttentionItem[];
  stale: AttentionItem[];
}

function emptyBuckets(): OverviewSegmentBuckets {
  return {
    readyForReview: [],
    readyToImplement: [],
    readyForPlanning: [],
    inProgress: [],
    drafts: [],
    blocked: [],
    newestCreated: [],
    stale: [],
  };
}

function segmentSeverity(segment: OverviewSegmentId): AttentionItem['severity'] {
  switch (segment) {
    case 'blocked':
      return 'high';
    case 'readyForReview':
      return 'medium';
    case 'stale':
      return 'low';
    default:
      return 'medium';
  }
}

async function buildOverviewSegmentBuckets(
  projectsDir: string,
  projectRecords: ProjectRecord[],
  standaloneRecords: StandaloneRecord[],
  traces?: OverviewTraces,
): Promise<OverviewSegmentBuckets> {
  const now = Date.now();
  const buckets = emptyBuckets();
  // Pool of all non-terminal rows (across primary segments) used to seed
  // `newestCreated`. Each entry remembers its `created` timestamp + the row
  // we'd clone into the segment.
  const newestPool: Array<{ created: string; clone: AttentionItem }> = [];

  for (const record of projectRecords) {
    // Build a dep-status map once per project so getUnmetDependencies can resolve
    // dependency status from memory instead of re-reading each dep's assignment.md.
    const depMap = new Map<string, string>();
    for (const a of record.assignments) {
      depMap.set(a.slug, a.status);
    }

    // Resolve every per-assignment getAvailableTransitions call for this project
    // in parallel, then run the synchronous classification logic below over the results.
    const resolvedTransitions = await Promise.all(
      record.assignments.map(async (assignment) => {
        const t0 = traces ? performance.now() : 0;
        const availableTransitions = await getAvailableTransitions(
          projectsDir,
          record.summary.slug,
          assignment.slug,
          assignment,
          { traces, dependencyStatusMap: depMap },
        );
        if (traces) accumulatePhase(traces, 'get-available-transitions', performance.now() - t0);
        return { assignment, availableTransitions };
      }),
    );

    for (const { assignment, availableTransitions } of resolvedTransitions) {
      const segmentId = STATUS_TO_SEGMENT[assignment.status];
      const stale = isStale(assignment.updated);
      const isTerminal = TERMINAL_STATUSES.has(assignment.status);
      const agingMs = Math.max(0, now - parseTimestamp(assignment.updated));
      const baseId = `${record.summary.slug}:${assignment.slug}`;

      const shared = {
        projectSlug: record.summary.slug,
        projectTitle: record.summary.title,
        assignmentSlug: assignment.slug,
        assignmentTitle: assignment.title,
        status: assignment.status,
        updated: assignment.updated,
        href: `/projects/${record.summary.slug}/assignments/${assignment.slug}`,
        blockedReason: assignment.blockedReason,
        stale,
        agingMs,
        assignee: assignment.assignee ?? null,
        availableTransitions,
      };

      if (segmentId) {
        const reason =
          segmentId === 'blocked' && assignment.blockedReason
            ? assignment.blockedReason
            : SEGMENT_REASON[segmentId];
        const primary: AttentionItem = {
          ...shared,
          id: `${baseId}:${segmentId}`,
          severity: segmentSeverity(segmentId),
          reason,
          segment: segmentId,
        };
        buckets[segmentId].push(primary);
      }

      if (stale && !isTerminal) {
        const staleItem: AttentionItem = {
          ...shared,
          id: `${baseId}:stale`,
          severity: 'low',
          reason: SEGMENT_REASON.stale,
          segment: 'stale',
        };
        buckets.stale.push(staleItem);
      }

      if (!isTerminal) {
        newestPool.push({
          created: assignment.created,
          clone: {
            ...shared,
            id: `${baseId}:newest`,
            severity: 'low',
            reason: SEGMENT_REASON.newestCreated,
            segment: 'newestCreated',
          },
        });
      }
    }
  }

  const resolvedStandaloneTransitions = await Promise.all(
    standaloneRecords.map(async (sr) => {
      const t0 = traces ? performance.now() : 0;
      const availableTransitions = await getStandaloneAvailableTransitions(sr.record);
      if (traces) accumulatePhase(traces, 'get-available-transitions', performance.now() - t0);
      return { sr, availableTransitions };
    }),
  );

  for (const { sr, availableTransitions } of resolvedStandaloneTransitions) {
    const assignment = sr.record;
    const segmentId = STATUS_TO_SEGMENT[assignment.status];
    const stale = isStale(assignment.updated);
    const isTerminal = TERMINAL_STATUSES.has(assignment.status);
    const agingMs = Math.max(0, now - parseTimestamp(assignment.updated));
    const baseId = `standalone:${sr.id}`;

    const shared = {
      projectSlug: null,
      projectTitle: null,
      assignmentSlug: assignment.slug || sr.id,
      assignmentTitle: assignment.title,
      status: assignment.status,
      updated: assignment.updated,
      href: `/assignments/${sr.id}`,
      blockedReason: assignment.blockedReason,
      stale,
      agingMs,
      assignee: assignment.assignee ?? null,
      availableTransitions,
    };

    if (segmentId) {
      const reason =
        segmentId === 'blocked' && assignment.blockedReason
          ? assignment.blockedReason
          : SEGMENT_REASON[segmentId];
      buckets[segmentId].push({
        ...shared,
        id: `${baseId}:${segmentId}`,
        severity: segmentSeverity(segmentId),
        reason,
        segment: segmentId,
      });
    }

    if (stale && !isTerminal) {
      buckets.stale.push({
        ...shared,
        id: `${baseId}:stale`,
        severity: 'low',
        reason: SEGMENT_REASON.stale,
        segment: 'stale',
      });
    }

    if (!isTerminal) {
      newestPool.push({
        created: assignment.created,
        clone: {
          ...shared,
          id: `${baseId}:newest`,
          severity: 'low',
          reason: SEGMENT_REASON.newestCreated,
          segment: 'newestCreated',
        },
      });
    }
  }

  newestPool.sort((a, b) => compareTimestamps(b.created, a.created));
  buckets.newestCreated = newestPool.slice(0, NEWEST_CREATED_LIMIT).map((entry) => entry.clone);

  for (const key of Object.keys(buckets) as OverviewSegmentId[]) {
    if (key === 'newestCreated') continue; // already sorted by `created`
    if (key === 'stale') {
      buckets[key].sort((a, b) => b.agingMs - a.agingMs);
      continue;
    }
    buckets[key].sort((a, b) => compareTimestamps(b.updated, a.updated));
  }

  return buckets;
}

function toOverviewSegments(
  buckets: OverviewSegmentBuckets,
  staleOpts: { staleLimit: number; staleOffset: number },
): OverviewSegments {
  const sliceCap = (items: AttentionItem[]): OverviewSegmentPayload => ({
    items: items.slice(0, SEGMENT_DISPLAY_CAP),
    total: items.length,
  });

  const stale = buckets.stale;
  const staleSlice = stale.slice(staleOpts.staleOffset, staleOpts.staleOffset + staleOpts.staleLimit);
  const staleSegment: OverviewStaleSegmentPayload = {
    items: staleSlice,
    total: stale.length,
    limit: staleOpts.staleLimit,
    offset: staleOpts.staleOffset,
    hasMore: staleOpts.staleOffset + staleSlice.length < stale.length,
  };

  return {
    readyForReview: sliceCap(buckets.readyForReview),
    readyToImplement: sliceCap(buckets.readyToImplement),
    readyForPlanning: sliceCap(buckets.readyForPlanning),
    inProgress: sliceCap(buckets.inProgress),
    drafts: sliceCap(buckets.drafts),
    blocked: sliceCap(buckets.blocked),
    newestCreated: { items: buckets.newestCreated, total: buckets.newestCreated.length },
    stale: staleSegment,
  };
}

function pickOverviewHero(buckets: OverviewSegmentBuckets): OverviewHeroRecommendation {
  for (const [segmentId, kind] of HERO_PRIORITY) {
    const bucket = buckets[segmentId];
    if (bucket.length === 0) continue;
    const top = bucket[0];
    const total = bucket.length;
    const copyKey = total === 1 ? `${kind}.singular` : kind;
    return { kind, copyKey, itemId: top.id, total };
  }
  return { kind: 'clean', copyKey: 'clean', itemId: null, total: 0 };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
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
    case 'memory':
      // For memory/resource, the second positional is the item slug.
      return assignmentSlug
        ? resolve(projectsDir, projectSlug, 'memories', `${assignmentSlug}.md`)
        : null;
    case 'resource':
      return assignmentSlug
        ? resolve(projectsDir, projectSlug, 'resources', `${assignmentSlug}.md`)
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
    case 'memory':
      return `Edit Memory: ${assignmentSlug || 'memory'}`;
    case 'resource':
      return `Edit Resource: ${assignmentSlug || 'resource'}`;
    default:
      return projectSlug;
  }
}

// --- Playbook API ---

export async function listPlaybooks(playbooksDir: string): Promise<PlaybookSummary[]> {
  if (!(await fileExists(playbooksDir))) return [];

  const config = await readConfig();
  const disabledSet = new Set(config.playbooks.disabled);

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
      enabled: !disabledSet.has(slug),
    });
  }

  return playbooks.sort((a, b) => (b.updated || b.created).localeCompare(a.updated || a.created));
}

export async function getPlaybookDetail(
  playbooksDir: string,
  slug: string,
): Promise<PlaybookDetail | null> {
  const resolved = await resolvePlaybookSlug(playbooksDir, slug);
  if (!resolved) return null;

  const config = await readConfig();
  const enabled = !config.playbooks.disabled.includes(resolved.slug);

  const parsed = resolved.parsed;
  return {
    slug: resolved.slug,
    name: parsed.name || resolved.slug,
    description: parsed.description,
    whenToUse: parsed.whenToUse,
    tags: parsed.tags,
    created: parsed.created,
    updated: parsed.updated,
    body: parsed.body,
    enabled,
  };
}
