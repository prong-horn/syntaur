import { Router } from 'express';
import { resolve } from 'node:path';
import {
  listAllSessions,
  listSessionsPage,
  listSessionSortKeys,
  listSessionsForIds,
  listAllSessionIds,
  type SessionPageQuery,
  type SessionSortKey,
  type WorkspaceScope,
  listProjectSessions,
  appendSession,
  updateSessionStatus,
  SessionResurrectionError,
  deleteSessions,
  reconcileActiveSessions,
  getSessionById,
} from './agent-sessions.js';
import { fileExists } from '../utils/fs.js';
import { isSafeSessionId } from '../utils/session-id.js';
import { resolveAssignmentBySlug } from '../utils/assignment-resolver.js';
import { assignmentsDir as assignmentsDirFn } from '../utils/paths.js';
import { derivePathFromTranscript } from '../utils/transcript.js';
import { enrichSessions } from './session-liveness.js';
import { getAgents, readConfig } from '../utils/config.js';
import { captureProcessStartedAt } from '../utils/process-info.js';
import { captureHeadSha } from '../utils/git-worktree.js';
import { isExistingDir } from '../launch/cwd.js';
import { recreateForTarget, recreateOutcomeToHttp } from './worktree-recreate.js';
import { listSessionUsage, type SessionUsage } from '../db/usage-db.js';
import {
  DEFAULT_SESSION_SORT,
  isSessionSort,
  requiresMergeSort,
  type SessionSort,
} from '../utils/session-sort.js';
import { resolveShortForSession, type SessionResolution } from './daemon-join.js';
import type { PtyTokenRegistry } from './pty-token.js';
import type {
  AgentSessionDetail,
  AgentSessionStatus,
  AgentSessionWithLiveness,
  DaemonSessionState,
  WsMessage,
} from './types.js';

/** Phase D browser-attach seams: the shared token registry + the daemon join
 * (injectable so the detail/mint routes are unit-testable without a daemon). */
export interface AgentSessionsRouterDeps {
  ptyTokens?: PtyTokenRegistry;
  resolveShort?: (sessionId: string) => Promise<SessionResolution | null>;
  /**
   * Workspace membership lookup, injected rather than imported: it lives in
   * `api.ts`, which already imports THIS module to mount the router, so a direct
   * import would close a cycle. Defaults to a no-member scope, which makes an
   * un-wired router behave as if every workspace were empty rather than
   * silently ignoring the filter.
   */
  resolveWorkspaceMembers?: (
    projectsDir: string,
    assignmentsDir: string | undefined,
    workspace: string,
  ) => Promise<{ projectSlugs: string[]; standaloneAssignmentIds: string[] }>;
}

const TERMINAL_DAEMON_STATES: ReadonlySet<DaemonSessionState> = new Set(['done', 'failed', 'stopped']);

/**
 * Attach per-session spend to enriched session rows, and — only when the caller
 * opts in — append synthetic rows for session ids that exist in `usage_events`
 * but were never tracked.
 *
 * The orphan rows are deliberately opt-in: every other `useAgentSessions`
 * consumer (overview rails, widgets, saved views) would otherwise start showing
 * rows that have no transcript, no liveness, and no actions. They are appended
 * AFTER liveness enrichment so they can never reach `reconcileActiveSessions`
 * or the liveness probes.
 *
 * Usage is best-effort: when the usage DB was never initialized in this server
 * context, sessions still render (without spend) rather than 500ing.
 */
function attachUsage(
  sessions: AgentSessionWithLiveness[],
  opts: { includeUsageOnly: boolean },
): AgentSessionWithLiveness[] {
  let usageBySession: Map<string, SessionUsage>;
  try {
    usageBySession = listSessionUsage();
  } catch {
    return sessions;
  }

  const summarize = (u: SessionUsage) => ({
    totalCost: u.totalCost,
    totalTokens: u.totalTokens,
    models: u.models,
  });

  const withUsage: AgentSessionWithLiveness[] = sessions.map((session) => {
    const usage = usageBySession.get(session.sessionId);
    return { ...session, usage: usage ? summarize(usage) : null };
  });
  if (!opts.includeUsageOnly) return withUsage;

  const tracked = new Set(sessions.map((s) => s.sessionId));
  const orphans: AgentSessionWithLiveness[] = [];
  for (const [sessionId, usage] of usageBySession) {
    if (tracked.has(sessionId)) continue;
    orphans.push({
      projectSlug: null,
      assignmentSlug: null,
      agent: usage.tool || 'unknown',
      sessionId,
      started: usage.firstEventTs ?? '',
      ended: null,
      status: 'stopped',
      path: usage.cwd ?? '',
      description: null,
      transcriptPath: null,
      pid: null,
      activity: null,
      usage: summarize(usage),
      usageOnly: true,
      isLive: false,
      resumeSupported: false,
      forkSupported: false,
    });
  }
  return [...withUsage, ...orphans];
}

