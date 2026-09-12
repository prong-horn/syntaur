import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { getTargetStatus, DEFAULT_TRANSITION_TABLE, buildTransitionTable } from '../lifecycle/index.js';
import { getWorkflowLibrary, resolveWorkflowId } from '../utils/workflow-resolve.js';
import { isStagesMigrated } from '../utils/stages-marker.js';
import type { StageWorkflow } from '../utils/stage-model.js';
import { readProjectBinding, type ProjectWorkflowBinding } from '../utils/project-binding.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { nowTimestamp } from '../utils/timestamp.js';
import {
  readConfig,
  buildDefaultStatusConfig,
  normalizeFactDeclarations,
  toTitleCase,
  type StatusTransition,
  type DeriveConfig,
  type FactDeclaration,
  type RawFactDeclaration,
  type SyntaurConfig,
  type StatusConfig,
} from '../utils/config.js';
import { acceptFactDeclarations, buildDeriveRegistry, buildQueryRegistry } from '../lifecycle/derive.js';
import { TICKET_FIELDS, type FieldRegistry } from '../utils/query/index.js';
import { resolvePlaybookSlug } from '../utils/playbooks.js';
import { migrateLegacyProjectFiles, migrateLegacyArchivedProjects } from '../utils/fs-migration.js';
import { resolveTicketById, type ResolvedTicket } from '../utils/ticket-resolver.js';
import { latestPlanFile } from '../lifecycle/facts.js';
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
  parseComments,
  extractMermaidGraph,
} from './parser.js';
import { getDashboardHelp } from './help.js';
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
  AttentionItem,
  EditableDocumentResponse,
  EnrichedLink,
  HelpResponse,
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
  PlaybookSummary,
  PlaybookDetail,
  EngagementInfo,
} from './types.js';
import { listAllSessions, getSessionById } from './agent-sessions.js';
import { getEngagementsByTicketId } from '../db/engagement-db.js';
import { isSessionDbInitialized } from './session-db.js';
import { SEGMENT_REASON } from './overviewCopy.js';
import {
  classifyNeedsAttention,
  resolveStaleThresholds,
  type StaleReason,
  type StaleThresholds,
} from '../staleness/classify.js';
import type { StaleCandidate } from '../staleness/watchdog.js';

const RECENT_PROJECTS_LIMIT = 6;
const RECENT_ACTIVITY_LIMIT = 12;
const RECENT_SESSIONS_LIMIT = 10;
const NEWEST_CREATED_LIMIT = 5;
const SEGMENT_DISPLAY_CAP = 5;
const STALE_LIMIT_DEFAULT = 50;
const STALE_LIMIT_MAX = 200;

// --- Archive hiding helpers (cascade) ---
// "Hidden from normal views" is enforced in the aggregating/consuming functions,
// never in the parser or detail builders (those keep returning everything so the
// Archive page + restore can read archived items).

/** A project is hidden when its real `archived` flag is set. */
function isProjectArchived(p: { archived?: boolean }): boolean {
  return p.archived === true;
}

/** Drop individually-archived tickets from a list (for normal/active views). */
function activeTickets<T extends { archived?: boolean }>(items: T[]): T[] {
  return items.filter((item) => item.archived !== true);
}

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

type TicketRecord = ReturnType<typeof parseTicketFull>;

interface ProjectRecord {
  projectPath: string;
  project: ReturnType<typeof parseProject>;
  tickets: TicketRecord[];
  summary: ProjectSummary;
  dependencyGraph: string | null;
}

/** A standalone ticket lives at `<ticketsDir>/<uuid>/` and has no containing project. */
interface StandaloneRecord {
  ticketDir: string;
  /** The UUID (folder name). */
  id: string;
  record: TicketRecord;
}

// ---------------------------------------------------------------------------
// Shared records cache (coarse, clear-all).
//
// Parsed project records and standalone records are read on every hot read
// path — /api/overview, /api/projects, /api/tickets, /api/workspaces, plus
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
const standaloneRecordsCache = new Map<string, Promise<StandaloneRecord[]>>();

/** Drop all cached record snapshots. Cheap and idempotent. */
export function invalidateRecordsCache(): void {
  projectRecordsCache.clear();
  standaloneRecordsCache.clear();
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

async function listStandaloneRecords(ticketsDir: string | undefined): Promise<StandaloneRecord[]> {
  const key = ticketsDir ?? '';
  const cached = standaloneRecordsCache.get(key);
  if (cached) return cached;
  const promise = computeStandaloneRecords(ticketsDir);
  standaloneRecordsCache.set(key, promise);
  promise.catch(() => standaloneRecordsCache.delete(key));
  return promise;
}

async function computeStandaloneRecords(ticketsDir: string | undefined): Promise<StandaloneRecord[]> {
  if (!ticketsDir) return [];
  if (!(await fileExists(ticketsDir))) return [];

  const entries = await readdir(ticketsDir, { withFileTypes: true });
  const records: StandaloneRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const ticketDir = resolve(ticketsDir, entry.name);
    const ticketMdPath = resolve(ticketDir, 'ticket.md');
    if (!(await fileExists(ticketMdPath))) continue;
    try {
      const content = await readFile(ticketMdPath, 'utf-8');
      const record = parseTicketFull(content);
      records.push({ ticketDir, id: entry.name, record });
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
    description: 'Promote a draft ticket to ready_for_planning once the Objective and Acceptance Criteria are fleshed out.',
    requiresReason: false,
  },
  {
    command: 'plan-ready',
    label: 'Plan Ready',
    description: 'Promote a ready_for_planning ticket to ready_to_implement after the plan is written and approved.',
    requiresReason: false,
  },
  {
    command: 'implement',
    label: 'Implement',
    description: 'Move a ready_to_implement ticket into in_progress when coding begins.',
    requiresReason: false,
  },
  {
    command: 'review',
    label: 'Send To Review',
    description: 'Mark the ticket ready for inspection.',
    requiresReason: false,
  },
  {
    command: 'complete',
    label: 'Complete',
    description: 'Mark the ticket done.',
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
    description: 'Mark the ticket as failed when it cannot be completed as planned.',
    requiresReason: false,
  },
  {
    command: 'reopen',
    label: 'Reopen',
    description: 'Reopen a completed or failed ticket to resume work.',
    requiresReason: false,
  },
];

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
  /** The workflow id this config was resolved for (`'default'` for the legacy
   * single lifecycle). */
  workflowId: string;
  /** Human label for the workflow (`'Default'` for the built-in, Title Case of
   * the id for a named workflow with no explicit label). */
  label: string;
  custom: boolean;
  statuses: Array<{ id: string; label: string; description?: string; color?: string; terminal?: boolean }>;
  order: string[];
  transitions: StatusTransition[];
  transitionTable: Map<string, string>;
  /** RAW transitions as configured (empty when the user declares none — the
   * Settings editor distinguishes "user customized" from "showing defaults"
   * via {@link transitionsCustom}, same pattern as {@link derive}). Distinct
   * from {@link transitions}, which is materialized with the default table for
   * the runtime transition guards so the board still offers commands. */
  rawTransitions: StatusTransition[];
  transitionsCustom: boolean;
  terminalStatuses: ReadonlySet<string>;
  /** Derive rules as configured (null when the user has none — resolve to
   * DEFAULT_DERIVE_CONFIG at the derivation call site, NOT here, so the
   * Settings writer can distinguish "user customized" from "defaults"). */
  derive: DeriveConfig | null;
  /** RAW custom-fact declarations (verbatim) — what the Settings writer passes
   * back to `writeStatusConfig` so a Settings save can't silently delete the
   * user's `statuses.facts` (same bug class as `derive`). */
  facts: RawFactDeclaration[] | null;
  /** ACCEPTED declarations (normalize→accept) — drives `customFacts` extraction
   * and the registry; collision-skipped/malformed rows are absent here. */
  factDeclarations: FactDeclaration[];
  /** Derive registry built ONCE per cached resolution from the accepted list —
   * reused across requests so the WeakMap compile-cache stays warm (no
   * per-request registry construction in buildDerivedDetail). */
  deriveRegistry: FieldRegistry;
  /** Query registry built ONCE per cached resolution from the accepted list —
   * sibling of deriveRegistry; stable object identity keeps the WeakMap
   * compile-cache warm across saved-view query validations. */
  queryRegistry: FieldRegistry;
}

const _cachedConfigs = new Map<string, ResolvedStatusConfig>();

/**
 * Resolve the dashboard status-config view for one workflow id (default
 * `'default'`). Backed by a per-workflow cache. For the legacy single-lifecycle
 * config (no `workflows:` block), the `'default'` workflow resolves from the
 * top-level `statuses:` block — byte-identical to the pre-workflow behavior, so
 * every existing no-arg caller is unaffected. Ticket-specific surfaces
 * (board items, projection, transitions, terminal virtuals) pass the ticket's
 * resolved workflow id so each ticket derives against its OWN workflow.
 */
