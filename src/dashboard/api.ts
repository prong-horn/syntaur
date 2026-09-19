import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { folderNameForTicketId } from '../utils/ticket-folder.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { readConfig } from '../utils/config.js';
import { buildQueryRegistry } from '../utils/query/registry.js';
import { getAvailableVerbs } from '../lifecycle/available-verbs.js';
import type { TicketFrontmatter } from '../lifecycle/types.js';
import {
  STAGE_TABLE,
  getStageLabel,
  isTerminalStageId,
} from './stage-config.js';
import { resolvePlaybookSlug } from '../utils/playbooks.js';
import { migrateLegacyProjectFiles, migrateLegacyArchivedProjects } from '../utils/fs-migration.js';
import {
  resolveTicketById,
  resolveTicketSlugInProject,
  type ResolvedTicket,
} from '../utils/ticket-resolver.js';
import { loadTemplate, resolveTemplateForTicket } from '../ticket-templates/registry.js';
import { resolvePlanReadPath, planFileFor } from '../ticket-templates/roles.js';
import { buildShow, type ShowModel } from '../ticket-templates/show.js';
import { openQuestions, parseLogEntries, type LogEntry } from '../ticket-templates/log-reader.js';
import { logRoleFile } from '../ticket-templates/manifest.js';
import { markdownBody } from '../ticket-templates/content.js';
import { syntaurRoot } from '../utils/paths.js';
import { invalidateIndex } from '../search/index.js';

import {
  parseProject,
  parseStatus,
  parseTicketFull,
  parsePlan,
  parseScratchpad,
  parseHandoff,
  parseDecisionRecord,
  parsePlaybook,
  parseProgress,
  extractMermaidGraph,
} from './parser.js';
import type {
  ArchiveResponse,
  ArchivedTicketItem,
  ArchivedProjectItem,
  TicketBoardItem,
  TicketDetail,
  TicketReference,
  TicketSummary,
  TicketsBoardResponse,
  TicketTransitionAction,
  EditableDocumentResponse,
  EnrichedLink,
  ProjectDetail,
  ProjectSummary,
  ProgressCounts,
  NeedsAttention,
  PlaybookSummary,
  PlaybookDetail,
  EngagementInfo,
  TicketTemplateBlock,
  TicketTemplateFileDetail,
  TicketLogEntryDetail,
} from './types.js';
import { getSessionById } from './agent-sessions.js';
import { getEngagementsByTicketId } from '../db/engagement-db.js';
import { isSessionDbInitialized } from './session-db.js';
import {
  classifyNeedsAttention,
  resolveStaleThresholds,
  type StaleReason,
  type StaleThresholds,
} from '../staleness/classify.js';
import type { StaleCandidate } from '../staleness/watchdog.js';
import { initEventsDb } from '../db/events-db.js';
import { ticketTotals, unknownTicketMetrics } from '../usage/ticket-totals.js';
import {
  deriveStatusVirtualsForTicket,
  loadTicketHistoryMaps,
  type StatusHistoryVirtuals,
} from '../lifecycle/history-from-events.js';


// --- Archive hiding helpers (cascade) ---
// "Hidden from normal views" is enforced in the aggregating/consuming functions,
// never in the parser or detail builders (those keep returning everything so the
// Archive page + restore can read archived items).

/** A project is hidden when its real `archived` flag is set. */
function isProjectArchived(p: { archived?: boolean }): boolean {
  return p.archived === true;
}

/** Tickets are no longer individually archivable — pass-through for call sites. */
function activeTickets<T>(items: T[]): T[] {
  return items;
}

const TERMINAL_STAGES = new Set(['done', 'dropped']);

export function clearStageTableCache(): void {
  /* v2 stage table is fixed — no config cache */
}

/** @deprecated Use {@link STAGE_TABLE} from stage-config. */
export async function getStageTableConfig(): Promise<{
  statuses: typeof STAGE_TABLE;
  order: string[];
  terminalStatuses: ReadonlySet<string>;
}> {
  return {
    statuses: STAGE_TABLE,
    order: STAGE_TABLE.map((s) => s.id),
    terminalStatuses: TERMINAL_STAGES,
  };
}

/** Parsed ticket.md plus the on-disk folder name (`<ID>-<slug>`), which is the only
 * reliable way back to the ticket directory: the display slug can differ from the folder. */
type TicketRecord = ReturnType<typeof parseTicketFull> & { dirName: string };

function ticketAsFrontmatter(ticket: TicketRecord): TicketFrontmatter {
  return {
    id: ticket.id,
    slug: ticket.slug,
    title: ticket.title,
    project: ticket.project,
    template: ticket.template,
    status: ticket.status,
    priority: ticket.priority as TicketFrontmatter['priority'],
    blocked: ticket.blocked,
    parked: ticket.parked,
    depends_on: ticket.depends_on,
    assignee: ticket.assignee,
    tags: ticket.tags,
    links: ticket.links,
    workspace: ticket.workspace,
    plan: ticket.plan,
    created: ticket.created,
    updated: ticket.updated,
  };
}

interface ProjectRecord {
  projectPath: string;
  project: ReturnType<typeof parseProject>;
  tickets: TicketRecord[];
  summary: ProjectSummary;
  dependencyGraph: string | null;
}

// ---------------------------------------------------------------------------
// Shared records cache (coarse, clear-all).
//
// Parsed project records and standalone records are read on every hot read
// path — /api/projects, /api/tickets, /api/workspaces, plus
// the server scanner's workspace lookup. The underlying work is a file fan-out
// (readdir + readFile + parse for every project, ticket, and comments
// file), which dominates request latency and is badly amplified by corporate
// EDR/AV that hooks filesystem syscalls. The dashboard server is long-lived, so
// we cache the parsed snapshot per directory and reuse it across requests.
//
// Granularity is deliberately coarse: a whole-snapshot clear-all (not a
// per-file map). Rebuild cost is one full scan, amortized across every read
// until the next mutation. In-flight promises are stored (not just resolved
// values) so concurrent callers de-duplicate onto a single scan, and a rejected
// scan is dropped so the next call retries rather than caching a failure.
//
// Invalidation is the correctness core: there is no single fs choke-point (the
// write routers mutate via writeFileForce, executeTransition, rm, and worktree
// helpers), so every mutating router installs `installRecordsInvalidation`,
// which clears the cache synchronously once each handler resolves. Non-router
// mutators (deleteWorkspace) call invalidateRecordsCache() directly, and the
// file watcher clears it for edits made outside the dashboard.
const projectRecordsCache = new Map<string, Promise<ProjectRecord[]>>();