/**
 * Build the synthetic row for a session id that has usage events but was never
 * tracked. Extracted so `attachUsage` (full-set path) and the paged merge path
 * cannot drift apart in what an orphan row looks like.
 */
function usageOnlyRow(sessionId: string, usage: SessionUsage): AgentSessionWithLiveness {
  return {
    projectSlug: null,
    assignmentSlug: null,
    agent: usage.tool || 'unknown',
    sessionId,
    started: usage.firstEventTs ?? '',
    ended: null,
    status: 'stopped',
    path: usage.cwd ?? '',
    description: null,
    transcriptPath: null,
    pid: null,
    activity: null,
    usage: { totalCost: usage.totalCost, totalTokens: usage.totalTokens, models: usage.models },
    usageOnly: true,
    isLive: false,
    resumeSupported: false,
    forkSupported: false,
  };
}

/**
 * Apply the paged query's filters to a synthetic usage-only row.
 *
 * These rows exist only in JS, so they cannot ride the SQL WHERE clause and the
 * predicates have to be mirrored here. They carry no project, assignment,
 * description, summary or transcript, so the searchable surface is narrower than
 * a tracked session's — matching what the client saw when it searched these same
 * fields on these same rows.
 */
function orphanPassesFilters(
  sessionId: string,
  usage: SessionUsage,
  started: string,
  q: SessionPageQuery,
): boolean {
  if (q.startedFromUtc && (!started || started < q.startedFromUtc)) return false;
  if (q.startedToUtc && (!started || started > q.startedToUtc)) return false;

  // An orphan has no engagement, so it is workspace-less: claimed by
  // `_ungrouped`, excluded from every named workspace. This mirrors the old
  // client behavior, where a null projectSlug resolved to a null workspace.
  if (q.workspaceScope && !q.workspaceScope.ungrouped) return false;

  const search = q.search?.trim().toLowerCase();
  if (search) {
    // Mirror the row the client will actually see: `usageOnlyRow` labels a
    // tool-less orphan 'unknown', and the old client haystack included `agent`,
    // so a search for "unknown" has to match here too.
    const haystack = [sessionId, usage.tool || 'unknown', usage.cwd ?? ''].join(' ').toLowerCase();
    if (!haystack.includes(search)) return false;
  }
  return true;
}

/** A merge-path ranking key: a session's sortable fields, without its payload. */
interface MergeKey extends SessionSortKey {
  cost: number;
  tokens: number;
  orphan: boolean;
}

function durationMinutes(key: MergeKey, now: number): number {
  const started = Date.parse(key.started);
  const ended = key.ended ? Date.parse(key.ended) : now;
  if (Number.isNaN(started) || Number.isNaN(ended)) return 0;
  return Math.max(0, Math.floor((ended - started) / 60000));
}

/**
 * Ranking for the merge path — a faithful port of the comparator the page used
 * to run client-side (`compareSessions` in AgentSessionsPage), so that turning
 * on `includeUsageOnly` does not silently change the order.
 *
 * Every branch ends with `sessionId` so the ordering is total: without a tie
 * break, two rows with equal keys can swap between requests and a row is then
 * duplicated on one page and missing from the next.
 *
 * `now` is passed in rather than read per comparison so a live session's
 * duration cannot shift mid-sort and break the comparator's transitivity.
 */