export async function getStatusConfig(workflowId = 'default'): Promise<ResolvedStatusConfig> {
  const cached = _cachedConfigs.get(workflowId);
  if (cached) return cached;
  const config = await readConfig();
  // Warm the sync marker peek used by deriveStatusVirtuals — every record
  // materialization flow awaits a getStatusConfig() before building virtuals.
  if (_stagesMigratedCache === null) _stagesMigratedCache = await isStagesMigrated();
  // Post-migration the config block is gone: a per-file StageWorkflow is the
  // source of truth for this id. Without this, getStatusConfig('test') fell
  // through to the built-in DEFAULT statuses/transitions and non-default
  // workflow tickets got default lifecycle affordances (codex code-review r1).
  let resolved: ResolvedStatusConfig | null = null;
  const explicitBundle =
    config.workflows?.[workflowId] ?? (workflowId === 'default' ? config.statuses : null) ?? null;
  if (!explicitBundle) {
    const { loadWorkflowLibrary } = await import('../utils/workflow-library.js');
    const stageWorkflow = loadWorkflowLibrary(config)[workflowId];
    if (stageWorkflow) resolved = stageWorkflowStatusConfig(workflowId, stageWorkflow);
  }
  resolved ??= resolveWorkflowStatusConfig(config, workflowId);
  _cachedConfigs.set(workflowId, resolved);
  return resolved;
}

export function clearStatusConfigCache(): void {
  _cachedConfigs.clear();
  _cachedWorkflowMeta = null;
  _stagesMigratedCache = null;
}

/** Sync peek for materialization helpers (deriveStatusVirtuals) — warmed by
 * getStatusConfig, reset with the config caches. `false` = pre-marker
 * behavior, the safe default. */
let _stagesMigratedCache: boolean | null = null;

/** Materialize the dashboard status-config view from a per-file StageWorkflow
 * (post-migration). The ENGINE owns movement for stage workflows (WS-2 rejects
 * legacy transition commands on engine-active tickets), so no legacy transition
 * table is synthesized — an empty table means the board offers no legacy
 * affordances for these tickets. */
function stageWorkflowStatusConfig(workflowId: string, wf: StageWorkflow): ResolvedStatusConfig {
  const statuses = wf.stages.map((s) => ({
    id: s.id,
    label: s.label ?? toTitleCase(s.id),
    ...(s.color ? { color: s.color } : {}),
    ...(s.terminal ? { terminal: true } : {}),
  }));
  const terminalSet = new Set(wf.stages.filter((s) => s.terminal).map((s) => s.id));
  return {
    workflowId,
    label: wf.label ?? (workflowId === 'default' ? 'Default' : toTitleCase(workflowId)),
    custom: true,
    statuses,
    order: wf.stages.map((s) => s.id),
    transitions: [],
    transitionTable: new Map(),
    rawTransitions: [],
    transitionsCustom: true,
    terminalStatuses: terminalSet.size > 0 ? terminalSet : new Set(['completed', 'failed']),
    derive: null,
    facts: null,
    factDeclarations: [],
    deriveRegistry: buildDeriveRegistry([]),
    queryRegistry: buildQueryRegistry([]),
  };
}

/** Cached workflow-library meta (available ids + global default) so per-ticket
 * workflow resolution during board/detail materialization never re-reads +
 * re-parses config.md per ticket. Rebuilt from config.md on demand; cleared
 * alongside the status-config cache whenever config.md is written. */
let _cachedWorkflowMeta: { available: ReadonlySet<string>; defaultWorkflow: string | null } | null =
  null;

async function getWorkflowMeta(): Promise<{
  available: ReadonlySet<string>;
  defaultWorkflow: string | null;
}> {
  if (_cachedWorkflowMeta) return _cachedWorkflowMeta;
  const config = await readConfig();
  _cachedWorkflowMeta = {
    available: new Set(await effectiveWorkflowIds(config)),
    defaultWorkflow: config.defaultWorkflow ?? null,
  };
  return _cachedWorkflowMeta;
}

/**
 * The effective workflow-id set (WS-3, T8): once the migration relocates
 * workflows to per-file `~/.syntaur/workflows/<id>.md` and deletes the
 * `config.md` block, the LEGACY library synthesizes only `default` — reading it
 * alone would silently re-bind every non-default ticket. Per-file library
 * (when non-empty) is authoritative; the legacy config library remains the
 * pre-migration source. A mid-migration dual-source read falls back to legacy.
 */
export async function effectiveWorkflowIds(
  config: Awaited<ReturnType<typeof readConfig>>,
): Promise<string[]> {
  try {
    const { loadWorkflowLibrary } = await import('../utils/workflow-library.js');
    const perFile = Object.keys(loadWorkflowLibrary(config));
    if (perFile.length > 0) return perFile;
  } catch {
    /* dual-source window mid-migration — the legacy block is still live */
  }
  return Object.keys(getWorkflowLibrary(config));
}

const EMPTY_BINDING: ProjectWorkflowBinding = { defaultWorkflow: null, workflowByType: {} };

/** Resolve a ticket's workflow id from its `workflow`/`type` fields and a
 * project binding (from the already-parsed project record — no extra read).
 * Uses the cached workflow-library meta. First-hit-wins precedence. */
async function resolveWorkflowIdWithBinding(
  ticket: { workflow?: string | null; type?: string | null },
  binding: ProjectWorkflowBinding,
): Promise<string> {
  const meta = await getWorkflowMeta();
  return resolveWorkflowId({
    ticketWorkflow: ticket.workflow ?? null,
    ticketType: ticket.type ?? null,
    projectDefaultWorkflow: binding.defaultWorkflow,
    projectWorkflowByType: binding.workflowByType,
    globalDefaultWorkflow: meta.defaultWorkflow,
    available: meta.available,
  });
}

/** Resolve a ticket's workflow id reading the project binding from disk
 * (single-record paths where the parsed project isn't already in hand).
 * Standalone (no projectDir) → binding-less resolution. */
async function resolveWorkflowIdByDir(
  ticket: { workflow?: string | null; type?: string | null },
  projectDir: string | null,
): Promise<string> {
  const binding = projectDir ? await readProjectBinding(projectDir) : EMPTY_BINDING;
  return resolveWorkflowIdWithBinding(ticket, binding);
}

/** The per-ticket resolved status config (its OWN workflow). Convenience over
 * {@link resolveWorkflowIdByDir} + {@link getStatusConfig}. */
async function statusConfigForTicket(
  ticket: { workflow?: string | null; type?: string | null },
  projectDir: string | null,
): Promise<ResolvedStatusConfig> {
  return getStatusConfig(await resolveWorkflowIdByDir(ticket, projectDir));
}

/** Human label for a workflow id: the explicit `workflows.<id>.label`, else
 * `'Default'` for the built-in, else Title Case of the id. */
function workflowLabel(config: SyntaurConfig, workflowId: string): string {
  const explicit = config.workflows?.[workflowId]?.label;
  if (explicit) return explicit;
  return workflowId === 'default' ? 'Default' : toTitleCase(workflowId);
}