interface LogParseCacheEntry {
  mtimeMs: number;
  entries: LogEntry[];
}

const logParseCache = new Map<string, LogParseCacheEntry>();

function mapLogEntryDetail(entry: LogEntry): TicketLogEntryDetail {
  return {
    timestamp: entry.timestamp,
    type: entry.type,
    author: entry.author,
    firstLine: entry.firstLine,
    body: entry.body,
    ...(Object.keys(entry.keys).length > 0 ? { keys: entry.keys } : {}),
  };
}

/** Read and parse a log-role file with an mtime-keyed cache. */
export async function readCachedLogEntries(filePath: string): Promise<LogEntry[]> {
  const fileStat = await stat(filePath);
  const cached = logParseCache.get(filePath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs) {
    return cached.entries;
  }
  const content = await readFile(filePath, 'utf-8');
  const entries = parseLogEntries(content);
  logParseCache.set(filePath, { mtimeMs: fileStat.mtimeMs, entries });
  return entries;
}

/** Drop all cached record snapshots. Cheap and idempotent. */
export function invalidateRecordsCache(): void {
  projectRecordsCache.clear();
  logParseCache.clear();
  // Content-search index shares this invalidation seam: every record mutation
  // (write routers, file watcher, broadcast, deleteWorkspace) funnels here, so
  // clearing the search index alongside keeps `/api/search` consistent with the
  // displayed records. Cheap + idempotent; the next getIndex() rebuilds lazily.
  invalidateIndex();
}

/**
 * Install synchronous records-cache invalidation on a mutating Express router.
 * Wraps the terminal handler of every post/put/patch/delete route so the cache
 * is cleared in a `finally` once the handler resolves — before the next request
 * can read it. Centralizes invalidation at registration because the handlers
 * have no shared fs write path to hook. Typed structurally to avoid importing
 * express here.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type RouterMethod = (...args: any[]) => any;
type MutatingRouter = Record<'post' | 'put' | 'patch' | 'delete', RouterMethod>;
export function installRecordsInvalidation(router: MutatingRouter): void {
  for (const method of ['post', 'put', 'patch', 'delete'] as const) {
    const original = (router[method] as RouterMethod).bind(router);
    router[method] = (path: any, ...handlers: any[]): any => {
      if (handlers.length > 0) {
        const last = handlers[handlers.length - 1] as RouterMethod;
        handlers[handlers.length - 1] = async (req: any, res: any, next: any) => {
          try {
            return await last(req, res, next);
          } finally {
            invalidateRecordsCache();
          }
        };
      }
      return original(path, ...handlers);
    };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */


/**
 * List all projects with source-first summary data.
 * GET /api/projects
 */
export async function listProjects(projectsDir: string): Promise<ProjectSummary[]> {
  const projectRecords = await listProjectRecords(projectsDir);
  // Archived projects are hidden from normal views; they live only on /archive.
  return projectRecords
    .filter((record) => !isProjectArchived(record.summary))
    .map((record) => record.summary);
}

/**
 * Worktree/branch records for the server scanner's tmux pane auto-linking,
 * derived from the cached records snapshot instead of a second file fan-out
 * (the scanner previously re-read every ticket.md on each cold scan). A
 * `null` projectSlug marks a standalone ticket. By convention a project
 * ticket's folder name equals its slug, and standalone folders are named by
 * UUID, so `ticketSlug` matches the scanner's prior folder-name behavior.
 */
export async function listWorkspaceRecords(projectsDir: string,
): Promise<
  Array<{
    projectSlug: string | null;
    ticketSlug: string;
    ticketTitle: string;
    worktree: string | null;
    branch: string | null;
  }>
> {
  const projectRecords = await listProjectRecords(projectsDir);

  const records: Array<{
    projectSlug: string | null;
    ticketSlug: string;
    ticketTitle: string;
    worktree: string | null;
    branch: string | null;
  }> = [];

  for (const project of projectRecords) {
    for (const ticket of project.tickets) {
      records.push({
        projectSlug: project.summary.slug,
        ticketSlug: ticket.slug,
        ticketTitle: ticket.title || ticket.slug,
        worktree: ticket.workspace.worktree ?? null,
        branch: ticket.workspace.branch ?? null,
      });
    }
  }

  return records;
}

/**
 * Get all tickets across all projects for the global kanban board.
 * GET /api/tickets
 */
export async function listTicketsBoard(projectsDir: string,
  options: { archived?: 'exclude' | 'only' } = {},
): Promise<TicketsBoardResponse> {
  if (options.archived === 'only') {
    return { generatedAt: new Date().toISOString(), tickets: [] };
  }
  initEventsDb();
  const projectRecords = await listProjectRecords(projectsDir);
  const allTickets = projectRecords.flatMap((r) =>
    isProjectArchived(r.summary) ? [] : r.tickets,
  );
  const historyMaps = loadTicketHistoryMaps(allTickets.map((t) => t.id));
  // Batched read-time totals (bounded statements, independent of card count).
  const metrics = ticketTotals(allTickets.map((t) => t.id));
  const now = Date.now();

  const projectItems = await Promise.all(
    projectRecords.flatMap(async (record) => {
      if (isProjectArchived(record.summary)) return [] as TicketBoardItem[];
      return Promise.all(
        record.tickets.map(async (ticket) =>
          toTicketBoardItem(projectsDir, record, ticket, historyMaps, now, metrics),
        ),
      );
    }),
  );

  return {
    generatedAt: new Date().toISOString(),
    tickets: [...projectItems.flat()]
      .sort((left, right) => compareTimestamps(right.updated, left.updated)),
  };
}