function compareKeys(a: MergeKey, b: MergeKey, sort: SessionSort, now: number): number {
  switch (sort) {
    case 'started_asc':
      return a.started.localeCompare(b.started) || a.sessionId.localeCompare(b.sessionId);
    case 'started_desc':
      return b.started.localeCompare(a.started) || a.sessionId.localeCompare(b.sessionId);
    case 'duration_asc':
      return durationMinutes(a, now) - durationMinutes(b, now) || a.sessionId.localeCompare(b.sessionId);
    case 'duration_desc':
      return durationMinutes(b, now) - durationMinutes(a, now) || a.sessionId.localeCompare(b.sessionId);
    case 'assignment_asc':
      return (
        (a.assignmentSlug ?? '').localeCompare(b.assignmentSlug ?? '')
        || (a.projectSlug ?? '').localeCompare(b.projectSlug ?? '')
        || a.sessionId.localeCompare(b.sessionId)
      );
    case 'agent_asc':
      return (
        a.agent.localeCompare(b.agent)
        || (a.assignmentSlug ?? '').localeCompare(b.assignmentSlug ?? '')
        || a.sessionId.localeCompare(b.sessionId)
      );
    case 'spend_desc':
      return b.cost - a.cost || b.started.localeCompare(a.started) || a.sessionId.localeCompare(b.sessionId);
    case 'tokens_desc':
      return (
        b.tokens - a.tokens || b.started.localeCompare(a.started) || a.sessionId.localeCompare(b.sessionId)
      );
  }
}

/**
 * Ceiling on `pageSize`, following the `api-search.ts` idiom. There is no
 * DEFAULT_PAGE_SIZE here on purpose: the PRESENCE of `pageSize` is what opts a
 * caller into paging, so a missing or malformed value must fall through to the
 * unpaged path rather than silently apply a default. The client owns the
 * default (AgentSessionsPage.DEFAULT_PAGE_SIZE).
 */
const MAX_PAGE_SIZE = 500;

/**
 * Parse a positive integer query param, ignoring anything malformed rather than
 * erroring — same contract as `api-inbox.ts`'s `limit`.
 */
function positiveIntParam(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function nonNegativeIntParam(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Convert an inclusive local calendar date (YYYY-MM-DD) plus the caller's UTC
 * offset into the precise UTC instant bounds of that local day.
 *
 * This preserves the behavior paging replaced: the client used to compare each
 * session's `started` against a LOCAL calendar date (`toLocalDateKey`, which
 * reads getFullYear/getMonth/getDate). Comparing a bare YYYY-MM-DD against UTC
 * ISO timestamps server-side would shift every boundary by the offset, so a
 * session started at 6pm local on the `to` date could drop out of its own range.
 *
 * `offsetMinutes` is `Date.prototype.getTimezoneOffset()` — minutes to ADD to
 * local time to reach UTC (positive west of Greenwich). Absent or malformed
 * offsets fall back to 0 (UTC), which is the pre-existing behavior for a client
 * that does not send one.
 */
export function localDateToUtcBounds(
  date: string,
  offsetMinutes: number,
  edge: 'start' | 'end',
): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const base = edge === 'start' ? `${date}T00:00:00.000Z` : `${date}T23:59:59.999Z`;
  const ms = Date.parse(base);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms + offsetMinutes * 60_000).toISOString();
}