function resolveWorkflowStatusConfig(
  config: SyntaurConfig,
  workflowId: string,
): ResolvedStatusConfig {
  // The explicit per-workflow bundle: a named workflow, or — for the built-in
  // `'default'` in a legacy config with no `workflows:` block — the top-level
  // `statuses:` block. Null → no explicit config → read-only defaults branch.
  const explicitBundle: StatusConfig | null =
    config.workflows?.[workflowId] ?? (workflowId === 'default' ? config.statuses : null) ?? null;

  if (explicitBundle) {
    const sc = explicitBundle;
    // A bundle may declare facts and/or derive rules without any status
    // `definitions` (the parser preserves those rather than dropping the block).
    // Fall back to the default statuses/order so the board still renders, while
    // the declared facts/derive ride along — same no-silent-deletion contract.
    const defaults = sc.statuses.length === 0 ? buildDefaultStatusConfig() : null;
    const effectiveStatuses = defaults ? defaults.statuses : sc.statuses;
    const effectiveOrder = defaults ? defaults.order : sc.order;
    const terminalSet = new Set(effectiveStatuses.filter((s) => s.terminal).map((s) => s.id));
    // Custom statuses but no `transitions:` block → materialize a FRESH table
    // from DEFAULT_TRANSITION_TABLE entries (not the reference) so getTargetStatus
    // takes the custom `from:command` path and only offers valid-from-status
    // transitions.
    const hasCustomTransitions = sc.transitions.length > 0;
    const effectiveTransitions = hasCustomTransitions
      ? sc.transitions
      : Array.from(DEFAULT_TRANSITION_TABLE.entries()).map(([key, to]) => {
          const [from, command] = key.split(':');
          return { from, command, to };
        });
    const accepted = acceptFactDeclarations(normalizeFactDeclarations(sc.facts ?? null));
    return {
      workflowId,
      label: workflowLabel(config, workflowId),
      custom: true,
      statuses: effectiveStatuses,
      order: effectiveOrder,
      transitions: effectiveTransitions,
      transitionTable: buildTransitionTable(effectiveTransitions),
      rawTransitions: sc.transitions,
      transitionsCustom: hasCustomTransitions,
      terminalStatuses: terminalSet.size > 0 ? terminalSet : new Set(['completed', 'failed']),
      derive: sc.derive ?? null,
      facts: sc.facts ?? null,
      factDeclarations: accepted,
      deriveRegistry: buildDeriveRegistry(accepted),
      queryRegistry: buildQueryRegistry(accepted),
    };
  }

  // No explicit config for this workflow → shared default builder so the
  // dashboard and the `syntaur status` CLI resolve identical defaults (no drift).
  const def = buildDefaultStatusConfig();
  return {
    workflowId,
    label: workflowLabel(config, workflowId),
    custom: false,
    statuses: def.statuses,
    order: def.order,
    transitions: def.transitions,
    transitionTable: DEFAULT_TRANSITION_TABLE,
    rawTransitions: [],
    transitionsCustom: false,
    terminalStatuses: new Set(['completed', 'failed']),
    derive: null,
    facts: null,
    factDeclarations: [],
    deriveRegistry: buildDeriveRegistry([]),
    queryRegistry: buildQueryRegistry([]),
  };
}

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
export async function listWorkspaceRecords(
  projectsDir: string,
  ticketsDir?: string,
): Promise<
  Array<{
    projectSlug: string | null;
    ticketSlug: string;
    ticketTitle: string;
    worktreePath: string | null;
    branch: string | null;
  }>
> {
  const [projectRecords, standaloneRecords] = await Promise.all([
    listProjectRecords(projectsDir),
    listStandaloneRecords(ticketsDir),
  ]);

  const records: Array<{
    projectSlug: string | null;
    ticketSlug: string;
    ticketTitle: string;
    worktreePath: string | null;
    branch: string | null;
  }> = [];

  for (const project of projectRecords) {
    for (const ticket of project.tickets) {
      records.push({
        projectSlug: project.summary.slug,
        ticketSlug: ticket.slug,
        ticketTitle: ticket.title || ticket.slug,
        worktreePath: ticket.workspace.worktreePath ?? null,
        branch: ticket.workspace.branch ?? null,
      });
    }
  }

  for (const standalone of standaloneRecords) {
    records.push({
      projectSlug: null,
      ticketSlug: standalone.id,
      ticketTitle: standalone.record.title || standalone.id,
      worktreePath: standalone.record.workspace.worktreePath ?? null,
      branch: standalone.record.workspace.branch ?? null,
    });
  }

  return records;
}

/**
 * Get overview data used by the app landing page.
 * GET /api/overview?staleLimit=&staleOffset=
 */