/**
 * Build the archived-projects view for the dashboard Archive page.
 * Ticket archiving was removed in v2 — only projects are archived.
 * GET /api/archived
 */
export async function listArchived(projectsDir: string,
): Promise<ArchiveResponse> {
  const projectRecords = await listProjectRecords(projectsDir);
  const projects: ArchivedProjectItem[] = projectRecords
    .filter((record) => isProjectArchived(record.summary))
    .map((record) => ({
      slug: record.summary.slug,
      title: record.summary.title,
      archivedAt: record.summary.archivedAt,
      archivedReason: record.summary.archivedReason,
      tickets: record.tickets
        .map((ticket) => ({
          id: ticket.id,
          slug: ticket.slug,
          title: ticket.title,
          status: ticket.status,
          template: ticket.template,
          priority: ticket.priority as ArchivedTicketItem['priority'],
          projectSlug: record.summary.slug,
          projectTitle: record.summary.title,
          archived: false,
          archivedAt: null,
          archivedReason: null,
          updated: ticket.updated,
        }))
        .sort((left, right) => compareTimestamps(right.updated, left.updated)),
    }))
    .sort((left, right) => compareTimestamps(right.archivedAt ?? '', left.archivedAt ?? ''));

  return { projects, tickets: [] };
}


/**
 * Get a raw editable document for dashboard editor pages.
 */
async function resolvePlanEditPath(ticketDir: string): Promise<string | null> {
  const ticketMdPath = resolve(ticketDir, 'ticket.md');
  if (!(await fileExists(ticketMdPath))) return null;
  const ticket = parseTicketFull(await readFile(ticketMdPath, 'utf-8'));
  const manifest = await loadTemplate(syntaurRoot(), resolveTemplateForTicket(ticket));
  const planPath = planFileFor(ticket, manifest);
  if (!planPath) return null;
  const full = resolve(ticketDir, planPath);
  if (!(await fileExists(full))) return null;
  return full;
}

export async function getEditableDocument(
  projectsDir: string,
  documentType: EditableDocumentResponse['documentType'],
  projectSlug: string,
  ticketSlug?: string,
): Promise<EditableDocumentResponse | null> {
  let filePath = getDocumentPath(projectsDir, documentType, projectSlug, ticketSlug);
  if (ticketSlug && documentType !== 'project' && documentType !== 'playbook') {
    const resolved = await resolveTicketSlugInProject(projectsDir, projectSlug, ticketSlug);
    if (resolved) {
      if (documentType === 'plan') {
        filePath = await resolvePlanEditPath(resolved.ticketDir);
      } else {
        const resolvedPath = getDocumentPath(
          projectsDir,
          documentType,
          projectSlug,
          basename(resolved.ticketDir),
        );
        if (resolvedPath) filePath = resolvedPath;
      }
    }
  }
  if (!filePath || !(await fileExists(filePath))) {
    return null;
  }

  const content = await readFile(filePath, 'utf-8');
  const title = getEditableDocumentTitle(documentType, projectSlug, ticketSlug);

  return {
    documentType,
    title,
    content,
    projectSlug,
    ticketSlug,
    appendOnly: false,
  };
}

/**
 * Resolve a ticket by UUID (standalone or project-nested) and return its
 * editable document payload for the given type.
 */
export async function getEditableDocumentById(
  projectsDir: string,
  documentType: EditableDocumentResponse['documentType'],
  id: string,
): Promise<EditableDocumentResponse | null> {
  const resolved = await resolveTicketById(projectsDir, id);
  if (!resolved) return null;

  if (!resolved.standalone && resolved.projectSlug) {
    return getEditableDocument(
      projectsDir,
      documentType,
      resolved.projectSlug,
      resolved.ticketSlug,
    );
  }

  let filePath: string | null;
  if (documentType === 'plan') {
    filePath = await resolvePlanEditPath(resolved.ticketDir);
  } else {
    const fileName =
      documentType === 'ticket'
        ? 'ticket.md'
        : documentType === 'scratchpad'
          ? 'scratchpad.md'
          : null;
    filePath = fileName ? resolve(resolved.ticketDir, fileName) : null;
    if (filePath && !(await fileExists(filePath))) filePath = null;
  }
  if (!filePath) return null;

  const content = await readFile(filePath, 'utf-8');
  const label = resolved.id;
  const title =
    documentType === 'ticket'
      ? `Edit Ticket: ${label}`
      : documentType === 'plan'
        ? `Edit Plan: ${label}`
        : `Edit Scratchpad: ${label}`;

  return {
    documentType,
    title,
    content,
    projectSlug: null,
    ticketSlug: undefined,
    ticketId: resolved.id,
    appendOnly: false,
  };
}

/**
 * Get full project detail with tickets.
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
  const tickets = await listTicketRecords(projectPath);
  const rollup = await buildProjectRollup(projectPath, project, tickets);
  const dependencyGraph = await loadDependencyGraph(projectPath, tickets);
  // Consistent with the project summary: the activity timestamp ignores archived
  // children so archiving an old ticket doesn't bump it.
  const updated = getProjectActivityTimestamp(project.updated, activeTickets(tickets));

  initEventsDb();
  const historyMaps = loadTicketHistoryMaps(tickets.map((t) => t.id));
  const metrics = ticketTotals(tickets.map((t) => t.id));
  const ticketSummaries = tickets
    .map((a) => toTicketSummary(a, historyMaps, Date.now(), metrics))
    .sort((left, right) => compareTimestamps(right.updated, left.updated));

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
    tickets: ticketSummaries,
    dependencyGraph,
    repositories: project.repositories,
  };
}

/**
 * Build the slim, camelCase engagement projection for a ticket's
 * "Session Activity" view: the full per-session stage history, agent-enriched.
 *
 * Reads the session DB (`getEngagementsByTicketId` / `getSessionById` both
 * go through `getSessionDb()`, which throws if `initSessionDb()` never ran).
 * The dashboard server initializes it; non-dashboard `getTicketDetail`
 * callers (CLI launch/open, direct tests) may not — so degrade to no
 * engagements rather than throwing. Agent is enriched once per distinct session
 * (no N+1); a missing session row yields `agent: null`.
 */