export function createAgentSessionsRouter(
  projectsDir: string,
  broadcast?: (msg: WsMessage) => void,
  assignmentsDir?: string,
  deps: AgentSessionsRouterDeps = {},
): Router {
  const router = Router();
  const resolveShort = deps.resolveShort ?? ((sessionId: string) => resolveShortForSession(sessionId));
  const resolveWorkspaceMembers =
    deps.resolveWorkspaceMembers
    ?? (async () => ({ projectSlugs: [], standaloneAssignmentIds: [] }));

  /**
   * One page of the session list.
   *
   * Two paths, because the row set is not always one table:
   *
   *  - **SQL paging** when `includeUsageOnly` is off and the sort is a column
   *    sort. LIMIT/OFFSET straight against `sessions`; nothing beyond the page
   *    is ever materialized.
   *  - **Merge paging** when usage-only orphan rows are in play (the row set is
   *    a union of `sessions` and synthetic rows built from the usage aggregate)
   *    or when the sort is spend/tokens (cost is computed in JS, so there is no
   *    column to ORDER BY). This ranks lightweight keys for the whole filtered
   *    union, slices, and only then hydrates.
   *
   * The merge path still avoids the original problem: it materializes ids and
   * sort keys, not full rows, and liveness enrichment plus usage attachment run
   * on the page alone.
   */
  async function pageSessions(
    q: SessionPageQuery,
    opts: { includeUsageOnly: boolean; agents: ReturnType<typeof getAgents> },
  ): Promise<{ sessions: AgentSessionWithLiveness[]; totalCount: number }> {
    // Must agree with listSessionsPage's own guard, or a sort it refuses to
    // order in SQL would be routed to it and come back empty.
    const mergeSort = requiresMergeSort(q.sort);

    if (!opts.includeUsageOnly && !mergeSort) {
      const { sessions, totalCount } = listSessionsPage(q);
      return {
        sessions: attachUsage(enrichSessions(sessions, opts.agents), { includeUsageOnly: false }),
        totalCount,
      };
    }

    // Ranking keys for every tracked session that passes the filters.
    const trackedKeys = listSessionSortKeys(q);

    // Usage aggregate: needed for orphan rows and for the spend/tokens ordering.
    // Best-effort, exactly like attachUsage — a missing usage DB must not 500 a
    // plain session listing.
    let usageBySession = new Map<string, SessionUsage>();
    try {
      usageBySession = listSessionUsage();
    } catch {
      usageBySession = new Map();
    }

    const keys: MergeKey[] = trackedKeys.map((k) => {
      const u = usageBySession.get(k.sessionId);
      return {
        ...k,
        // Zero-fill: a tracked session with no usage events participates in the
        // spend/token orderings as a zero-cost row, exactly as the old
        // client-side comparator did (`right.usage?.totalCost ?? 0`). Ranking
        // only over the usage map would silently drop these rows.
        cost: u?.totalCost ?? 0,
        tokens: u?.totalTokens ?? 0,
        orphan: false,
      };
    });

    if (opts.includeUsageOnly) {
      // UNFILTERED on purpose. "Orphan" means "a usage id with no sessions row",
      // which is a question about existence, not about the current filters.
      // Deriving it from `trackedKeys` (the post-filter list) made every session
      // the filter excluded look like an orphan, so it came back as a synthetic
      // usageOnly row with a null project and inflated totalCount — e.g. a
      // session in a named workspace reappearing under _ungrouped.
      const tracked = listAllSessionIds();
      for (const [sessionId, usage] of usageBySession) {
        if (tracked.has(sessionId)) continue;
        const started = usage.firstEventTs ?? '';
        if (!orphanPassesFilters(sessionId, usage, started, q)) continue;
        keys.push({
          sessionId,
          started,
          ended: null,
          assignmentSlug: null,
          projectSlug: null,
          agent: usage.tool || 'unknown',
          cost: usage.totalCost,
          tokens: usage.totalTokens,
          orphan: true,
        });
      }
    }

    // One `now` for the whole sort: a live session's duration must not advance
    // between comparisons, or the comparator stops being transitive.
    const now = Date.now();
    keys.sort((a, b) => compareKeys(a, b, q.sort, now));

    const totalCount = keys.length;
    const slice = keys.slice(q.page * q.pageSize, q.page * q.pageSize + q.pageSize);

    const trackedIds = slice.filter((k) => !k.orphan).map((k) => k.sessionId);
    const hydrated = new Map(
      listSessionsForIds(trackedIds).map((s) => [s.sessionId, s]),
    );
    // Enrich only the page's real sessions; synthetic rows never reach the
    // liveness probes (they have no pid and no transcript).
    const enriched = new Map(
      enrichSessions([...hydrated.values()], opts.agents).map((s) => [s.sessionId, s]),
    );

    const out: AgentSessionWithLiveness[] = [];
    for (const key of slice) {
      if (key.orphan) {
        const usage = usageBySession.get(key.sessionId);
        if (usage) out.push(usageOnlyRow(key.sessionId, usage));
        continue;
      }
      const row = enriched.get(key.sessionId);
      if (!row) continue; // deleted between the key scan and hydration
      const usage = usageBySession.get(key.sessionId);
      out.push({
        ...row,
        usage: usage
          ? { totalCost: usage.totalCost, totalTokens: usage.totalTokens, models: usage.models }
          : null,
      });
    }
    return { sessions: out, totalCount };
  }

  // GET /api/agent-sessions/by-id/:sessionId — one session enriched with the
  // daemon join (short id, attachability, live state, or the settled final
  // screen). Registered before /:projectSlug so `by-id` matches literally.
  router.get('/by-id/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!isSafeSessionId(sessionId)) {
        res.status(400).json({ error: 'Invalid session id' });
        return;
      }
      const base = getSessionById(sessionId);
      if (!base) {
        res.status(404).json({ error: `Session "${sessionId}" not found` });
        return;
      }
      const agents = getAgents(await readConfig());
      const [enriched] = enrichSessions([base], agents);
      const resolution = await resolveShort(sessionId);
      const detail: AgentSessionDetail = {
        ...enriched,
        syntaurdShortId: resolution?.short ?? null,
        attachable: false,
      };
      if (resolution?.live) {
        detail.attachable = true;
        detail.syntaurdState = resolution.state;
        if (resolution.needs != null) detail.needs = resolution.needs;
      } else if (resolution) {
        const st = resolution.jobState?.state ?? resolution.state;
        if (st && TERMINAL_DAEMON_STATES.has(st) && resolution.jobState) {
          detail.settled = {
            lastScreen: resolution.jobState.lastScreen ?? null,
            cols: resolution.jobState.cols,
            rows: resolution.jobState.rows,
            exitCode: resolution.jobState.exitCode ?? null,
            exitSignal: resolution.jobState.exitSignal ?? null,
            state: st,
          };
        } else {
          // daemon-hosted but not reachable and not terminal → retryable
          detail.daemonUnavailable = true;
        }
      }
      res.json({ session: detail, generatedAt: new Date().toISOString() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load session' });
    }
  });

  // POST /api/agent-sessions/by-id/:sessionId/pty-token — mint a single-use,
  // short-lived token for the pty WebSocket upgrade. Only for a live session.
  router.post('/by-id/:sessionId/pty-token', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!isSafeSessionId(sessionId)) {
        res.status(400).json({ error: 'Invalid session id' });
        return;
      }
      if (!deps.ptyTokens) {
        res.status(503).json({ error: 'Browser attach is not enabled' });
        return;
      }
      const resolution = await resolveShort(sessionId);
      if (!resolution) {
        res.status(404).json({ error: `Session "${sessionId}" not found` });
        return;
      }
      if (!resolution.live) {
        res.status(409).json({ error: 'Session is not live and cannot be attached' });
        return;
      }
      res.json(deps.ptyTokens.mint(resolution.short));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to mint token' });
    }
  });

  // GET /api/agent-sessions — sessions across all projects.
  //
  // Paging is OPT-IN on the presence of `pageSize`: without it this returns the
  // full set exactly as it always has, so existing consumers are unaffected.
  router.get('/', async (req, res) => {
    try {
      await reconcileActiveSessions(projectsDir, assignmentsDir);
      const agents = getAgents(await readConfig());
      const includeUsageOnly = req.query.includeUsageOnly === '1';

      const pageSizeRaw = positiveIntParam(req.query.pageSize);
      if (pageSizeRaw === undefined) {
        const sessions = await listAllSessions(projectsDir);
        res.json({
          sessions: attachUsage(enrichSessions(sessions, agents), { includeUsageOnly }),
          generatedAt: new Date().toISOString(),
        });
        return;
      }

      const pageSize = Math.min(pageSizeRaw, MAX_PAGE_SIZE);
      const page = nonNegativeIntParam(req.query.page) ?? 0;
      const sortRaw = req.query.sort;
      const sort = isSessionSort(sortRaw) ? sortRaw : DEFAULT_SESSION_SORT;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;

      // getTimezoneOffset() is always an integer number of minutes; a fractional
      // or non-numeric value is malformed input, not a real zone.
      const tzOffset = Number(req.query.tzOffset);
      const offsetMinutes = Number.isInteger(tzOffset) ? tzOffset : 0;
      const startedFromUtc =
        typeof req.query.startedFrom === 'string'
          ? localDateToUtcBounds(req.query.startedFrom, offsetMinutes, 'start')
          : undefined;
      const startedToUtc =
        typeof req.query.startedTo === 'string'
          ? localDateToUtcBounds(req.query.startedTo, offsetMinutes, 'end')
          : undefined;

      // Workspace membership is resolved from disk (project frontmatter +
      // standalone records), once per request — never per row.
      let workspaceScope: WorkspaceScope | null = null;
      const workspace = typeof req.query.workspace === 'string' ? req.query.workspace : undefined;
      if (workspace) {
        const members = await resolveWorkspaceMembers(projectsDir, assignmentsDir, workspace);
        workspaceScope = {
          projectSlugs: members.projectSlugs,
          standaloneAssignmentIds: members.standaloneAssignmentIds,
          ungrouped: workspace === '_ungrouped',
        };
      }

      const query = { page, pageSize, search, startedFromUtc, startedToUtc, workspaceScope, sort };
      const result = await pageSessions(query, { includeUsageOnly, agents });

      res.json({
        sessions: result.sessions,
        generatedAt: new Date().toISOString(),
        page: {
          page,
          pageSize,
          totalCount: result.totalCount,
          pageCount: Math.max(1, Math.ceil(result.totalCount / pageSize)),
        },
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list sessions' });
    }
  });

  // GET /api/agent-sessions/:projectSlug — sessions for one project
  router.get('/:projectSlug', async (req, res) => {
    try {
      const { projectSlug } = req.params;
      const assignment = req.query.assignment as string | undefined;
      const projectDir = resolve(projectsDir, projectSlug);
      if (!(await fileExists(projectDir))) {
        res.status(404).json({ error: `Project "${projectSlug}" not found` });
        return;
      }
      await reconcileActiveSessions(projectsDir, assignmentsDir);
      const sessions = await listProjectSessions(projectsDir, projectSlug, assignment);
      const agents = getAgents(await readConfig());
      res.json({
        // Usage attached, but never orphan rows: a usage-only session has no
        // project binding, so it cannot belong to a project-scoped listing.
        sessions: attachUsage(enrichSessions(sessions, agents), { includeUsageOnly: false }),
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list sessions' });
    }
  });

  // POST /api/agent-sessions — register a new session
  router.post('/', async (req, res) => {
    try {
      const { projectSlug, assignmentSlug, agent, sessionId, path, description, transcriptPath, pid: rawPid } =
        req.body;

      if (!agent) {
        res.status(400).json({ error: 'agent is required' });
        return;
      }

      if (!sessionId) {
        res.status(400).json({
          error:
            'sessionId is required. Pass the real agent-generated session id — do not synthesize one.',
        });
        return;
      }

      // L gate (1): a malformed/arbitrary session id must not open or
      // mis-attribute an engagement. `assertMayMutate` is a no-op here (an
      // HTTP-supplied id resolves to EXPLICIT provenance), so the real guard is
      // format validation + assignment-existence below — not provenance.
      if (!isSafeSessionId(sessionId)) {
        res.status(400).json({
          error: 'sessionId is malformed. Pass the real agent-generated session id.',
        });
        return;
      }

      if (projectSlug) {
        const projectDir = resolve(projectsDir, projectSlug);
        if (!(await fileExists(projectDir))) {
          res.status(404).json({ error: `Project "${projectSlug}" not found` });
          return;
        }
      }

      // L gate (2) + M1: when the POST BINDS to an assignment, the assignment
      // must exist (else this opens/mis-attributes a window for a phantom
      // assignment). Resolve once: `.exists` gates the bind, `.id` is stored as
      // the engagement's `assignment_id` so a later stage assertion won't split
      // the interval to repair the id. A registration-only POST (no
      // `assignmentSlug`) is NOT gated — it registers the bare session.
      let assignmentId: string | null = null;
      if (assignmentSlug) {
        const resolvedAssignment = await resolveAssignmentBySlug(
          projectsDir,
          assignmentsDir ?? assignmentsDirFn(),
          projectSlug || null,
          assignmentSlug,
        );
        if (!resolvedAssignment.exists) {
          res.status(404).json({ error: `Assignment "${assignmentSlug}" not found` });
          return;
        }
        assignmentId = resolvedAssignment.id;
      }

      // Prefer the launch cwd recorded inside the transcript over whatever
      // path the caller posted — the transcript is what determines where
      // Claude Code files the conversation, and the only directory from
      // which `claude --resume <id>` will find it.
      const derivedPath = await derivePathFromTranscript(transcriptPath);
      const recordedPath = derivedPath ?? path ?? '';

      const pid =
        typeof rawPid === 'number' && Number.isFinite(rawPid) && rawPid > 0
          ? rawPid
          : null;
      const pidStartedAt = pid !== null ? captureProcessStartedAt(pid) : null;

      // Best-effort capture of the worktree's HEAD sha so a later recreate of a
      // deleted worktree can be exact. Never blocks registration on git.
      const originalHeadSha = isExistingDir(recordedPath)
        ? await captureHeadSha(recordedPath)
        : null;

      const session = {
        // L: a POST with no assignmentSlug is registration-only (unbound) — do
        // NOT open a project-bound engagement for an arbitrary session. Binding
        // requires a validated assignment selector (existence-checked above).
        projectSlug: assignmentSlug ? projectSlug || null : null,
        assignmentSlug: assignmentSlug || null,
        assignmentId,
        agent,
        sessionId,
        started: new Date().toISOString(),
        status: 'active' as AgentSessionStatus,
        path: recordedPath,
        description: description || null,
        transcriptPath: transcriptPath || null,
        pid,
        pidStartedAt,
        originalHeadSha,
      };

      await appendSession('', session);
      broadcast?.({ type: 'agent-sessions-updated', timestamp: new Date().toISOString() });
      res.status(201).json({ sessionId });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Registration failed' });
    }
  });

  // POST /api/agent-sessions/:sessionId/worktree/recreate — rebuild a deleted
  // worktree at the session's exact recorded path so `claude --resume <id>` can
  // find the transcript again. Server-authoritative (path/repo/branch derived
  // from the session row + its linked assignment, never the request body).
  router.post('/:sessionId/worktree/recreate', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const outcome = await recreateForTarget(
        { projectsDir, assignmentsDir: assignmentsDir ?? '' },
        { kind: 'session', id: sessionId },
      );
      const { httpStatus, body } = recreateOutcomeToHttp(outcome);
      res.status(httpStatus).json(body);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to recreate worktree',
      });
    }
  });

  // PATCH /api/agent-sessions/:sessionId — terminal-only status update.
  // Used by the Mark-stopped affordance on session rows; the
  // /:sessionId/status route below remains available for full status updates
  // (non-terminal allowed) used by other internal flows. Express precedence
  // matches the more specific /:sessionId/status route first.
  router.patch('/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const status = (req.body ?? {}).status;
      if (status !== 'stopped' && status !== 'completed') {
        res.status(400).json({
          error: 'status must be one of: stopped, completed',
        });
        return;
      }
      if (!getSessionById(sessionId)) {
        res.status(404).json({ error: `Session "${sessionId}" not found` });
        return;
      }
      const updated = await updateSessionStatus('', sessionId, status);
      if (!updated) {
        res.status(404).json({ error: `Session "${sessionId}" not found` });
        return;
      }
      broadcast?.({ type: 'agent-sessions-updated', timestamp: new Date().toISOString() });
      res.json({ updated: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Update failed' });
    }
  });

  // PATCH /api/agent-sessions/:sessionId/status — update session status
  router.patch('/:sessionId/status', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { status } = req.body;

      if (!status) {
        res.status(400).json({ error: 'status is required' });
        return;
      }

      if (!['active', 'completed', 'stopped'].includes(status)) {
        res.status(400).json({ error: 'status must be active, completed, or stopped' });
        return;
      }

      const updated = await updateSessionStatus('', sessionId, status);
      if (!updated) {
        res.status(404).json({ error: `Session "${sessionId}" not found` });
        return;
      }

      broadcast?.({ type: 'agent-sessions-updated', timestamp: new Date().toISOString() });
      res.json({ updated: true });
    } catch (error) {
      // A completed session is final — reviving it to active is refused, not a 500.
      if (error instanceof SessionResurrectionError) {
        res.status(409).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Update failed' });
    }
  });

  // DELETE /api/agent-sessions — delete one or more sessions
  router.delete('/', async (req, res) => {
    try {
      const { sessionIds } = req.body;

      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        res.status(400).json({ error: 'sessionIds must be a non-empty array' });
        return;
      }

      const deleted = await deleteSessions(sessionIds);
      broadcast?.({ type: 'agent-sessions-updated', timestamp: new Date().toISOString() });
      res.json({ deleted });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Delete failed' });
    }
  });

  return router;
}