export async function getOverview(
  projectsDir: string,
  ticketsDir?: string,
  options: { staleLimit?: number; staleOffset?: number } = {},
): Promise<OverviewResponse> {
  const traceEnabled = process.env.SYNTAUR_PERF_TRACE === '1';
  const traces: OverviewTraces | undefined = traceEnabled ? createTraces() : undefined;
  const overallStart = traceEnabled ? performance.now() : 0;

  const projectRecords = await timed(traces, 'list-project-records', () =>
    listProjectRecords(projectsDir, traces),
  );
  const standaloneRecords = await timed(traces, 'list-standalone-records', () =>
    listStandaloneRecords(ticketsDir),
  );
  // Archived projects + individually-archived tickets are hidden from every
  // overview aggregate (stats, recent projects, recent activity). The full record
  // sets are still used for firstRun detection and the segment-bucket builder
  // (which applies its own cascade filtering internally).
  const activeProjectRecords = projectRecords.filter((record) => !isProjectArchived(record.summary));
  const activeStandaloneRecords = standaloneRecords.filter((sr) => sr.record.archived !== true);
  const recentActivity = buildRecentActivity(activeProjectRecords, activeStandaloneRecords);

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

  if (traces) {
    const wallMs = performance.now() - overallStart;
    const totalTickets =
      projectRecords.reduce((sum, r) => sum + r.tickets.length, 0) + standaloneRecords.length;
    emitTrace(traces, {
      wallMs,
      fixture: { projects: projectRecords.length, tickets: totalTickets },
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    firstRun: projectRecords.length === 0 && standaloneRecords.length === 0,
    stats: {
      activeProjects: activeProjectRecords.filter((record) => record.summary.status === 'active').length,
      inProgressTickets: activeProjectRecords.reduce(
        (total, record) => total + (record.summary.progress['in_progress'] ?? 0),
        0,
      ),
      blockedTickets: activeProjectRecords.reduce(
        (total, record) => total + (record.summary.progress['blocked'] ?? 0),
        0,
      ),
      reviewTickets: activeProjectRecords.reduce(
        (total, record) => total + (record.summary.progress['review'] ?? 0),
        0,
      ),
      failedTickets: activeProjectRecords.reduce(
        (total, record) => total + (record.summary.progress['failed'] ?? 0),
        0,
      ),
      // Derived from the SAME classifier verdict as the stale segment (via the
      // pre-cap segment total) so the badge count can never diverge from the
      // listed rows.
      staleTickets: segments.stale.total,
    },
    hero,
    segments,
    recentSessions,
    recentProjects: activeProjectRecords
      .map((record) => record.summary)
      .sort((left, right) => compareTimestamps(right.updated, left.updated))
      .slice(0, RECENT_PROJECTS_LIMIT),
    recentActivity: recentActivity.slice(0, RECENT_ACTIVITY_LIMIT),
  };
}

/**
 * Get all tickets across all projects for the global kanban board.
 * GET /api/tickets
 */
export async function listTicketsBoard(
  projectsDir: string,
  ticketsDir?: string,
  options: { archived?: 'exclude' | 'only' } = {},
): Promise<TicketsBoardResponse> {
  const mode = options.archived ?? 'exclude';
  const projectRecords = await listProjectRecords(projectsDir);
  const projectItems = await Promise.all(
    projectRecords.flatMap(async (record) => {
      if (mode === 'only') {
        // Individually-archived tickets only — ignore project-archived cascade.
        return Promise.all(
          record.tickets
            .filter((ticket) => ticket.archived === true)
            .map(async (ticket) => toTicketBoardItem(projectsDir, record, ticket)),
        );
      }
      // 'exclude': cascade-hide every child of an archived project, and drop
      // individually-archived children of non-archived projects.
      if (isProjectArchived(record.summary)) return [] as TicketBoardItem[];
      return Promise.all(
        activeTickets(record.tickets).map(async (ticket) =>
          toTicketBoardItem(projectsDir, record, ticket),
        ),
      );
    }),
  );

  const standaloneRecords = await listStandaloneRecords(ticketsDir);
  const filteredStandalone =
    mode === 'only'
      ? standaloneRecords.filter((sr) => sr.record.archived === true)
      : standaloneRecords.filter((sr) => sr.record.archived !== true);
  const standaloneItems = await Promise.all(
    filteredStandalone.map(async (sr) => toStandaloneBoardItem(sr)),
  );

  return {
    generatedAt: new Date().toISOString(),
    tickets: [...projectItems.flat(), ...standaloneItems]
      .sort((left, right) => compareTimestamps(right.updated, left.updated)),
  };
}

function toArchivedTicketItem(
  ticket: TicketRecord,
  projectSlug: string | null,
  projectTitle: string | null,
): ArchivedTicketItem {
  return {
    id: ticket.id,
    slug: ticket.slug,
    title: ticket.title,
    status: ticket.status,
    type: ticket.type,
    priority: ticket.priority as ArchivedTicketItem['priority'],
    projectSlug,
    projectTitle,
    archived: ticket.archived,
    archivedAt: ticket.archivedAt,
    archivedReason: ticket.archivedReason,
    updated: ticket.updated,
  };
}

/**
 * Build the canonical archived view for the dashboard Archive page.
 * Returns archived projects (each expandable to ALL its children) plus
 * individually-archived tickets whose parent project is NOT archived
 * (so they are never double-listed) and archived standalone tickets.
 * GET /api/archived
 */
export async function listArchived(
  projectsDir: string,
  ticketsDir?: string,
): Promise<ArchiveResponse> {
  const projectRecords = await listProjectRecords(projectsDir);
  const standaloneRecords = await listStandaloneRecords(ticketsDir);

  const projects: ArchivedProjectItem[] = projectRecords
    .filter((record) => isProjectArchived(record.summary))
    .map((record) => ({
      slug: record.summary.slug,
      title: record.summary.title,
      archivedAt: record.summary.archivedAt,
      archivedReason: record.summary.archivedReason,
      tickets: record.tickets
        .map((ticket) =>
          toArchivedTicketItem(ticket, record.summary.slug, record.summary.title),
        )
        .sort((left, right) => compareTimestamps(right.updated, left.updated)),
    }))
    .sort((left, right) => compareTimestamps(right.archivedAt ?? '', left.archivedAt ?? ''));

  const individuallyArchived: ArchivedTicketItem[] = [];
  for (const record of projectRecords) {
    if (isProjectArchived(record.summary)) continue; // its children belong under the project above
    for (const ticket of record.tickets) {
      if (ticket.archived === true) {
        individuallyArchived.push(
          toArchivedTicketItem(ticket, record.summary.slug, record.summary.title),
        );
      }
    }
  }
  for (const sr of standaloneRecords) {
    if (sr.record.archived === true) {
      individuallyArchived.push(toArchivedTicketItem(sr.record, null, null));
    }
  }
  individuallyArchived.sort((left, right) => compareTimestamps(right.updated, left.updated));

  return { projects, tickets: individuallyArchived };
}

async function toStandaloneBoardItem(sr: StandaloneRecord): Promise<TicketBoardItem> {
  // Standalone → the ticket's own workflow (no project binding).
  const config = await statusConfigForTicket(sr.record, null);
  const { terminalStatuses } = config;

  let facts: TicketBoardItem['facts'];
  try {
    const { computeFacts } = await import('../lifecycle/facts.js');
    facts = await computeFacts({
      ticketDir: sr.ticketDir,
      frontmatter: sr.record as unknown as import('../lifecycle/types.js').TicketFrontmatter,
      body: sr.record.body,
      projectDir: null,
      terminalStatuses,
      declarations: config.factDeclarations,
    });
  } catch (err) {
    console.warn(`toStandaloneBoardItem: computeFacts failed for ${sr.ticketDir}:`, err);
  }

  return {
    ...toTicketSummary(sr.record, config),
    projectSlug: null,
    projectTitle: null,
    blockedReason: sr.record.blockedReason,
    availableTransitions: await getStandaloneAvailableTransitions(sr.record),
    facts,
  };
}

async function getStandaloneAvailableTransitions(
  ticket: TicketRecord,
): Promise<TicketTransitionAction[]> {
  // Standalone tickets have no dependencies, so skip dependency gating.
  // Commands offered come from the ticket's OWN workflow (no project binding).
  const config = await statusConfigForTicket(ticket, null);
  const transitionDefs = getTransitionDefinitions(config);
  const actions: TicketTransitionAction[] = [];

  for (const definition of transitionDefs) {
    const target = getTargetStatus(ticket.status, definition.command, config.transitionTable);
    // Only valid transitions reach the client; the kanban inline picker renders them directly.
    if (target === null) continue;

    let warning: string | null = null;
    if (definition.command === 'start' && !ticket.assignee) {
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
  ticketSlug?: string,
): Promise<EditableDocumentResponse | null> {
  const filePath = getDocumentPath(projectsDir, documentType, projectSlug, ticketSlug);
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
    appendOnly: documentType === 'handoff' || documentType === 'decision-record',
  };
}

/**
 * Resolve an ticket by UUID (standalone or project-nested) and return its
 * editable document payload for the given type.
 */
export async function getEditableDocumentById(
  projectsDir: string,
  ticketsDir: string,
  documentType: EditableDocumentResponse['documentType'],
  id: string,
): Promise<EditableDocumentResponse | null> {
  const resolved = await resolveTicketById(projectsDir, ticketsDir, id);
  if (!resolved) return null;

  if (!resolved.standalone && resolved.projectSlug) {
    return getEditableDocument(
      projectsDir,
      documentType,
      resolved.projectSlug,
      resolved.ticketSlug,
    );
  }

  const fileName =
    documentType === 'ticket'
      ? 'ticket.md'
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
  const filePath = resolve(resolved.ticketDir, fileName);
  if (!(await fileExists(filePath))) return null;

  const content = await readFile(filePath, 'utf-8');
  const label = resolved.id;
  const title =
    documentType === 'ticket'
      ? `Edit Ticket: ${label}`
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
    ticketSlug: undefined,
    ticketId: resolved.id,
    appendOnly: documentType === 'handoff' || documentType === 'decision-record',
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

  // Each ticket's terminal virtuals come from ITS OWN workflow (resolved via
  // this project's binding — already parsed, no extra read).
  const projectBinding: ProjectWorkflowBinding = {
    defaultWorkflow: project.defaultWorkflow,
    workflowByType: project.workflowByType,
  };
  const ticketSummaries = (
    await Promise.all(
      tickets.map(async (a) => {
        const config = await getStatusConfig(await resolveWorkflowIdWithBinding(a, projectBinding));
        return toTicketSummary(a, config);
      }),
    )
  ).sort((left, right) => compareTimestamps(right.updated, left.updated));

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
 * Get full ticket detail with plan, scratchpad, handoff, and decision record.
 * GET /api/projects/:slug/tickets/:aslug
 */
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

export async function getTicketDetail(
  projectsDir: string,
  projectSlug: string,
  ticketSlug: string,
): Promise<TicketDetail | null> {
  const ticketDir = resolve(projectsDir, projectSlug, 'tickets', ticketSlug);
  const ticketMdPath = resolve(ticketDir, 'ticket.md');

  if (!(await fileExists(ticketMdPath))) {
    return null;
  }

  const ticketContent = await readFile(ticketMdPath, 'utf-8');
  const ticket = parseTicketFull(ticketContent);

  let plan: TicketDetail['plan'] = null;
  const planFile = await latestPlanFile(ticketDir);
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

  let handoff: TicketDetail['handoff'] = null;
  const handoffPath = resolve(ticketDir, 'handoff.md');
  if (await fileExists(handoffPath)) {
    const handoffContent = await readFile(handoffPath, 'utf-8');
    const parsed = parseHandoff(handoffContent);
    handoff = {
      updated: parsed.updated,
      handoffCount: parsed.handoffCount,
      body: parsed.body,
    };
  }

  let decisionRecord: TicketDetail['decisionRecord'] = null;
  const decisionRecordPath = resolve(ticketDir, 'decision-record.md');
  if (await fileExists(decisionRecordPath)) {
    const decisionRecordContent = await readFile(decisionRecordPath, 'utf-8');
    const parsed = parseDecisionRecord(decisionRecordContent);
    decisionRecord = {
      updated: parsed.updated,
      decisionCount: parsed.decisionCount,
      body: parsed.body,
    };
  }

  let progress: TicketDetail['progress'] = null;
  const progressPath = resolve(ticketDir, 'progress.md');
  if (await fileExists(progressPath)) {
    const progressContent = await readFile(progressPath, 'utf-8');
    const parsed = parseProgress(progressContent);
    progress = {
      updated: parsed.updated,
      entryCount: parsed.entryCount,
      entries: parsed.entries,
    };
  }

  let comments: TicketDetail['comments'] = null;
  const commentsPath = resolve(ticketDir, 'comments.md');
  if (await fileExists(commentsPath)) {
    const commentsContent = await readFile(commentsPath, 'utf-8');
    const parsed = parseComments(commentsContent);
    comments = {
      updated: parsed.updated,
      entryCount: parsed.entryCount,
      entries: parsed.entries,
    };
  }

  const wfConfig = await statusConfigForTicket(ticket, resolve(projectsDir, projectSlug));
  const detail: TicketDetail = {
    id: ticket.id,
    projectSlug,
    slug: ticket.slug || ticketSlug,
    title: ticket.title,
    status: ticket.status,
    type: ticket.type,
    workflow: ticket.workflow,
    resolvedWorkflow: wfConfig.workflowId,
    workflowLabel: wfConfig.label,
    statusLabel: statusLabelFor(wfConfig, ticket.status),
    priority: ticket.priority as TicketDetail['priority'],
    assignee: ticket.assignee,
    dependsOn: ticket.dependsOn,
    links: ticket.links,
    reverseLinks: [],
    enrichedLinks: [],
    blockedReason: ticket.blockedReason,
    workspace: ticket.workspace,
    externalIds: ticket.externalIds,
    tags: ticket.tags,
    archived: ticket.archived,
    archivedAt: ticket.archivedAt,
    archivedReason: ticket.archivedReason,
    ...deriveStatusVirtuals(ticket, wfConfig.terminalStatuses),
    override: ticket.override,
    derived: await buildDerivedDetail(ticket, ticketDir, resolve(projectsDir, projectSlug)),
    created: ticket.created,
    updated: ticket.updated,
    body: ticket.body,
    plan,
    scratchpad,
    handoff,
    decisionRecord,
    progress,
    comments,
    referencedBy: [],
    engagements: buildTicketEngagements(ticket.id),
    availableTransitions: await getAvailableTransitions(
      projectsDir,
      projectSlug,
      ticketSlug,
      ticket,
    ),
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
 * Scan every *other* ticket's Todos, progress, comments, and handoff bodies
 * for markdown links that resolve to `target`, and return an aggregated per-source
 * count (capped at 50).
 */
async function computeReferencedBy(
  target: ReferenceTarget,
  projectsDir: string,
  ticketsDir: string | undefined,
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
        ticketDir: resolve(rec.projectPath, 'tickets', a.slug),
      });
    }
  }
  // standalone
  const standaloneRecords = await listStandaloneRecords(ticketsDir);
  for (const sr of standaloneRecords) {
    sources.push({
      id: sr.id,
      slug: sr.record.slug || sr.id,
      title: sr.record.title,
      projectSlug: null,
      ticketDir: sr.ticketDir,
    });
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
 * Resolve an ticket by UUID (standalone or project-nested) and return its full detail payload.
 * GET /api/tickets/:id
 */
export async function getTicketDetailById(
  projectsDir: string,
  ticketsDir: string,
  id: string,
): Promise<TicketDetail | null> {
  const resolved = await resolveTicketById(projectsDir, ticketsDir, id);
  if (!resolved) return null;

  if (!resolved.standalone && resolved.projectSlug) {
    // Use the standard detail fetcher, then also scan standalone tickets
    // for backlinks.
    const detail = await getTicketDetail(projectsDir, resolved.projectSlug, resolved.ticketSlug);
    if (!detail) return null;
    detail.referencedBy = await computeReferencedBy(
      { id: detail.id, projectSlug: detail.projectSlug, slug: detail.slug },
      projectsDir,
      ticketsDir,
    );
    return detail;
  }

  // Standalone path — load companion docs directly from the resolved dir.
  const standaloneDetail = await buildStandaloneTicketDetail(resolved);
  if (!standaloneDetail) return null;
  standaloneDetail.referencedBy = await computeReferencedBy(
    { id: standaloneDetail.id, projectSlug: null, slug: standaloneDetail.slug },
    projectsDir,
    ticketsDir,
  );
  return standaloneDetail;
}

async function buildStandaloneTicketDetail(
  resolved: ResolvedTicket,
): Promise<TicketDetail | null> {
  const ticketDir = resolved.ticketDir;
  const ticketMdPath = resolve(ticketDir, 'ticket.md');
  if (!(await fileExists(ticketMdPath))) return null;

  const ticketContent = await readFile(ticketMdPath, 'utf-8');
  const ticket = parseTicketFull(ticketContent);

  let plan: TicketDetail['plan'] = null;
  const planFile = await latestPlanFile(ticketDir);
  if (planFile) {
    const planPath = resolve(ticketDir, planFile);
    if (await fileExists(planPath)) {
      const parsed = parsePlan(await readFile(planPath, 'utf-8'));
      plan = { status: parsed.status, updated: parsed.updated, body: parsed.body };
    }
  }

  let scratchpad: TicketDetail['scratchpad'] = null;
  const scratchpadPath = resolve(ticketDir, 'scratchpad.md');
  if (await fileExists(scratchpadPath)) {
    const parsed = parseScratchpad(await readFile(scratchpadPath, 'utf-8'));
    scratchpad = { updated: parsed.updated, body: parsed.body };
  }

  let handoff: TicketDetail['handoff'] = null;
  const handoffPath = resolve(ticketDir, 'handoff.md');
  if (await fileExists(handoffPath)) {
    const parsed = parseHandoff(await readFile(handoffPath, 'utf-8'));
    handoff = { updated: parsed.updated, handoffCount: parsed.handoffCount, body: parsed.body };
  }

  let decisionRecord: TicketDetail['decisionRecord'] = null;
  const decisionRecordPath = resolve(ticketDir, 'decision-record.md');
  if (await fileExists(decisionRecordPath)) {
    const parsed = parseDecisionRecord(await readFile(decisionRecordPath, 'utf-8'));
    decisionRecord = { updated: parsed.updated, decisionCount: parsed.decisionCount, body: parsed.body };
  }

  let progress: TicketDetail['progress'] = null;
  const progressPath = resolve(ticketDir, 'progress.md');
  if (await fileExists(progressPath)) {
    const parsed = parseProgress(await readFile(progressPath, 'utf-8'));
    progress = { updated: parsed.updated, entryCount: parsed.entryCount, entries: parsed.entries };
  }

  let comments: TicketDetail['comments'] = null;
  const commentsPath = resolve(ticketDir, 'comments.md');
  if (await fileExists(commentsPath)) {
    const parsed = parseComments(await readFile(commentsPath, 'utf-8'));
    comments = { updated: parsed.updated, entryCount: parsed.entryCount, entries: parsed.entries };
  }

  const wfConfig = await statusConfigForTicket(ticket, null);
  const detail: TicketDetail = {
    id: ticket.id,
    projectSlug: null,
    slug: ticket.slug || resolved.id,
    title: ticket.title,
    status: ticket.status,
    type: ticket.type,
    workflow: ticket.workflow,
    resolvedWorkflow: wfConfig.workflowId,
    workflowLabel: wfConfig.label,
    statusLabel: statusLabelFor(wfConfig, ticket.status),
    priority: ticket.priority as TicketDetail['priority'],
    assignee: ticket.assignee,
    dependsOn: [], // standalone cannot declare dependencies
    links: [],
    reverseLinks: [],
    enrichedLinks: [],
    blockedReason: ticket.blockedReason,
    workspace: ticket.workspace,
    externalIds: ticket.externalIds,
    tags: ticket.tags,
    archived: ticket.archived,
    archivedAt: ticket.archivedAt,
    archivedReason: ticket.archivedReason,
    ...deriveStatusVirtuals(ticket, wfConfig.terminalStatuses),
    override: ticket.override,
    derived: await buildDerivedDetail(ticket, ticketDir, null),
    created: ticket.created,
    updated: ticket.updated,
    body: ticket.body,
    plan,
    scratchpad,
    handoff,
    decisionRecord,
    progress,
    comments,
    referencedBy: [],
    engagements: buildTicketEngagements(ticket.id),
    availableTransitions: await getStandaloneAvailableTransitions(ticket),
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
  const cached = projectRecordsCache.get(projectsDir);
  if (cached) return cached;
  // `traces` only flows through on a cache miss; a hit legitimately does ~0
  // fan-out, so the absence of per-phase traces on a hit is the correct signal.
  const promise = computeProjectRecords(projectsDir, traces);
  projectRecordsCache.set(projectsDir, promise);
  promise.catch(() => projectRecordsCache.delete(projectsDir));
  return promise;
}

async function computeProjectRecords(
  projectsDir: string,
  traces?: OverviewTraces,
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

      const t0 = traces ? performance.now() : 0;
      const projectContent = await readFile(projectMdPath, 'utf-8');
      const project = parseProject(projectContent);
      if (traces) accumulatePhase(traces, 'parse-project-md', performance.now() - t0);

      const t1 = traces ? performance.now() : 0;
      const tickets = await listTicketRecords(projectPath, traces);
      if (traces) accumulatePhase(traces, 'list-tickets', performance.now() - t1);

      const t2 = traces ? performance.now() : 0;
      const rollup = await buildProjectRollup(projectPath, project, tickets, traces);
      if (traces) accumulatePhase(traces, 'build-rollup', performance.now() - t2);

      // Archived children are hidden, so archiving an old one must not bump the
      // project's activity timestamp (which drives list/recent-projects ordering).
      const updated = getProjectActivityTimestamp(project.updated, activeTickets(tickets));

      const t3 = traces ? performance.now() : 0;
      const dependencyGraph = await loadDependencyGraph(projectPath, tickets);
      if (traces) accumulatePhase(traces, 'load-dep-graph', performance.now() - t3);

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
  traces?: OverviewTraces,
): Promise<TicketRecord[]> {
  const ticketsDir = resolve(projectPath, 'tickets');
  if (!(await fileExists(ticketsDir))) {
    return [];
  }

  const entries = await readdir(ticketsDir, { withFileTypes: true });
  const dirEntries = entries.filter((entry) => entry.isDirectory());

  const maybeRecords = await Promise.all(
    dirEntries.map(async (entry): Promise<TicketRecord | null> => {
      const ticketMd = resolve(ticketsDir, entry.name, 'ticket.md');
      if (!(await fileExists(ticketMd))) {
        return null;
      }
      const t0 = traces ? performance.now() : 0;
      const content = await readFile(ticketMd, 'utf-8');
      const parsed = parseTicketFull(content);
      if (traces) accumulatePhase(traces, 'read-ticket-md', performance.now() - t0);
      return parsed;
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
  traces?: OverviewTraces,
): Promise<{
  progress: ProgressCounts;
  needsAttention: NeedsAttention;
  status: string;
}> {
  // Archived children are hidden from normal views, so they must not count in
  // the project's progress/totals/status rollup either (cascade consistency).
  const active = activeTickets(tickets);
  const progress: ProgressCounts = { total: active.length };

  // Map: read every comments.md in parallel. Reduce: fold the per-ticket
  // results into progress counters + openQuestions sum.
  const perTicket = await Promise.all(
    active.map(async (ticket) => {
      const t0 = traces ? performance.now() : 0;
      const openQuestions = await countOpenQuestions(projectPath, ticket.slug);
      if (traces) accumulatePhase(traces, 'count-open-questions', performance.now() - t0);
      return { status: ticket.status, openQuestions };
    }),
  );

  let openQuestions = 0;
  for (const entry of perTicket) {
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

/**
 * Derive the loader-only virtual fields from a ticket's `statusHistory`
 * (never stored on disk). `completedAt` is the `at` of the LAST transition into
 * the current status, but only when that status is terminal (lifecycle
 * `completed`/`failed`) — so an ticket reopened after completion reports null,
 * because its current status is no longer terminal. `statusAge` is the elapsed
 * milliseconds since the last entry (time in current status), null when there is
 * no history or the timestamp is unparseable.
 */
function deriveStatusVirtuals(
  ticket: TicketRecord,
  terminalStatuses: ReadonlySet<string>,
): {
  completedAt: string | null;
  statusAge: number | null;
  phaseAge: number | null;
  phase: string | null;
  disposition: string | null;
  pinned: boolean;
} {
  const hist = ticket.statusHistory ?? [];

  let completedAt: string | null = null;
  if (terminalStatuses.has(ticket.status)) {
    for (const entry of hist) {
      if (entry.to === ticket.status) completedAt = entry.at;
    }
  }

  // statusAge counts HEADLINE changes only: dimension-only entries (from == to,
  // e.g. phase advanced while blocked) must not reset the clock. The seed
  // entry (from: null) counts as a headline change.
  let statusAge: number | null = null;
  for (let i = hist.length - 1; i >= 0; i--) {
    const entry = hist[i];
    if (entry.from !== entry.to || entry.from === null) {
      const t = Date.parse(entry.at);
      statusAge = Number.isNaN(t) ? null : Date.now() - t;
      break;
    }
  }

  let phaseAge: number | null = null;
  for (let i = hist.length - 1; i >= 0; i--) {
    const entry = hist[i];
    if (entry.phaseTo !== undefined && entry.phaseFrom !== entry.phaseTo) {
      const t = Date.parse(entry.at);
      phaseAge = Number.isNaN(t) ? null : Date.now() - t;
      break;
    }
  }

  return {
    completedAt,
    statusAge,
    // Post-marker the stage IS `status` — the frontmatter `phase` mirror is
    // stale forever on preserved terminals (89 completed carry phase: review),
    // and `phaseTo` history entries stop being written so phaseAge freezes.
    // Sync peek warmed by getStatusConfig; false = pre-marker behavior.
    phaseAge: _stagesMigratedCache ? statusAge : phaseAge,
    phase: _stagesMigratedCache ? ticket.status : ticket.phase,
    disposition: ticket.disposition,
    pinned: ticket.override !== null,
  };
}

/**
 * Server-side materialization of the derivation detail for one ticket
 * (design v3: the browser never reads the filesystem — facts ship in the
 * payload). Null for terminal tickets (derivation defers entirely).
 */
async function buildDerivedDetail(
  ticket: TicketRecord,
  ticketDir: string,
  projectDir: string | null,
): Promise<TicketDetail['derived']> {
  // Derive against the ticket's OWN workflow (its terminal set, derive rules,
  // fact registry, known statuses) so the dashboard projection agrees with the
  // CLI recompute for the same ticket.
  const config = await statusConfigForTicket(ticket, projectDir);
  if (config.terminalStatuses.has(ticket.status)) return null;
  try {
    const { computeFactsDetailed } = await import('../lifecycle/facts.js');
    const { deriveDimensions } = await import('../lifecycle/derive.js');
    const { DEFAULT_DERIVE_CONFIG } = await import('../utils/config.js');
    // ONE compute pass: facts (custom + attestation exports) and per-record
    // validity come from the same plan-file / HEAD reads. Fresh-per-request is
    // what makes binds:commit lazy convergence honest (Locked Decisions).
    const { facts, attestations } = await computeFactsDetailed({
      ticketDir,
      frontmatter: {
        ...ticket,
        // TicketRecord ⊃ the fields computeFacts reads (incl. facts +
        // attestations from the parser); statusHistory + derived caches ride along.
      } as unknown as import('../lifecycle/types.js').TicketFrontmatter,
      body: ticket.body,
      projectDir,
      terminalStatuses: config.terminalStatuses,
      declarations: config.factDeclarations,
    });
    const dims = deriveDimensions({
      facts,
      derive: config.derive ?? DEFAULT_DERIVE_CONFIG,
      currentStatus: ticket.status,
      terminalStatuses: config.terminalStatuses,
      knownStatusIds: new Set(config.statuses.map((s) => s.id)),
      override: ticket.override,
      registry: config.deriveRegistry,
    });
    if (!dims) return null;

    // customFacts: declared bool/number values only — the client renders them
    // without guessing which keys are built-ins (the server separated them).
    const customFacts: Record<string, boolean | number> = {};
    for (const decl of config.factDeclarations) {
      if (decl.type === 'bool' || decl.type === 'number') {
        const v = facts[decl.name];
        if (typeof v === 'boolean' || typeof v === 'number') customFacts[decl.name] = v;
      }
    }

    // WS-3 compat window (§4.5): `derivedStatus`/`nextAction` are DEPRECATED
    // payload mirrors kept one release. When the stage engine is active for
    // this ticket (marker + per-file workflow + stored status is a stage),
    // the honest mirror is the STORED stage and its `guidance:` — the ladder's
    // re-ranked headline would contradict the frozen stage position.
    let derivedStatus = dims.derivedStatus;
    let nextAction = dims.nextAction;
    try {
      const { isStagesMigrated } = await import('../lifecycle/recompute.js');
      if (await isStagesMigrated()) {
        const { makeWorkflowContextResolver } = await import('../lifecycle/workflow-context.js');
        const sw = await makeWorkflowContextResolver(await readConfig()).stageWorkflowFor(
          ticket,
          projectDir,
        );
        const stage = sw?.stages.find((s) => s.id === ticket.status);
        if (stage) {
          derivedStatus = ticket.status;
          nextAction = stage.guidance ?? null;
        }
      }
    } catch {
      /* dual-source window mid-migration — keep the ladder mirror */
    }

    return {
      derivedStatus,
      nextAction,
      facts: facts as unknown as Record<string, boolean | number | string[]>,
      customFacts,
      attestations: attestations.map((a) => ({
        fact: a.fact,
        binds: a.binds,
        records: a.records.map(({ record, valid }) => ({
          actor: record.actor,
          verdict: record.verdict,
          at: record.at,
          note: record.note ?? null,
          stale: !valid,
        })),
      })),
    };
  } catch (err) {
    // Best-effort enrichment, never a 500 — but not silent (codex finding 12).
    console.warn(`buildDerivedDetail failed for ${ticketDir}:`, err);
    return null;
  }
}

/** Display label for a status id within a resolved workflow (falls back to the
 * raw id when the status isn't in the workflow's definitions). */
function statusLabelFor(config: ResolvedStatusConfig, status: string): string {
  return config.statuses.find((s) => s.id === status)?.label ?? status;
}

function toTicketSummary(
  ticket: TicketRecord,
  config: ResolvedStatusConfig,
): TicketSummary {
  return {
    id: ticket.id,
    slug: ticket.slug,
    title: ticket.title,
    status: ticket.status,
    type: ticket.type,
    workflow: ticket.workflow,
    resolvedWorkflow: config.workflowId,
    workflowLabel: config.label,
    statusLabel: statusLabelFor(config, ticket.status),
    priority: ticket.priority as TicketSummary['priority'],
    assignee: ticket.assignee,
    dependsOn: ticket.dependsOn,
    links: ticket.links,
    tags: ticket.tags,
    externalIds: ticket.externalIds,
    created: ticket.created,
    updated: ticket.updated,
    archived: ticket.archived,
    archivedAt: ticket.archivedAt,
    archivedReason: ticket.archivedReason,
    ...deriveStatusVirtuals(ticket, config.terminalStatuses),
  };
}

async function toTicketBoardItem(
  projectsDir: string,
  projectRecord: ProjectRecord,
  ticket: TicketRecord,
): Promise<TicketBoardItem> {
  // Resolve the ticket's OWN workflow once (from the already-parsed project
  // binding — no extra read) and reuse it for terminal virtuals, fact
  // declarations, and the available-transitions table.
  const workflowId = await resolveWorkflowIdWithBinding(ticket, {
    defaultWorkflow: projectRecord.project.defaultWorkflow,
    workflowByType: projectRecord.project.workflowByType,
  });
  const config = await getStatusConfig(workflowId);
  const { terminalStatuses } = config;

  const ticketDir = resolve(projectRecord.projectPath, 'tickets', ticket.slug);
  const projectDir = projectRecord.projectPath;

  let facts: TicketBoardItem['facts'];
  try {
    const { computeFacts } = await import('../lifecycle/facts.js');
    facts = await computeFacts({
      ticketDir,
      frontmatter: ticket as unknown as import('../lifecycle/types.js').TicketFrontmatter,
      body: ticket.body,
      projectDir,
      terminalStatuses,
      declarations: config.factDeclarations,
    });
  } catch (err) {
    console.warn(`toTicketBoardItem: computeFacts failed for ${ticketDir}:`, err);
  }

  return {
    ...toTicketSummary(ticket, config),
    projectSlug: projectRecord.summary.slug,
    projectTitle: projectRecord.summary.title,
    blockedReason: ticket.blockedReason,
    availableTransitions: await getAvailableTransitions(
      projectsDir,
      projectRecord.summary.slug,
      ticket.slug,
      ticket,
      { resolvedConfig: config },
    ),
    facts,
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

function buildDependencyGraph(tickets: TicketRecord[]): string | null {
  const edges: string[] = [];
  const usedStatuses = new Set<string>();

  for (const ticket of tickets) {
    for (const dependency of ticket.dependsOn) {
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

function findTicketStatus(tickets: TicketRecord[], slug: string): string {
  return tickets.find((ticket) => ticket.slug === slug)?.status ?? 'pending';
}

async function getAvailableTransitions(
  projectsDir: string,
  projectSlug: string,
  ticketSlug: string,
  ticket: TicketRecord,
  options?: {
    dependencyStatusMap?: ReadonlyMap<string, string>;
    traces?: OverviewTraces;
    /** Pre-resolved per-ticket status config — pass in board loops so the
     * ticket's workflow isn't re-resolved (and project.md re-read) per call. */
    resolvedConfig?: ResolvedStatusConfig;
  },
): Promise<TicketTransitionAction[]> {
  const projectPath = resolve(projectsDir, projectSlug);
  // Transitions offered come from the ticket's OWN workflow (its transition
  // table + terminal set), resolved via the project binding.
  const config = options?.resolvedConfig ?? (await statusConfigForTicket(ticket, projectPath));
  const transitionDefs = getTransitionDefinitions(config);
  const actions: TicketTransitionAction[] = [];
  const traces = options?.traces;

  for (const definition of transitionDefs) {
    const target = getTargetStatus(ticket.status, definition.command, config.transitionTable);
    // Only valid transitions reach the client; the kanban inline picker renders them directly.
    if (target === null) continue;

    let warning: string | null = null;

    if (definition.command === 'start' && !ticket.assignee) {
      warning = 'No assignee set — consider assigning before starting.';
    }

    if (definition.command === 'start' && ticket.dependsOn.length > 0) {
      const t0 = traces ? performance.now() : 0;
      const unmetDependencies = await getUnmetDependencies(
        projectPath,
        ticket.dependsOn,
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

    const dependencyPath = resolve(projectPath, 'tickets', dependency, 'ticket.md');
    if (!(await fileExists(dependencyPath))) {
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

const STALE_SEVERITY_RANK: Record<StaleReason['severity'], number> = { high: 3, medium: 2, low: 1 };

/** Highest-severity reason (drives the displayed stale reason line). */
function topStaleReason(reasons: StaleReason[]): StaleReason | null {
  if (reasons.length === 0) return null;
  return reasons
    .slice()
    .sort((a, b) => STALE_SEVERITY_RANK[b.severity] - STALE_SEVERITY_RANK[a.severity])[0];
}

/** Activity age from `progress.md` mtime (the honest signal — NOT ticket
 * `updated`, which recompute bumps). `null` when there is no progress.md, so the
 * classifier's activity-based reason fails safe (never fires on unknown). */
async function readProgressActivityMs(progressPath: string, now: number): Promise<number | null> {
  try {
    const s = await stat(progressPath);
    return Math.max(0, now - s.mtimeMs);
  } catch {
    return null;
  }
}

/** Run the shared staleness classifier for one ticket record. */
function classifyTicketRecord(
  ticket: TicketRecord,
  terminalStatuses: ReadonlySet<string>,
  depsSatisfied: boolean | null,
  lastActivityMs: number | null,
  thresholds: StaleThresholds,
): StaleReason[] {
  const virtuals = deriveStatusVirtuals(ticket, terminalStatuses);
  return classifyNeedsAttention(
    {
      phase: virtuals.phase,
      disposition: virtuals.disposition,
      isTerminal: terminalStatuses.has(ticket.status),
      assignee: ticket.assignee ?? null,
      blockedReason: ticket.blockedReason,
      depsSatisfied,
      // plan_awaiting_approval is deferred to the decision inbox's plan-approval
      // category for now; pass values that keep that reason dormant.
      planExists: false,
      planApproved: true,
      statusAgeMs: virtuals.statusAge,
      lastActivityMs,
    },
    thresholds,
  );
}

/**
 * Read-only scan of EVERY active ticket (project + standalone, unpaged) for
 * the staleness watchdog. Reuses the same classifier + resolved terminals +
 * config thresholds as the overview, keyed by ticket id (stable UUID). Never
 * writes anything.
 */
export async function collectStaleCandidates(
  projectsDir: string,
  ticketsDir?: string,
): Promise<StaleCandidate[]> {
  const [projectRecords, standaloneRecords] = await Promise.all([
    listProjectRecords(projectsDir),
    listStandaloneRecords(ticketsDir),
  ]);
  const thresholds = resolveStaleThresholds((await readConfig()).staleness);
  const now = Date.now();
  const out: StaleCandidate[] = [];

  for (const record of projectRecords) {
    if (isProjectArchived(record.summary)) continue;
    const projectPath = resolve(projectsDir, record.summary.slug);
    const binding: ProjectWorkflowBinding = {
      defaultWorkflow: record.project.defaultWorkflow,
      workflowByType: record.project.workflowByType,
    };
    const depMap = new Map<string, string>();
    for (const a of record.tickets) depMap.set(a.slug, a.status);
    for (const ticket of activeTickets(record.tickets)) {
      // Terminal set from the ticket's OWN workflow, so a custom terminal status
      // isn't misread as "active" and wrongly flagged stale.
      const { terminalStatuses } = await getStatusConfig(
        await resolveWorkflowIdWithBinding(ticket, binding),
      );
      const depsSatisfied =
        ticket.dependsOn.length === 0
          ? true
          : (await getUnmetDependencies(projectPath, ticket.dependsOn, terminalStatuses, depMap)).length === 0;
      const lastActivityMs = await readProgressActivityMs(
        resolve(projectPath, 'tickets', ticket.slug, 'progress.md'),
        now,
      );
      const reasons = classifyTicketRecord(ticket, terminalStatuses, depsSatisfied, lastActivityMs, thresholds);
      if (reasons.length > 0) {
        out.push({ ticketId: ticket.id, projectSlug: record.summary.slug, reasons });
      }
    }
  }

  for (const sr of standaloneRecords) {
    if (sr.record.archived === true) continue;
    const { terminalStatuses } = await statusConfigForTicket(sr.record, null);
    const lastActivityMs = await readProgressActivityMs(resolve(sr.ticketDir, 'progress.md'), now);
    const reasons = classifyTicketRecord(sr.record, terminalStatuses, true, lastActivityMs, thresholds);
    if (reasons.length > 0) out.push({ ticketId: sr.record.id, projectSlug: null, reasons });
  }

  return out;
}

async function buildOverviewSegmentBuckets(
  projectsDir: string,
  projectRecords: ProjectRecord[],
  standaloneRecords: StandaloneRecord[],
  traces?: OverviewTraces,
): Promise<OverviewSegmentBuckets> {
  const now = Date.now();
  const buckets = emptyBuckets();
  // Terminal statuses are resolved PER TICKET (its own workflow) inside the loops
  // below — a custom terminal status must not be misread as active/stale.
  // Staleness age-gates: config overrides merged over defaults (defaults-first).
  const staleThresholds = resolveStaleThresholds((await readConfig()).staleness);
  // Pool of all non-terminal rows (across primary segments) used to seed
  // `newestCreated`. Each entry remembers its `created` timestamp + the row
  // we'd clone into the segment.
  const newestPool: Array<{ created: string; clone: AttentionItem }> = [];

  for (const record of projectRecords) {
    // Cascade-hide: an archived project contributes none of its tickets to
    // the overview segments.
    if (isProjectArchived(record.summary)) continue;

    // Build a dep-status map once per project so getUnmetDependencies can resolve
    // dependency status from memory instead of re-reading each dep's ticket.md.
    // (Built over ALL tickets so dependency resolution is unaffected by hiding.)
    const depMap = new Map<string, string>();
    for (const a of record.tickets) {
      depMap.set(a.slug, a.status);
    }

    // Individually-archived tickets are hidden from the overview segments.
    const visibleTickets = activeTickets(record.tickets);

    // Resolve every per-ticket getAvailableTransitions call for this project
    // in parallel, then run the synchronous classification logic below over the results.
    const projectPath = resolve(projectsDir, record.summary.slug);
    const binding: ProjectWorkflowBinding = {
      defaultWorkflow: record.project.defaultWorkflow,
      workflowByType: record.project.workflowByType,
    };
    const resolvedTransitions = await Promise.all(
      visibleTickets.map(async (ticket) => {
        // The ticket's OWN workflow config → its transition table + terminal set.
        const resolvedConfig = await getStatusConfig(
          await resolveWorkflowIdWithBinding(ticket, binding),
        );
        const ticketTerminal = resolvedConfig.terminalStatuses;
        const t0 = traces ? performance.now() : 0;
        const availableTransitions = await getAvailableTransitions(
          projectsDir,
          record.summary.slug,
          ticket.slug,
          ticket,
          { traces, dependencyStatusMap: depMap, resolvedConfig },
        );
        if (traces) accumulatePhase(traces, 'get-available-transitions', performance.now() - t0);
        // Inputs for the staleness classifier (resolved off already-parsed data
        // + one progress.md stat). depsSatisfied via the in-memory depMap; no
        // extra disk read when there are no deps.
        const depsSatisfied =
          ticket.dependsOn.length === 0
            ? true
            : (await getUnmetDependencies(projectPath, ticket.dependsOn, ticketTerminal, depMap))
                .length === 0;
        const lastActivityMs = await readProgressActivityMs(
          resolve(projectPath, 'tickets', ticket.slug, 'progress.md'),
          now,
        );
        return { ticket, availableTransitions, depsSatisfied, lastActivityMs, ticketTerminal };
      }),
    );

    for (const {
      ticket,
      availableTransitions,
      depsSatisfied,
      lastActivityMs,
      ticketTerminal,
    } of resolvedTransitions) {
      const segmentId = STATUS_TO_SEGMENT[ticket.status];
      const isTerminal = ticketTerminal.has(ticket.status);
      const staleReasons = classifyTicketRecord(
        ticket,
        ticketTerminal,
        depsSatisfied,
        lastActivityMs,
        staleThresholds,
      );
      const stale = staleReasons.length > 0;
      const agingMs = Math.max(0, now - parseTimestamp(ticket.updated));
      const baseId = `${record.summary.slug}:${ticket.slug}`;

      const shared = {
        projectSlug: record.summary.slug,
        projectTitle: record.summary.title,
        ticketSlug: ticket.slug,
        ticketTitle: ticket.title,
        status: ticket.status,
        updated: ticket.updated,
        href: `/t/${ticket.id}`,
        blockedReason: ticket.blockedReason,
        stale,
        agingMs,
        assignee: ticket.assignee ?? null,
        availableTransitions,
      };

      if (segmentId) {
        const reason =
          segmentId === 'blocked' && ticket.blockedReason
            ? ticket.blockedReason
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
        const top = topStaleReason(staleReasons);
        const staleItem: AttentionItem = {
          ...shared,
          id: `${baseId}:stale`,
          severity: 'low',
          reason: top?.label ?? SEGMENT_REASON.stale,
          segment: 'stale',
        };
        buckets.stale.push(staleItem);
      }

      if (!isTerminal) {
        newestPool.push({
          created: ticket.created,
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
    standaloneRecords
      .filter((sr) => sr.record.archived !== true)
      .map(async (sr) => {
      const t0 = traces ? performance.now() : 0;
      const availableTransitions = await getStandaloneAvailableTransitions(sr.record);
      if (traces) accumulatePhase(traces, 'get-available-transitions', performance.now() - t0);
      const lastActivityMs = await readProgressActivityMs(resolve(sr.ticketDir, 'progress.md'), now);
      // Standalone → the ticket's own workflow terminal set (no project binding).
      const { terminalStatuses: ticketTerminal } = await statusConfigForTicket(sr.record, null);
      return { sr, availableTransitions, lastActivityMs, ticketTerminal };
    }),
  );

  for (const { sr, availableTransitions, lastActivityMs, ticketTerminal } of resolvedStandaloneTransitions) {
    const ticket = sr.record;
    const segmentId = STATUS_TO_SEGMENT[ticket.status];
    const isTerminal = ticketTerminal.has(ticket.status);
    // Standalone tickets cannot declare dependencies → depsSatisfied is true.
    const staleReasons = classifyTicketRecord(
      ticket,
      ticketTerminal,
      true,
      lastActivityMs,
      staleThresholds,
    );
    const stale = staleReasons.length > 0;
    const agingMs = Math.max(0, now - parseTimestamp(ticket.updated));
    const baseId = `standalone:${sr.id}`;

    const shared = {
      projectSlug: null,
      projectTitle: null,
      ticketSlug: ticket.slug || sr.id,
      ticketTitle: ticket.title,
      status: ticket.status,
      updated: ticket.updated,
      href: `/t/${sr.id}`,
      blockedReason: ticket.blockedReason,
      stale,
      agingMs,
      assignee: ticket.assignee ?? null,
      availableTransitions,
    };

    if (segmentId) {
      const reason =
        segmentId === 'blocked' && ticket.blockedReason
          ? ticket.blockedReason
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
      const top = topStaleReason(staleReasons);
      buckets.stale.push({
        ...shared,
        id: `${baseId}:stale`,
        severity: 'low',
        reason: top?.label ?? SEGMENT_REASON.stale,
        segment: 'stale',
      });
    }

    if (!isTerminal) {
      newestPool.push({
        created: ticket.created,
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
      ticketSlug: null,
      summary: `Project status is ${record.summary.status}.`,
    });

    for (const ticket of activeTickets(record.tickets)) {
      activity.push({
        id: `ticket:${record.summary.slug}:${ticket.slug}`,
        type: 'ticket',
        title: ticket.title,
        updated: ticket.updated,
        href: `/t/${ticket.id}`,
        projectSlug: record.summary.slug,
        projectTitle: record.summary.title,
        ticketSlug: ticket.slug,
        summary: `Ticket is ${ticket.status} with ${ticket.priority} priority.`,
      });
    }
  }

  for (const sr of standaloneRecords) {
    const ticket = sr.record;
    activity.push({
      id: `standalone-ticket:${sr.id}`,
      type: 'ticket',
      title: ticket.title,
      updated: ticket.updated,
      href: `/t/${sr.id}`,
      projectSlug: null,
      projectTitle: null,
      ticketSlug: ticket.slug || sr.id,
      summary: `Standalone ticket is ${ticket.status} with ${ticket.priority} priority.`,
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

function countPendingAnswers(body: string): number {
  const matches = body.match(/^\*\*A:\*\*\s+pending\s*$/gim);
  return matches ? matches.length : 0;
}

async function countOpenQuestions(
  projectPath: string,
  ticketSlug: string,
): Promise<number> {
  const commentsPath = resolve(
    projectPath,
    'tickets',
    ticketSlug,
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
    case 'handoff':
      return ticketSlug
        ? resolve(projectsDir, projectSlug, 'tickets', ticketSlug, 'handoff.md')
        : null;
    case 'decision-record':
      return ticketSlug
        ? resolve(projectsDir, projectSlug, 'tickets', ticketSlug, 'decision-record.md')
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
    case 'ticket':
      return `Edit Ticket: ${ticketSlug || 'ticket'}`;
    case 'plan':
      return `Edit Plan: ${ticketSlug || 'ticket'}`;
    case 'scratchpad':
      return `Edit Scratchpad: ${ticketSlug || 'ticket'}`;
    case 'handoff':
      return `Append Handoff: ${ticketSlug || 'ticket'}`;
    case 'decision-record':
      return `Append Decision: ${ticketSlug || 'ticket'}`;
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