function buildTicketEngagements(ticketId: string): EngagementInfo[] {
  if (!isSessionDbInitialized()) return [];
  const rows = getEngagementsByTicketId(ticketId);
  const agentBySession = new Map<string, string | null>();
  for (const r of rows) {
    if (!agentBySession.has(r.session_id)) {
      agentBySession.set(r.session_id, getSessionById(r.session_id)?.agent ?? null);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    agent: agentBySession.get(r.session_id) ?? null,
    stage: r.stage,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  }));
}

async function buildTicketTemplateBlock(
  ticketDir: string,
  ticket: ReturnType<typeof parseTicketFull>,
): Promise<TicketTemplateBlock> {
  const root = syntaurRoot();
  const show = await buildShow(root, ticketDir);
  const manifest = await loadTemplate(root, resolveTemplateForTicket(ticket));
  const files: TicketTemplateFileDetail[] = [];

  for (const entry of manifest.files) {
    const showFile = show.files.find((f) => f.path === entry.path);
    const filePath = resolve(ticketDir, entry.path);
    const exists = await fileExists(filePath);
    let body: string | null = null;
    let logEntries: TicketTemplateFileDetail['logEntries'];
    let planStatus: string | null = null;

    if (exists) {
      const content = await readFile(filePath, 'utf-8');
      if (entry.role === 'log') {
        const logPath = resolve(ticketDir, entry.path);
        if (exists) {
          logEntries = (await readCachedLogEntries(logPath)).map(mapLogEntryDetail);
        }
        body = content;
      } else if (entry.role === 'plan') {
        const parsed = parsePlan(content);
        planStatus = parsed.status;
        body = parsed.body;
      } else {
        body = markdownBody(content);
      }
    }

    files.push({
      path: entry.path,
      role: entry.role ?? 'plain',
      writer: entry.writer,
      description: entry.description,
      state: showFile?.state ?? 'missing',
      exists,
      createOn: entry.createOn,
      body,
      ...(entry.role === 'log' ? { entryTypes: [...entry.entryTypes] } : {}),
      ...(logEntries ? { logEntries } : {}),
      ...(planStatus ? { planStatus } : {}),
    });
  }

  return { id: show.ticket.template, files };
}

/**
 * Get full ticket detail with plan and scratchpad metadata
 * (served through GET /api/tickets/:id).
 */
export async function getTicketDetail(
  projectsDir: string,
  projectSlug: string,
  ticketSlug: string,
): Promise<TicketDetail | null> {
  const resolved = await resolveTicketSlugInProject(projectsDir, projectSlug, ticketSlug);
  const ticketDir = resolved
    ? resolved.ticketDir
    : resolve(projectsDir, projectSlug, 'tickets', ticketSlug);
  const ticketMdPath = resolve(ticketDir, 'ticket.md');

  if (!(await fileExists(ticketMdPath))) {
    return null;
  }

  const ticketContent = await readFile(ticketMdPath, 'utf-8');
  const ticket: TicketRecord = { ...parseTicketFull(ticketContent), dirName: basename(ticketDir) };

  let plan: TicketDetail['plan'] = null;
  const planFile = await resolvePlanReadPath(ticketDir, ticket);
  if (planFile) {
    const planPath = resolve(ticketDir, planFile);
    if (await fileExists(planPath)) {
      const planContent = await readFile(planPath, 'utf-8');
      const parsed = parsePlan(planContent);
      plan = {
        status: parsed.status,
        updated: parsed.updated,
        body: parsed.body,
      };
    }
  }

  let scratchpad: TicketDetail['scratchpad'] = null;
  const scratchpadPath = resolve(ticketDir, 'scratchpad.md');
  if (await fileExists(scratchpadPath)) {
    const scratchpadContent = await readFile(scratchpadPath, 'utf-8');
    const parsed = parseScratchpad(scratchpadContent);
    scratchpad = {
      updated: parsed.updated,
      body: parsed.body,
    };
  }

  const manifest = await loadTemplate(syntaurRoot(), resolveTemplateForTicket(ticket));
  const availableVerbs = (await getAvailableVerbs(
    ticketDir,
    ticketAsFrontmatter(ticket),
    manifest,
  )) as TicketTransitionAction[];

  initEventsDb();
  const showModel = await buildShow(syntaurRoot(), ticketDir);
  const detail: TicketDetail = {
    id: ticket.id,
    projectSlug,
    slug: ticket.slug || ticketSlug,
    title: ticket.title,
    status: ticket.status,
    template: ticket.template,
    statusLabel: getStageLabel(ticket.status),
    priority: ticket.priority as TicketDetail['priority'],
    assignee: ticket.assignee,
    depends_on: ticket.depends_on,
    links: ticket.links,
    reverseLinks: [],
    enrichedLinks: [],
    blocked: ticket.blocked,
    parked: ticket.parked,
    workspace: ticket.workspace,
    tags: ticket.tags,
    ...deriveStatusVirtuals(ticket),
    next: showModel.next,
    stageHandoff: showModel.stageHandoff,
    created: ticket.created,
    updated: ticket.updated,
    body: ticket.body,
    plan,
    scratchpad,
    referencedBy: [],
    engagements: buildTicketEngagements(ticket.id),
    availableVerbs,
    templateBlock: await buildTicketTemplateBlock(ticketDir, ticket),
    metrics: ticketTotals([ticket.id]).get(ticket.id) ?? unknownTicketMetrics(),
  };

  // Compute reverse links and enrich all links
  const selfSlug = `${projectSlug}/${detail.slug}`;
  const projectRecords = await listProjectRecords(projectsDir);

  // Find reverse links: tickets across all projects whose links contain this ticket
  const reverseLinks: string[] = [];
  for (const mr of projectRecords) {
    for (const a of mr.tickets) {
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
  const forwardLinks = ticket.links.filter((l) => l !== selfSlug && isValidLinkFormat(l));

  // Deduplicate: if a slug is in both forward and reverse, keep in forward only
  const forwardSet = new Set(forwardLinks);
  const dedupedReverseLinks = reverseLinks.filter((l) => !forwardSet.has(l));

  detail.links = forwardLinks;
  detail.reverseLinks = dedupedReverseLinks;

  // Build enriched links for the frontend
  const allProjectTickets = new Map<string, { id: string; title: string; status: string }>();
  for (const mr of projectRecords) {
    for (const a of mr.tickets) {
      allProjectTickets.set(`${mr.summary.slug}/${a.slug}`, {
        id: a.id,
        title: a.title,
        status: a.status,
      });
    }
  }

  const enrichedLinks: EnrichedLink[] = [];
  for (const linkSlug of forwardLinks) {
    const [ms, as] = linkSlug.split('/');
    const info = allProjectTickets.get(linkSlug);
    enrichedLinks.push({
      id: info?.id ?? linkSlug,
      slug: linkSlug,
      projectSlug: ms,
      ticketSlug: as,
      title: info?.title ?? linkSlug,
      status: info?.status ?? 'pending',
      isReverse: false,
    });
  }
  for (const linkSlug of dedupedReverseLinks) {
    const [ms, as] = linkSlug.split('/');
    const info = allProjectTickets.get(linkSlug);
    enrichedLinks.push({
      id: info?.id ?? linkSlug,
      slug: linkSlug,
      projectSlug: ms,
      ticketSlug: as,
      title: info?.title ?? linkSlug,
      status: info?.status ?? 'pending',
      isReverse: true,
    });
  }

  detail.enrichedLinks = enrichedLinks;

  // Populate referencedBy — tickets that mention this one.
  detail.referencedBy = await computeReferencedBy(
    { id: ticket.id, projectSlug, slug: detail.slug },
    projectsDir,
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
 * Scan every *other* ticket's log-role file and legacy record bodies
 * for markdown links that resolve to `target`, and return an aggregated per-source
 * count (capped at 50).
 */
async function computeReferencedBy(
  target: ReferenceTarget,
  projectsDir: string,
): Promise<TicketReference[]> {
  const sources: Array<{
    id: string;
    slug: string;
    title: string;
    projectSlug: string | null;
    ticketDir: string;
  }> = [];

  // project-nested
  const projectRecords = await listProjectRecords(projectsDir);
  for (const rec of projectRecords) {
    for (const a of rec.tickets) {
      sources.push({
        id: a.id,
        slug: a.slug,
        title: a.title,
        projectSlug: rec.summary.slug,
        ticketDir: resolve(rec.projectPath, 'tickets', a.dirName),
      });
    }
  }

  const references: TicketReference[] = [];
  for (const source of sources) {
    if (source.id === target.id) continue; // skip self
    const mentions = await countMentionsInTicket(source.ticketDir, target);
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

async function countMentionsInTicket(
  sourceDir: string,
  target: ReferenceTarget,
): Promise<number> {
  const bodies: string[] = [];
  const scanPaths = new Set<string>();

  const ticketMdPath = resolve(sourceDir, 'ticket.md');
  if (await fileExists(ticketMdPath)) {
    try {
      const ticket = parseTicketFull(await readFile(ticketMdPath, 'utf-8'));
      const manifest = await loadTemplate(syntaurRoot(), resolveTemplateForTicket(ticket));
      const logRole = logRoleFile(manifest);
      if (logRole) scanPaths.add(logRole.path);
    } catch {
      // ignore
    }
  }

  for (const legacy of ['handoff.md', 'decision-record.md', 'comments.md']) {
    scanPaths.add(legacy);
  }

  for (const filename of scanPaths) {
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
  patterns.push(new RegExp(`/t/${escapeRegExpLocal(target.id)}(?:/|\\b)`, 'g'));
  patterns.push(new RegExp(`/tickets/${escapeRegExpLocal(target.id)}(?:/|\\b)`, 'g'));
  if (target.projectSlug) {
    // Legacy project-nested absolute route (pre-/t/ migration)
    patterns.push(
      new RegExp(
        `/projects/${escapeRegExpLocal(target.projectSlug)}/tickets/${escapeRegExpLocal(target.slug)}(?:/|\\b)`,
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
 * Resolve a ticket by UUID (standalone or project-nested) and return its full detail payload.
 * GET /api/tickets/:id
 */
export async function getTicketLogById(
  projectsDir: string,
  id: string,
  typeFilter?: string,
): Promise<{ path: string; entries: TicketLogEntryDetail[] } | null> {
  const resolved = await resolveTicketById(projectsDir, id);
  if (!resolved) return null;

  const ticketMdPath = resolve(resolved.ticketDir, 'ticket.md');
  if (!(await fileExists(ticketMdPath))) return null;

  const ticket = parseTicketFull(await readFile(ticketMdPath, 'utf-8'));
  const manifest = await loadTemplate(syntaurRoot(), resolveTemplateForTicket(ticket));
  const logRole = logRoleFile(manifest);
  if (!logRole) return null;

  const logFilePath = resolve(resolved.ticketDir, logRole.path);
  if (!(await fileExists(logFilePath))) {
    return { path: logRole.path, entries: [] };
  }

  let entries = (await readCachedLogEntries(logFilePath)).map(mapLogEntryDetail);
  if (typeFilter) {
    entries = entries.filter((entry) => entry.type === typeFilter);
  }
  return { path: logRole.path, entries };
}

/**
 * Resolve a ticket by UUID (standalone or project-nested) and return its full detail payload.
 * GET /api/tickets/:id
 */
export async function getTicketDetailById(
  projectsDir: string,
  id: string,
): Promise<TicketDetail | null> {
  const resolved = await resolveTicketById(projectsDir, id);
  if (!resolved || !resolved.projectSlug) return null;
  const detail = await getTicketDetail(projectsDir, resolved.projectSlug, resolved.ticketSlug);
  if (!detail) return null;
  detail.referencedBy = await computeReferencedBy(
    { id: detail.id, projectSlug: detail.projectSlug, slug: detail.slug },
    projectsDir,
  );
  return detail;
}

/**
 * Rendered ticket summary (`syntaur show --json`).
 * GET /api/tickets/:id/show
 */
export async function getTicketShowById(
  projectsDir: string,
  id: string,
): Promise<ShowModel | null> {
  const resolved = await resolveTicketById(projectsDir, id);
  if (!resolved) return null;
  return await buildShow(syntaurRoot(), resolved.ticketDir);
}

// Guard so legacy-file renames run at most once per `projectsDir` per process
// lifetime. Keyed by absolute path to tolerate test suites that open multiple
// sandboxes in the same process.
const migratedProjectsDirs = new Set<string>();

async function listProjectRecords(
  projectsDir: string,
): Promise<ProjectRecord[]> {
  const cached = projectRecordsCache.get(projectsDir);
  if (cached) return cached;
  const promise = computeProjectRecords(projectsDir);
  projectRecordsCache.set(projectsDir, promise);
  promise.catch(() => projectRecordsCache.delete(projectsDir));
  return promise;
}

async function computeProjectRecords(
  projectsDir: string,
): Promise<ProjectRecord[]> {
  if (!(await fileExists(projectsDir))) {
    return [];
  }

  if (!migratedProjectsDirs.has(projectsDir)) {
    migratedProjectsDirs.add(projectsDir);
    await migrateLegacyProjectFiles(projectsDir);
    // Reconcile legacy "archived-as-a-status" projects (statusOverride: 'archived')
    // into the real `archived` flag so there is one source of truth.
    await migrateLegacyArchivedProjects(projectsDir);
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

      const projectContent = await readFile(projectMdPath, 'utf-8');
      const project = parseProject(projectContent);

      const tickets = await listTicketRecords(projectPath);

      const rollup = await buildProjectRollup(projectPath, project, tickets);

      // Archived children are hidden, so archiving an old one must not bump the
      // project's activity timestamp (which drives list/recent-projects ordering).
      const updated = getProjectActivityTimestamp(project.updated, activeTickets(tickets));

      const dependencyGraph = await loadDependencyGraph(projectPath, tickets);

      return {
        projectPath,
        project,
        tickets,
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
          externalIds: project.externalIds,
          progress: rollup.progress,
          needsAttention: rollup.needsAttention,
        },
      };
    }),
  );

  const records = maybeRecords.filter((r): r is ProjectRecord => r !== null);
  records.sort((left, right) => compareTimestamps(right.summary.updated, left.summary.updated));
  return records;
}

async function listTicketRecords(
  projectPath: string,
): Promise<TicketRecord[]> {
  const ticketsPath = resolve(projectPath, 'tickets');
  if (!(await fileExists(ticketsPath))) {
    return [];
  }

  const entries = await readdir(ticketsPath, { withFileTypes: true });
  const dirEntries = entries.filter((entry) => entry.isDirectory());

  const maybeRecords = await Promise.all(
    dirEntries.map(async (entry): Promise<TicketRecord | null> => {
      const ticketMd = resolve(ticketsPath, entry.name, 'ticket.md');
      if (!(await fileExists(ticketMd))) {
        return null;
      }
      const content = await readFile(ticketMd, 'utf-8');
      const parsed = parseTicketFull(content);
      return { ...parsed, dirName: entry.name };
    }),
  );

  const records = maybeRecords.filter((r): r is TicketRecord => r !== null);
  records.sort((left, right) => compareTimestamps(right.updated, left.updated));
  return records;
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

async function loadDependencyGraph(
  projectPath: string,
  tickets: TicketRecord[],
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

  return buildDependencyGraph(tickets);
}

async function buildProjectRollup(
  projectPath: string,
  project: ReturnType<typeof parseProject>,
  tickets: TicketRecord[],
): Promise<{
  progress: ProgressCounts;
  needsAttention: NeedsAttention;
  status: string;
}> {
  const active = activeTickets(tickets);
  const progress: ProgressCounts = { total: active.length };

  const perTicket = await Promise.all(
    active.map(async (ticket) => {
      const openQuestions = await countOpenQuestions(projectPath, ticket.dirName);
      return { ticket, openQuestions };
    }),
  );

  let openQuestions = 0;
  let blockedCount = 0;
  let failedCount = 0;
  let doneCount = 0;
  let activeWorkCount = 0;

  for (const entry of perTicket) {
    const stage = entry.ticket.status;
    progress[stage] = (progress[stage] ?? 0) + 1;
    openQuestions += entry.openQuestions;
    if (entry.ticket.blocked) blockedCount++;
    if (stage === 'dropped') failedCount++;
    if (stage === 'done') doneCount++;
    if (stage === 'in_progress' || stage === 'review') activeWorkCount++;
  }

  const needsAttention: NeedsAttention = {
    blockedCount,
    failedCount,
    openQuestions,
  };

  let status = 'pending';
  if (project.statusOverride) {
    status = project.statusOverride;
  } else if (project.archived) {
    status = 'archived';
  } else if (progress.total > 0 && doneCount === progress.total) {
    status = 'completed';
  } else if (activeWorkCount > 0) {
    status = 'active';
  } else if (failedCount > 0) {
    status = 'failed';
  } else if (blockedCount > 0) {
    status = 'blocked';
  } else if (progress.total === 0 || (progress['backlog'] ?? 0) === progress.total) {
    status = 'pending';
  } else {
    status = 'active';
  }

  return { progress, needsAttention, status };
}

function deriveStatusVirtuals(
  ticket: TicketRecord,
  maps = loadTicketHistoryMaps([ticket.id]),
  now = Date.now(),
): StatusHistoryVirtuals {
  return deriveStatusVirtualsForTicket(ticket, maps, now);
}

function toTicketSummary(
  ticket: TicketRecord,
  maps = loadTicketHistoryMaps([ticket.id]),
  now = Date.now(),
  metrics = ticketTotals([ticket.id]),
): TicketSummary {
  const virtuals = deriveStatusVirtuals(ticket, maps, now);
  return {
    id: ticket.id,
    slug: ticket.slug,
    title: ticket.title,
    status: ticket.status,
    template: ticket.template,
    statusLabel: getStageLabel(ticket.status),
    priority: ticket.priority as TicketSummary['priority'],
    assignee: ticket.assignee,
    depends_on: ticket.depends_on,
    links: ticket.links,
    tags: ticket.tags,
    blocked: ticket.blocked,
    parked: ticket.parked,
    created: ticket.created,
    updated: ticket.updated,
    ...virtuals,
    metrics: metrics.get(ticket.id) ?? unknownTicketMetrics(),
  };
}

async function toTicketBoardItem(
  _projectsDir: string,
  projectRecord: ProjectRecord,
  ticket: TicketRecord,
  maps = loadTicketHistoryMaps([ticket.id]),
  now = Date.now(),
  metrics = ticketTotals([ticket.id]),
): Promise<TicketBoardItem> {
  const ticketDir = resolve(projectRecord.projectPath, 'tickets', ticket.dirName);
  const manifest = await loadTemplate(syntaurRoot(), resolveTemplateForTicket(ticket));
  const verbs = await getAvailableVerbs(ticketDir, ticketAsFrontmatter(ticket), manifest);

  return {
    ...toTicketSummary(ticket, maps, now, metrics),
    projectSlug: projectRecord.summary.slug,
    projectTitle: projectRecord.summary.title,
    availableVerbs: verbs as TicketTransitionAction[],
  };
}

const DEFAULT_GRAPH_COLORS: Record<string, string> = {
  done: 'fill:#4ea84f,stroke:#1f6b29,color:#ffffff',
  in_progress: 'fill:#1e6fd9,stroke:#0f3f8f,color:#ffffff',
  backlog: 'fill:#c0ccd9,stroke:#738399,color:#163047',
  planning: 'fill:#c0ccd9,stroke:#738399,color:#163047',
  ready: 'fill:#5b8fd9,stroke:#2f5f9f,color:#ffffff',
  dropped: 'fill:#9f2d2d,stroke:#651616,color:#ffffff',
  review: 'fill:#c6911e,stroke:#7a5a10,color:#ffffff',
};

function buildDependencyGraph(tickets: TicketRecord[]): string | null {
  const edges: string[] = [];
  const usedStatuses = new Set<string>();

  for (const ticket of tickets) {
    for (const dependency of ticket.depends_on) {
      const depStatus = findTicketStatus(tickets, dependency);
      usedStatuses.add(depStatus);
      usedStatuses.add(ticket.status);
      edges.push(
        `    ${dependency}:::${depStatus} --> ${ticket.slug}:::${ticket.status}`,
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

/** `key` is a ticket id (`depends_on` entries) or, for legacy data, a display slug; ids win. */
function findTicketStatus(tickets: TicketRecord[], key: string): string {
  const byId = tickets.find((ticket) => ticket.id === key);
  if (byId) return byId.status;
  return tickets.find((ticket) => ticket.slug === key)?.status ?? 'backlog';
}

/**
 * Locate a ticket folder inside `<projectPath>/tickets` by id (`<ID>-<slug>` folders) or by
 * exact folder name. Returns `null` when nothing matches.
 */
async function findTicketDir(projectPath: string, key: string): Promise<string | null> {
  const ticketsPath = resolve(projectPath, 'tickets');
  if (!(await fileExists(ticketsPath))) return null;
  const entries = await readdir(ticketsPath, { withFileTypes: true });
  // Ids are unique within a project, so at most one `<ID>-<slug>` folder parses to `key`;
  // the exact-name branch covers folders that predate the id prefix.
  const match = entries.find(
    (entry) => entry.isDirectory() && (entry.name === key || folderNameForTicketId(entry.name, key)),
  );
  return match ? resolve(ticketsPath, match.name) : null;
}

async function getUnmetDependencies(
  projectPath: string,
  depends_on: string[],
  terminalStatuses?: ReadonlySet<string>,
  dependencyStatusMap?: ReadonlyMap<string, string>,
): Promise<string[]> {
  const terminals = terminalStatuses ?? TERMINAL_STAGES;
  const unmet: string[] = [];

  for (const dependency of depends_on) {
    // Fast path: in-memory map built from already-parsed records.
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

    const dependencyDir = await findTicketDir(projectPath, dependency);
    const dependencyPath = dependencyDir ? resolve(dependencyDir, 'ticket.md') : null;
    if (!dependencyPath || !(await fileExists(dependencyPath))) {
      unmet.push(`${dependency} (missing)`);
      continue;
    }

    const content = await readFile(dependencyPath, 'utf-8');
    const parsed = parseTicketFull(content);
    if (!terminals.has(parsed.status)) {
      unmet.push(`${dependency} (${parsed.status})`);
    }
  }

  return unmet;
}

async function readLogRoleActivityMs(ticketDir: string, now: number): Promise<number | null> {
  const ticketMdPath = resolve(ticketDir, 'ticket.md');
  if (!(await fileExists(ticketMdPath))) return null;
  try {
    const ticketContent = await readFile(ticketMdPath, 'utf-8');
    const fm = parseTicketFull(ticketContent);
    const manifest = await loadTemplate(syntaurRoot(), resolveTemplateForTicket(fm));
    const logRole = logRoleFile(manifest);
    if (!logRole) return null;
    const logPath = resolve(ticketDir, logRole.path);
    if (!(await fileExists(logPath))) return null;
    const s = await stat(logPath);
    return Math.max(0, now - s.mtimeMs);
  } catch {
    return null;
  }
}

/** Run the shared staleness classifier for one ticket record. */
function classifyTicketRecord(
  ticket: TicketRecord,
  depsSatisfied: boolean | null,
  lastActivityMs: number | null,
  thresholds: StaleThresholds,
  historyMaps?: ReturnType<typeof loadTicketHistoryMaps>,
): StaleReason[] {
  const maps = historyMaps ?? loadTicketHistoryMaps([ticket.id]);
  return classifyNeedsAttention(
    {
      stage: ticket.status,
      isTerminal: isTerminalStageId(ticket.status),
      assignee: ticket.assignee ?? null,
      blocked: ticket.blocked ?? null,
      depsSatisfied,
      // plan_awaiting_approval is deferred to the decision inbox's plan-approval
      // category for now; pass values that keep that reason dormant.
      planExists: false,
      planApproved: true,
      statusAgeMs: deriveStatusVirtualsForTicket(ticket, maps).statusAge,
      lastActivityMs,
    },
    thresholds,
  );
}

/**
 * Read-only scan of EVERY active ticket (project + standalone, unpaged) for
 * the staleness watchdog. Reuses the same classifier + resolved terminals +
 * config thresholds, keyed by ticket id (stable UUID). Never
 * writes anything.
 */
export async function collectStaleCandidates(projectsDir: string,
): Promise<StaleCandidate[]> {
  initEventsDb();
  const projectRecords = await listProjectRecords(projectsDir);
  const thresholds = resolveStaleThresholds((await readConfig()).staleness);
  const historyMaps = loadTicketHistoryMaps(
    projectRecords
      .filter((record) => !isProjectArchived(record.summary))
      .flatMap((record) => activeTickets(record.tickets).map((t) => t.id)),
  );
  const now = Date.now();
  const out: StaleCandidate[] = [];

  for (const record of projectRecords) {
    if (isProjectArchived(record.summary)) continue;
    const projectPath = resolve(projectsDir, record.summary.slug);
    const depMap = new Map<string, string>();
    for (const a of record.tickets) {
      depMap.set(a.slug, a.status); // legacy slug key, overridden by an id below if they collide
      depMap.set(a.id, a.status);
    }
    for (const ticket of activeTickets(record.tickets)) {
      const depsSatisfied =
        ticket.depends_on.length === 0
          ? true
          : (await getUnmetDependencies(projectPath, ticket.depends_on, TERMINAL_STAGES, depMap)).length === 0;
      const lastActivityMs = await readLogRoleActivityMs(
        resolve(projectPath, 'tickets', ticket.dirName),
        now,
      );
      const reasons = classifyTicketRecord(
        ticket,
        depsSatisfied,
        lastActivityMs,
        thresholds,
        historyMaps,
      );
      if (reasons.length > 0) {
        out.push({ ticketId: ticket.id, projectSlug: record.summary.slug, reasons });
      }
    }
  }

  return out;
}

function compareTimestamps(left: string, right: string): number {
  return parseTimestamp(left) - parseTimestamp(right);
}

function parseTimestamp(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function countPendingAnswers(body: string): number {
  const matches = body.match(/^\*\*A:\*\*\s+pending\s*$/gim);
  return matches ? matches.length : 0;
}

async function countOpenQuestions(
  projectPath: string,
  ticketDirName: string,
): Promise<number> {
  const ticketDir = resolve(projectPath, 'tickets', ticketDirName);
  const ticketMdPath = resolve(ticketDir, 'ticket.md');
  if (!(await fileExists(ticketMdPath))) return 0;
  try {
    const ticketContent = await readFile(ticketMdPath, 'utf-8');
    const fm = parseTicketFull(ticketContent);
    const manifest = await loadTemplate(syntaurRoot(), resolveTemplateForTicket(fm));
    const logRole = logRoleFile(manifest);
    if (!logRole) return 0;
    const logPath = resolve(ticketDir, logRole.path);
    if (!(await fileExists(logPath))) return 0;
    const entries = parseLogEntries(await readFile(logPath, 'utf-8'));
    return openQuestions(entries).length;
  } catch {
    return 0;
  }
}

function getProjectActivityTimestamp(projectUpdated: string, tickets: TicketRecord[]): string {
  let latest = projectUpdated;
  for (const ticket of tickets) {
    if (compareTimestamps(ticket.updated, latest) > 0) {
      latest = ticket.updated;
    }
  }
  return latest;
}

function getDocumentPath(
  projectsDir: string,
  documentType: EditableDocumentResponse['documentType'],
  projectSlug: string,
  ticketSlug?: string,
): string | null {
  switch (documentType) {
    case 'project':
      return resolve(projectsDir, projectSlug, 'project.md');
    case 'ticket':
      return ticketSlug
        ? resolve(projectsDir, projectSlug, 'tickets', ticketSlug, 'ticket.md')
        : null;
    case 'plan':
      return ticketSlug
        ? resolve(projectsDir, projectSlug, 'tickets', ticketSlug, 'plan.md')
        : null;
    case 'scratchpad':
      return ticketSlug
        ? resolve(projectsDir, projectSlug, 'tickets', ticketSlug, 'scratchpad.md')
        : null;
    default:
      return null;
  }
}

function getEditableDocumentTitle(
  documentType: EditableDocumentResponse['documentType'],
  projectSlug: string,
  ticketSlug?: string,
): string {
  switch (documentType) {
    case 'project':
      return `Edit Project: ${projectSlug}`;
    case 'ticket':
      return `Edit Ticket: ${ticketSlug || 'ticket'}`;
    case 'plan':
      return `Edit Plan: ${ticketSlug || 'ticket'}`;
    case 'scratchpad':
      return `Edit Scratchpad: ${ticketSlug || 'ticket'}`;
    case 'playbook':
      return `Edit Playbook: ${projectSlug}`;
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
