import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { getSessionDb } from './session-db.js';
import {
  ensureOpenEngagement,
  closeEngagementById,
  getOpenEngagement,
  getLatestEngagement,
  hasAnyEngagement,
  insertClosedEngagement,
} from '../db/engagement-db.js';
import { getCumulativeTokenSource, type TokenSnapshot } from '../db/engagement-tokens.js';
import { requiresMergeSort, type SessionSort, type SqlSort } from '../utils/session-sort.js';
import {
  DEFAULT_SESSION_ATTRIBUTION,
  includesTrackedRows,
  type SessionAttribution,
} from '../utils/session-attribution.js';
import { sanitizeSessionPath } from '../utils/transcript.js';
import type {
  AgentSession,
  AgentSessionStatus,
  ActivityState,
  DescriptionSource,
  SessionHostedBy,
} from './types.js';

interface SessionRow {
  session_id: string;
  // project_slug / assignment_slug are NOT columns on `sessions` (v6 moved the
  // scalar binding onto `engagement`). They are PROJECTED here from the session's
  // chosen engagement via SESSION_SELECT_WITH_BINDING below.
  project_slug: string | null;
  assignment_slug: string | null;
  agent: string;
  started: string;
  ended: string | null;
  status: string;
  path: string | null;
  description: string | null;
  transcript_path: string | null;
  pid: number | null;
  pid_started_at: string | null;
  original_head_sha: string | null;
  activity: string | null;
  hosted_by: string | null;
  summary: string | null;
  summarized_at: string | null;
  description_source: string | null;
  updated_at: string | null;
}

// Project the session's binding (project/assignment slug) from its single
// CHOSEN engagement — the OPEN one, else the LATEST by started_at — via a
// correlated subquery (NOT a plain JOIN, which would duplicate rows per
// historical engagement). See decision-record.md Decision 8. Every
// `rowToSession` reader routes through this so `getSessionById` /
// `listAllSessions` keep populated bindings for `recreate-target` / `launch`.
const SESSION_SELECT_WITH_BINDING = `
SELECT s.*,
       e.project_slug    AS project_slug,
       e.assignment_slug AS assignment_slug,
       e.assignment_id   AS assignment_id
  FROM sessions s
  LEFT JOIN engagement e ON e.id = (
    SELECT e2.id FROM engagement e2
     WHERE e2.session_id = s.session_id
     ORDER BY (e2.ended_at IS NULL) DESC, e2.started_at DESC, e2.id DESC
     LIMIT 1
  )`;

function rowToSession(row: SessionRow): AgentSession {
  return {
    sessionId: row.session_id,
    projectSlug: row.project_slug ?? null,
    assignmentSlug: row.assignment_slug ?? null,
    agent: row.agent,
    started: row.started,
    ended: row.ended ?? null,
    status: row.status as AgentSessionStatus,
    path: row.path ?? '',
    description: row.description ?? null,
    transcriptPath: row.transcript_path ?? null,
    pid: row.pid ?? null,
    pidStartedAt: row.pid_started_at ?? null,
    originalHeadSha: row.original_head_sha ?? null,
    activity: (row.activity as ActivityState | null) ?? null,
    hostedBy: (row.hosted_by as SessionHostedBy | null) ?? null,
    summary: row.summary ?? null,
    summarizedAt: row.summarized_at ?? null,
    descriptionSource: (row.description_source as DescriptionSource | null) ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Query sessions for a specific project.
 */
export async function parseSessionsIndex(
  _projectDir: string,
  projectSlug: string,
): Promise<AgentSession[]> {
  const db = getSessionDb();
  const rows = db
    .prepare(`${SESSION_SELECT_WITH_BINDING} WHERE e.project_slug = ? ORDER BY s.started DESC`)
    .all(projectSlug) as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * Ensure the session has an OPEN engagement matching its binding, if it doesn't
 * already. Binding comes from `freshBinding` (a payload binding) when present,
 * else is recovered from the session's latest engagement — the revive case,
 * where a stopped session comes back to life with no fresh binding and must keep
 * its prior attribution. A from-history reopen starts a NEW interval at `now`
 * (the revive instant), not the original session start. No-op when an open
 * engagement already exists or no binding can be determined. Must run inside the
 * caller's transaction.
 */
function reopenEngagementIfMissing(
  sessionId: string,
  freshBinding: {
    assignmentId?: string | null;
    projectSlug: string | null;
    assignmentSlug: string | null;
  } | null,
  freshStartedAt: string,
  tokensAtOpen?: TokenSnapshot | null,
): void {
  if (getOpenEngagement(sessionId)) return;
  if (freshBinding && (freshBinding.projectSlug || freshBinding.assignmentSlug)) {
    ensureOpenEngagement({
      sessionId,
      assignmentId: freshBinding.assignmentId ?? null,
      projectSlug: freshBinding.projectSlug,
      assignmentSlug: freshBinding.assignmentSlug,
      stage: 'implement',
      startedAt: freshStartedAt,
      tokensAtOpen: tokensAtOpen ?? null,
    });
    return;
  }
  const latest = getLatestEngagement(sessionId);
  if (latest && (latest.project_slug || latest.assignment_slug)) {
    ensureOpenEngagement({
      sessionId,
      assignmentId: latest.assignment_id,
      projectSlug: latest.project_slug,
      assignmentSlug: latest.assignment_slug,
      stage: 'implement',
      startedAt: new Date().toISOString(),
      tokensAtOpen: tokensAtOpen ?? null,
    });
  }
}

/**
 * Upsert a session keyed on `session_id`.
 *
 * On conflict, non-null fields in the new payload fill in missing values on the
 * existing row (COALESCE). `started` / `created_at` from the first insert are
 * preserved. A session already in a terminal state (`completed` / `stopped`)
 * is NOT revived by re-registration — status only moves forward — with one
 * narrow exception: `opts.reviveStopped` lets an `active` payload flip a
 * `stopped` row back to active. Callers may only pass it on live-process
 * evidence (the scanner seeing a process hold the transcript open).
 * `completed` always sticks.
 *
 * Makes registration idempotent across SessionStart hooks, `/track-session`,
 * and grab-assignment all touching the same real session ID.
 */
export async function appendSession(
  _projectDir: string,
  session: AgentSession,
  opts?: { reviveStopped?: boolean },
): Promise<void> {
  const db = getSessionDb();

  // H2: capture the open-baseline token snapshot BEFORE the synchronous
  // transaction (better-sqlite3 txn callbacks can't await — Decision 2/11). It is
  // best-effort and point-in-time only (a cheap `usage_events` SELECT; never forces
  // a collector subprocess), so a failure never blocks registration. It is only
  // *used* if `reopenEngagementIfMissing` actually opens an engagement below.
  let openSnapshot: TokenSnapshot | null = null;
  try {
    openSnapshot = await getCumulativeTokenSource()(session.sessionId);
  } catch {
    openSnapshot = null;
  }

  // The upsert, the persisted-status read, and the engagement-open run in ONE
  // IMMEDIATE transaction so no concurrent writer (a SessionEnd hook / scanner
  // marking the row terminal + closing its engagement) can interleave between
  // the status read and the open — which would otherwise leak an open engagement
  // onto a now-terminal session (codex round-2 TOCTOU).
  const upsert = db.prepare(`
    INSERT INTO sessions (session_id, agent, started, status, path, description, transcript_path, pid, pid_started_at, original_head_sha, hosted_by, description_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      agent             = excluded.agent,
      status            = CASE
                            WHEN status = 'completed' THEN status
                            WHEN status = 'stopped' AND NOT (? AND excluded.status = 'active') THEN status
                            ELSE excluded.status
                          END,
      ended             = CASE
                            WHEN status = 'stopped' AND ? AND excluded.status = 'active' THEN NULL
                            ELSE ended
                          END,
      path              = COALESCE(NULLIF(excluded.path, ''),              path),
      description       = COALESCE(NULLIF(excluded.description, ''),       description),
      -- Every caller of appendSession is human/caller-driven (POST body,
      -- track-session, hooks), so a non-empty incoming description — i.e. one
      -- that actually wins the COALESCE above — stamps 'human' and becomes
      -- off-limits to the summarizer.
      description_source = CASE
                            WHEN NULLIF(excluded.description, '') IS NOT NULL THEN 'human'
                            ELSE description_source
                          END,
      transcript_path   = COALESCE(NULLIF(excluded.transcript_path, ''),   transcript_path),
      pid               = COALESCE(excluded.pid,                           pid),
      pid_started_at    = COALESCE(NULLIF(excluded.pid_started_at, ''),    pid_started_at),
      original_head_sha = COALESCE(NULLIF(original_head_sha, ''), NULLIF(excluded.original_head_sha, '')),
      -- Launch-time provenance: write-if-null, like original_head_sha above.
      -- The value is established by whoever launched the session; a later
      -- upsert (a hook re-registering, a stale marker in an inherited env)
      -- may FILL it but must never rewrite it.
      hosted_by         = COALESCE(NULLIF(hosted_by, ''), NULLIF(excluded.hosted_by, '')),
      updated_at        = datetime('now')
  `);

  const apply = db.transaction(() => {
    // Prior status, read BEFORE the upsert: `reviveStopped` is passed by the
    // scanner for ANY live session (heldOpen/agentViewLive), including ones
    // already active, so `persisted.status === 'active'` alone does NOT imply a
    // revive. Only a genuine stopped→active transition may invalidate a claim.
    const priorStatus = (
      db.prepare('SELECT status FROM sessions WHERE session_id = ?').get(session.sessionId) as
        | { status?: string }
        | undefined
    )?.status;

    upsert.run(
      session.sessionId,
      session.agent,
      session.started,
      session.status,
      // Single sanitization chokepoint for `sessions.path`: every writer
      // (scanner, SessionStart hook, track-session, API POST, launch) funnels
      // through appendSession, so rejecting a degenerate cwd here covers them
      // all — including any future caller. `''` is a non-clobbering no-op on
      // upsert thanks to the COALESCE(NULLIF(...)) above.
      sanitizeSessionPath(session.path) ?? '',
      session.description ?? null,
      session.transcriptPath ?? null,
      session.pid ?? null,
      session.pidStartedAt ?? null,
      session.originalHeadSha ?? null,
      session.hostedBy ?? null,
      // Insert-path provenance; the ON CONFLICT branch stamps it on upsert.
      session.description && session.description.length > 0 ? 'human' : null,
      opts?.reviveStopped ? 1 : 0, // status CASE: revive guard
      opts?.reviveStopped ? 1 : 0, // ended CASE: clear stale ended on revive
    );

    // Reconcile the engagement edge against the PERSISTED status (not the
    // incoming payload — re-registering a terminal row as `active` does NOT
    // revive it; the upsert preserves terminal status above). See Decision 1.
    const persisted = db
      .prepare('SELECT status, ended FROM sessions WHERE session_id = ?')
      .get(session.sessionId) as { status: string; ended: string | null } | undefined;
    const freshBinding = {
      assignmentId: session.assignmentId ?? null,
      projectSlug: session.projectSlug ?? null,
      assignmentSlug: session.assignmentSlug ?? null,
    };
    if (persisted?.status === 'active') {
      // Genuine stopped→active revive (NOT an already-active scanner
      // re-registration): drop any in-flight summarize claim AND clear the
      // stored summary. The session will do more work before ending again, so
      // the pre-resume summary is stale; clearing it re-qualifies the row for
      // the `summary IS NULL` sweep once it re-stops. Same transaction as the
      // flip. (The auto description refreshes on the next summary; a human
      // description is preserved by description_source.)
      if (opts?.reviveStopped && priorStatus === 'stopped') {
        db.prepare('DELETE FROM summarize_state WHERE session_id = ?').run(session.sessionId);
        db.prepare(
          'UPDATE sessions SET summary = NULL, summarized_at = NULL WHERE session_id = ?',
        ).run(session.sessionId);
      }
      // Live session: ensure an open engagement (fresh binding, else recover the
      // prior binding on a stopped->active revive that arrived with no binding).
      // H2: thread the pre-captured open snapshot into the opened interval.
      reopenEngagementIfMissing(
        session.sessionId,
        freshBinding,
        session.started ?? new Date().toISOString(),
        openSnapshot,
      );
    } else if (
      persisted &&
      (freshBinding.projectSlug || freshBinding.assignmentSlug) &&
      !hasAnyEngagement(session.sessionId)
    ) {
      // First-seen terminal session (e.g. the scanner discovering a stale
      // stopped transcript) with a binding: preserve it as a CLOSED interval so
      // historical attribution survives — without occupying the one-open slot.
      insertClosedEngagement({
        sessionId: session.sessionId,
        // assignmentId was being dropped here while the open path
        // (reopenEngagementIfMissing) carried it, so a session first seen in a
        // terminal state lost its standalone-assignment binding entirely. That
        // is the only link a standalone session has to a workspace, so those
        // rows could never match a named-workspace filter.
        assignmentId: freshBinding.assignmentId,
        projectSlug: freshBinding.projectSlug,
        assignmentSlug: freshBinding.assignmentSlug,
        startedAt: session.started ?? new Date().toISOString(),
        endedAt: persisted.ended ?? session.started ?? new Date().toISOString(),
        closeReason: persisted.status === 'completed' ? 'completed' : 'abandoned',
      });
    }
  });
  apply.immediate();
}

/**
 * Re-key a cockpit-planted placeholder row onto the agent's REAL session id.
 *
 * The cockpit pre-inserts a row keyed by a generated UUID (carrying
 * `hosted_by`, `pid`, and an open engagement) and plants that UUID in the
 * worker's environment as `SYNTAUR_LAUNCH_ID`. When the agent later registers
 * under its OWN id, this collapses the two identities so provenance survives
 * and no duplicate row lingers.
 *
 * Two paths, both leaving ZERO `sessions`/`engagement` rows keyed to
 * `launchId`:
 *  - **migrate** (no real row yet): the placeholder simply becomes the real
 *    row; the caller's subsequent upsert converges onto it (COALESCE fill-in).
 *  - **merge** (the real row already registered): copy provenance write-if-null
 *    onto the real row, close the placeholder's open engagement, re-key its
 *    engagement history, and drop the placeholder.
 *
 * Never throws — a reconcile failure must not break session registration.
 */
export async function reconcileLaunchPlaceholder(
  launchId: string,
  realSessionId: string,
): Promise<void> {
  if (!launchId || !realSessionId || launchId === realSessionId) return;
  try {
    const db = getSessionDb();
    const now = new Date().toISOString();
    const apply = db.transaction(() => {
      const placeholder = db
        .prepare('SELECT session_id, transcript_path, original_head_sha FROM sessions WHERE session_id = ?')
        .get(launchId) as
        | { session_id: string; transcript_path: string | null; original_head_sha: string | null }
        | undefined;
      if (!placeholder) return; // normal for non-cockpit launches

      // The markers live in the WORKER's environment for the whole session, so
      // every descendant inherits them — a subagent's SessionStart hook, or a
      // `syntaur track-session --session-id <other>` run from inside the
      // session, would arrive here with a DIFFERENT real id. Without this
      // guard that re-keys the launched session's own live row onto the
      // newcomer (migrate path), silently destroying the parent's identity and
      // moving its engagement. A launch may only ever be claimed ONCE, by the
      // agent it started; these columns are the durable evidence that a real
      // registration already claimed this row (`runSessionRegister` /
      // `trackSessionCommand` both write them; a launch placeholder never
      // does), so anything after the first claim is refused.
      if (placeholder.transcript_path !== null || placeholder.original_head_sha !== null) return;

      const real = db
        .prepare('SELECT session_id FROM sessions WHERE session_id = ?')
        .get(realSessionId) as { session_id: string } | undefined;

      if (!real) {
        // Migrate: the placeholder BECOMES the real row, keeping hosted_by,
        // pid, slugs and its open engagement intact.
        db.prepare('UPDATE sessions SET session_id = ?, updated_at = ? WHERE session_id = ?').run(
          realSessionId,
          now,
          launchId,
        );
        db.prepare('UPDATE engagement SET session_id = ? WHERE session_id = ?').run(
          realSessionId,
          launchId,
        );
        return;
      }

      // Merge: the agent's hook registered before we got here. Copy provenance
      // write-if-null so an existing value is never clobbered.
      db.prepare(
        `UPDATE sessions SET
           hosted_by  = COALESCE(hosted_by,  (SELECT hosted_by FROM sessions WHERE session_id = @launch)),
           pid        = COALESCE(pid,        (SELECT pid       FROM sessions WHERE session_id = @launch)),
           updated_at = @now
         WHERE session_id = @real`,
      ).run({ launch: launchId, real: realSessionId, now });

      // Close the placeholder's open engagement BEFORE re-keying: the
      // `one_active_per_session` unique index is partial on `ended_at IS NULL`,
      // so the real row's own open engagement would collide otherwise.
      db.prepare(
        `UPDATE engagement SET ended_at = @now, close_reason = 'launch-reconcile'
          WHERE session_id = @launch AND ended_at IS NULL`,
      ).run({ launch: launchId, now });
      // Re-key the (now all closed) history: engagement.session_id has no FK
      // cascade, so skipping this would orphan rows on the deleted id.
      db.prepare('UPDATE engagement SET session_id = ? WHERE session_id = ?').run(
        realSessionId,
        launchId,
      );
      db.prepare('DELETE FROM sessions WHERE session_id = ?').run(launchId);
    });
    apply.immediate();
  } catch (err) {
    console.error(
      `launch-reconcile failed for ${launchId} → ${realSessionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Pending-launch reservations (Phase C, plan D5) ─────────────────────────
// Durable pre-dispatch records with their own lifecycle — NEVER sessions rows
// (a pre-dispatch `active` session would open an engagement and strand on a
// failed dispatch; see launch.ts's WHY-not-insert-before-dispatch comment).

export interface LaunchReservation {
  launchId: string;
  hostedBy: string;
  agent: string | null;
  cwd: string | null;
  /** Root-identity claim binding (review r1/r2 F1): the real session id
   * this launch WILL register as, when knowable pre-dispatch (Branch A
   * claude injects `--session-id <launchId>`, so it equals launchId).
   * NULL = no root identity establishable → the mode is EXCLUDED from
   * claiming ('unbound': no write, legacy evidence-guard path). */
  expectedSessionId: string | null;
  createdAt: string;
  dispatchedAt: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  canceledAt: string | null;
}

/** Reserve BEFORE dispatch. Returns false (never throws) when the write
 * failed — the caller proceeds with today's dispatch-first semantics. */
export function reserveLaunch(input: {
  launchId: string;
  hostedBy: SessionHostedBy;
  agent?: string | null;
  cwd?: string | null;
  expectedSessionId?: string | null;
}): boolean {
  try {
    const db = getSessionDb();
    // Opportunistic TTL sweep: abandoned/canceled/claimed rows are all
    // transient bookkeeping — age them out wholesale (requirement 4).
    db.prepare("DELETE FROM launch_reservations WHERE created_at < datetime('now', '-1 day')").run();
    // Upsert-revive (review r2 F3): a CANCELED reservation for the same
    // identity is resurrected as a fresh row (all lifecycle fields cleared),
    // so a same-identity retry stays claim-protected instead of falling to
    // the legacy path. A LIVE (uncanceled) conflicting row refuses the DO
    // UPDATE's WHERE → 0 changes → false → legacy (identity genuinely in use).
    const res = db.prepare(
      `INSERT INTO launch_reservations (launch_id, hosted_by, agent, cwd, expected_session_id, created_at)
       VALUES (@id, @hostedBy, @agent, @cwd, @expected, @now)
       ON CONFLICT(launch_id) DO UPDATE SET
         hosted_by = excluded.hosted_by, agent = excluded.agent, cwd = excluded.cwd,
         expected_session_id = excluded.expected_session_id, created_at = excluded.created_at,
         dispatched_at = NULL, claimed_by = NULL, claimed_at = NULL, canceled_at = NULL
       WHERE launch_reservations.canceled_at IS NOT NULL`,
    ).run({
      id: input.launchId,
      hostedBy: input.hostedBy,
      agent: input.agent ?? null,
      cwd: input.cwd ?? null,
      expected: input.expectedSessionId ?? null,
      now: new Date().toISOString(),
    });
    return res.changes === 1;
  } catch {
    return false;
  }
}

/** Stamp the moment the dispatch request was actually sent. Best-effort. */
export function markLaunchDispatched(launchId: string): void {
  try {
    getSessionDb()
      .prepare('UPDATE launch_reservations SET dispatched_at = @now WHERE launch_id = @id AND dispatched_at IS NULL')
      .run({ id: launchId, now: new Date().toISOString() });
  } catch {
    /* best-effort */
  }
}

/** Cancel on definite refusal/degrade so a retry of the same identity is
 * never blocked. A CLAIMED reservation is never canceled (claim wins). */
export function cancelLaunch(launchId: string): void {
  try {
    getSessionDb()
      .prepare(
        'UPDATE launch_reservations SET canceled_at = @now WHERE launch_id = @id AND claimed_by IS NULL AND canceled_at IS NULL',
      )
      .run({ id: launchId, now: new Date().toISOString() });
  } catch {
    /* best-effort */
  }
}

export type LaunchClaimResult = 'won' | 'lost' | 'unbound' | 'none';

/** Identity-bound claim (review r1 F1 + r2 F1).
 * BOUND (`expected_session_id` set — Branch A): only that exact id can win,
 * enforced INSIDE the CAS WHERE — an intruder can never claim first;
 * idempotent for the owner; canceled → 'lost'.
 * UNBOUND (`expected_session_id` NULL — shell-alias claude; no root-identity
 * mechanism exists): EXCLUDED from the claim protocol — writes NOTHING,
 * returns 'unbound'; callers take today's evidence-guard path unchanged
 * (the hook-race residual stays open for this mode, documented in D5).
 * 'none' = no reservation row (legacy launch or failed reserve). */
export function claimLaunch(launchId: string, realSessionId: string): LaunchClaimResult {
  try {
    const db = getSessionDb();
    const row = db
      .prepare('SELECT expected_session_id FROM launch_reservations WHERE launch_id = ?')
      .get(launchId) as { expected_session_id: string | null } | undefined;
    if (!row) return 'none';
    if (row.expected_session_id === null) return 'unbound';
    if (row.expected_session_id !== realSessionId) return 'lost';
    const res = db
      .prepare(
        `UPDATE launch_reservations
            SET claimed_by = @real, claimed_at = @now
          WHERE launch_id = @id AND expected_session_id = @real
            AND (claimed_by IS NULL OR claimed_by = @real) AND canceled_at IS NULL`,
      )
      .run({ id: launchId, real: realSessionId, now: new Date().toISOString() });
    return res.changes === 1 ? 'won' : 'lost'; // 0 ⇒ canceled
  } catch {
    return 'none'; // reservation machinery unavailable → legacy path
  }
}

/** Read one reservation (launch wiring + tests). Null when absent/unreadable. */
export function getLaunchReservation(launchId: string): LaunchReservation | null {
  try {
    const r = getSessionDb()
      .prepare(
        `SELECT launch_id, hosted_by, agent, cwd, expected_session_id, created_at, dispatched_at, claimed_by, claimed_at, canceled_at
           FROM launch_reservations WHERE launch_id = ?`,
      )
      .get(launchId) as Record<string, string | null> | undefined;
    if (!r) return null;
    return {
      launchId: r.launch_id as string,
      hostedBy: r.hosted_by as string,
      agent: r.agent,
      cwd: r.cwd,
      expectedSessionId: r.expected_session_id,
      createdAt: r.created_at as string,
      dispatchedAt: r.dispatched_at,
      claimedBy: r.claimed_by,
      claimedAt: r.claimed_at,
      canceledAt: r.canceled_at,
    };
  } catch {
    return null;
  }
}

/**
 * Read the launch-correlation markers from this process's environment
 * (hook processes inherit the worker's env), reconcile the placeholder
 * row if one exists, and return the validated backend stamp for the
 * caller to merge into its upsert payload. Never throws.
 */
export async function consumeLaunchMarkers(
  realSessionId: string,
): Promise<{ hostedBy?: SessionHostedBy }> {
  const launchId = process.env.SYNTAUR_LAUNCH_ID;
  if (launchId) {
    const claim = claimLaunch(launchId, realSessionId);
    if (claim === 'lost') {
      // Deterministic R3 guard — BOUND reservations only (review r1 F1):
      // the launch injected `--session-id`, so the root's real id is known
      // and this claimant provably is not it (a subagent's SessionStart, or
      // `track-session --session-id <other>` run inside the worker) —
      // regardless of arrival order. Refuse the reconcile AND the backend
      // stamp; the true root always gets 'won', even claiming later.
      return {};
    }
    // 'won': the proven root. 'unbound' (no deterministic root identity —
    // shell-alias claude) and 'none' (legacy launch / failed reserve): take
    // today's path unchanged — the transcript_path/original_head_sha
    // evidence guard inside reconcileLaunchPlaceholder stays the
    // belt-and-braces (documented accepted residual, no worse than Phase B).
    await reconcileLaunchPlaceholder(launchId, realSessionId);
  }
  const raw = process.env.SYNTAUR_HOSTED_BY;
  const hostedBy =
    raw === 'syntaurd' || raw === 'tmux' || raw === 'claude-bg' ? raw : undefined;
  return hostedBy ? { hostedBy } : {};
}

/**
 * Update a session's status by sessionId.
 * Sets `ended` timestamp for terminal statuses (completed, stopped).
 * `endedAt` (ISO 8601) overrides the default `datetime('now')` so sweeps can
 * backdate `ended` to the transcript's last mtime.
 */
/**
 * Thrown when a status update would resurrect a `completed` session to `active`.
 * The dashboard PATCH route maps this to a 409 Conflict.
 */
export class SessionResurrectionError extends Error {}

export async function updateSessionStatus(
  _projectDir: string,
  sessionId: string,
  status: AgentSessionStatus,
  endedAt?: string,
): Promise<boolean> {
  const db = getSessionDb();
  const isTerminal = status === 'completed' || status === 'stopped';

  if (!isTerminal) {
    // The only non-terminal status is `active` — i.e. a revive. Guard against
    // RESURRECTING a terminal session (the route accepts `active` for any id):
    //   - `completed` is FINAL: reviving it would reopen a closed cost window
    //     and recover a stale binding, bypassing the narrow revive rules. Reject
    //     (caller surfaces 409). Liveness GC / legitimate revive live elsewhere.
    //   - `stopped → active` is the one legitimate revive (e.g. `claude --resume`
    //     of a stopped session); clear the stale `ended` in the SAME transaction
    //     as the flip + engagement reopen, so the row never sits active-with-ended.
    // H2: capture the open-baseline snapshot BEFORE the synchronous transaction
    // (the revive reopens the session's engagement, which must carry a
    // `tokens_at_open` so its cost window is computable — AC H2's explicit
    // "revive-reopen"). Best-effort/point-in-time; never blocks the revive.
    let reviveSnapshot: TokenSnapshot | null = null;
    try {
      reviveSnapshot = await getCumulativeTokenSource()(sessionId);
    } catch {
      reviveSnapshot = null;
    }

    // The current-status read + write are one IMMEDIATE transaction so a concurrent
    // terminal transition can't slip between the check and the revive.
    const apply = db.transaction((): boolean => {
      const current = db
        .prepare('SELECT status FROM sessions WHERE session_id = ?')
        .get(sessionId) as { status?: string } | undefined;
      if (!current) return false;
      if (current.status === 'completed') {
        throw new SessionResurrectionError(
          `Refusing to revive completed session "${sessionId}" to active. A completed session is final.`,
        );
      }
      const res = db
        .prepare(
          'UPDATE sessions SET status = ?, ended = NULL, updated_at = datetime(\'now\') WHERE session_id = ?',
        )
        .run(status, sessionId);
      if (res.changes > 0) {
        // A genuine stopped→active revive (current.status is the PRIOR status,
        // so this fires only on a real transition) invalidates any in-flight
        // summarize claim AND clears the now-stale stored summary, so the row
        // re-qualifies for the sweep after it does more work and re-stops.
        if (current.status !== 'active') {
          db.prepare('DELETE FROM summarize_state WHERE session_id = ?').run(sessionId);
          db.prepare(
            'UPDATE sessions SET summary = NULL, summarized_at = NULL WHERE session_id = ?',
          ).run(sessionId);
        }
        reopenEngagementIfMissing(sessionId, null, new Date().toISOString(), reviveSnapshot);
      }
      return res.changes > 0;
    });
    return apply.immediate();
  }

  // Terminal transition closes the session's open engagement so the one-open
  // slot is freed and its cost window is bounded (Decision 7; distinct from
  // liveness GC of *dead* sessions — #5). CAPTURE the open engagement
  // `(id, started_at)` AND the best-effort token snapshot BEFORE the synchronous
  // transaction (the tokens belong to the work done while it was live). Then, in
  // ONE IMMEDIATE transaction, **compare-and-close that captured interval** and
  // **gate the terminal status flip on that close succeeding** (else "the session
  // has no open engagement"). So a concurrent reopen/switch that lands in the
  // async snapshot gap is never clobbered and a revived session is not wrongly
  // marked terminal — mirroring `livenessStopSession` (codex holistic High-1;
  // Decision 7 always intended close-by-captured-id, not a re-read of current-open).
  const captured = getOpenEngagement(sessionId);
  let snapshot: TokenSnapshot | null = null;
  try {
    snapshot = await getCumulativeTokenSource()(sessionId);
  } catch {
    snapshot = null;
  }

  const apply = db.transaction((): boolean => {
    const stillTerminal = captured
      ? closeEngagementById({
          id: captured.id,
          startedAt: captured.started_at,
          closeReason: status === 'completed' ? 'completed' : 'abandoned',
          tokensAtClose: snapshot,
          endedAt: endedAt ?? new Date().toISOString(),
        })
      : getOpenEngagement(sessionId) === null;
    if (!stillTerminal) return false;
    const res = db
      .prepare(
        'UPDATE sessions SET status = ?, ended = COALESCE(?, datetime(\'now\')), updated_at = datetime(\'now\') WHERE session_id = ?',
      )
      .run(status, endedAt ?? null, sessionId);
    return res.changes > 0;
  });
  return apply.immediate();
}

export interface LivenessStopInput {
  sessionId: string;
  /** The open engagement the scanner CAPTURED as dead (compare-and-close). */
  engagementId?: number | null;
  engagementStartedAt?: string | null;
  /** Backdated end (transcript mtime), else `now`. */
  endedAt?: string;
  /** Pre-captured token snapshot (await the async source BEFORE calling). */
  tokensAtClose?: TokenSnapshot | null;
}

/**
 * Liveness-GC terminal stop+close — the dead-session garbage collector (#5,
 * Decisions 1-2). In ONE IMMEDIATE transaction:
 *
 *   1. Compute `stillDead`. If the caller captured the dead engagement, this is
 *      a **compare-and-close** of that exact `(id, started_at)` with
 *      `close_reason='liveness_gc'` — true ONLY if that interval was still open
 *      (a concurrent reopen/switch closed-and-replaced it ⇒ false, and the new
 *      interval is left untouched). With no engagement captured, `stillDead` is
 *      "the session has no current open engagement".
 *   2. ONLY if `stillDead`, mark the session `stopped`. So a session that was
 *      reopened/revived between the dead-detection and this call is neither
 *      closed nor stopped (codex round 3) — its live E2 and `active` row survive.
 *
 * Unlike `updateSessionStatus('stopped')` this does NOT capture its own snapshot
 * and does NOT emit a second generic `abandoned` close. It writes ONLY the
 * `engagement` + `sessions` rows — never assignment facts/status (AC3). Returns
 * true when the session row was actually swept to `stopped`.
 */
export function livenessStopSession(input: LivenessStopInput): boolean {
  const db = getSessionDb();
  const endedAt = input.endedAt ?? new Date().toISOString();
  const apply = db.transaction((): boolean => {
    const stillDead =
      input.engagementId != null && input.engagementStartedAt != null
        ? closeEngagementById({
            id: input.engagementId,
            startedAt: input.engagementStartedAt,
            closeReason: 'liveness_gc',
            tokensAtClose: input.tokensAtClose ?? null,
            endedAt,
          })
        : getOpenEngagement(input.sessionId) === null;
    if (!stillDead) return false;
    const res = db
      .prepare(
        "UPDATE sessions SET status = 'stopped', ended = COALESCE(?, datetime('now')), updated_at = datetime('now') WHERE session_id = ? AND status = 'active'",
      )
      .run(input.endedAt ?? null, input.sessionId);
    return res.changes > 0;
  });
  return apply.immediate();
}

/**
 * List all sessions across all projects.
 */
export async function listAllSessions(_projectsDir: string): Promise<AgentSession[]> {
  const db = getSessionDb();
  const rows = db
    .prepare(`${SESSION_SELECT_WITH_BINDING} ORDER BY s.started DESC`)
    .all() as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * Workspace membership, resolved from disk by the caller.
 *
 * Project slugs alone are not enough: a named workspace can contain STANDALONE
 * assignments (which have no project), and `_ungrouped` means projects with no
 * workspace *plus* standalones with no workspaceGroup. See
 * `resolveWorkspaceMembers` in `api.ts`, which returns both halves.
 */
export interface WorkspaceScope {
  projectSlugs: string[];
  standaloneAssignmentIds: string[];
  /** True for the `_ungrouped` pseudo-workspace, which also claims orphan rows. */
  ungrouped: boolean;
}

export interface SessionPageQuery {
  page: number;
  pageSize: number;
  search?: string;
  /** Inclusive UTC instant bounds, precomputed by the route from local dates. */
  startedFromUtc?: string;
  startedToUtc?: string;
  workspaceScope?: WorkspaceScope | null;
  sort: SessionSort;
  /** Which population to include; see session-attribution.ts. */
  attribution?: SessionAttribution;
}

export interface SessionPageResult {
  sessions: AgentSession[];
  totalCount: number;
}

/**
 * The free-text search haystack: every searchable column concatenated with
 * spaces, mirroring the client's old `[...].join(' ')` exactly. Concatenated
 * rather than OR-ed per column so a query spanning two fields ("alpha task",
 * where the project is `alpha` and the assignment is `task`) still matches, as
 * it did before.
 */
const SEARCH_HAYSTACK = [
  'e.project_slug',
  'e.assignment_slug',
  's.agent',
  's.session_id',
  's.path',
  's.description',
  's.summary',
  's.transcript_path',
]
  .map((col) => `COALESCE(${col}, '')`)
  .join(" || ' ' || ");

/**
 * ORDER BY fragment per sort. Every ordering ends with `s.session_id` so a row
 * can never appear on two pages, or be skipped between them, when the primary
 * key ties — which `started` does routinely for sessions registered in the same
 * second.
 *
 * `spend_desc` / `tokens_desc` are absent by design: cost is computed in JS, so
 * there is no column to order on. They take the ordered-id path instead.
 */
const ORDER_BY: Record<SqlSort, string> = {
  started_desc: 's.started DESC, s.session_id ASC',
  started_asc: 's.started ASC, s.session_id ASC',

  // COLLATE NOCASE: the client sorted with localeCompare (case-insensitive),
  // while SQLite's default BINARY collation puts all uppercase before lowercase.
  assignment_asc:
    "COALESCE(e.assignment_slug, '') COLLATE NOCASE ASC, COALESCE(e.project_slug, '') COLLATE NOCASE ASC, s.session_id ASC",
  agent_asc:
    "s.agent COLLATE NOCASE ASC, COALESCE(e.assignment_slug, '') COLLATE NOCASE ASC, s.session_id ASC",
};

/**
 * Build the shared WHERE fragment + bound parameters for a paged listing.
 *
 * Search is a LITERAL substring match, not a LIKE pattern: the client used
 * JavaScript `includes()`, where `%` and `_` are ordinary characters. `instr()`
 * preserves that; a naive LIKE would silently turn them into wildcards.
 */
function buildSessionFilters(q: SessionPageQuery): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const search = q.search?.trim();
  if (search) {
    clauses.push(`instr(lower(${SEARCH_HAYSTACK}), lower(?)) > 0`);
    params.push(search);
  }

  if (q.startedFromUtc) {
    clauses.push('s.started >= ?');
    params.push(q.startedFromUtc);
  }
  if (q.startedToUtc) {
    clauses.push('s.started <= ?');
    params.push(q.startedToUtc);
  }

  // Attribution. Only the assigned/unassigned split is expressible here; the
  // orphan side of the axis lives in JS, since those rows have no `sessions`
  // row to filter (see pageSessions).
  const attribution = q.attribution ?? DEFAULT_SESSION_ATTRIBUTION;
  if (attribution === 'assigned') {
    clauses.push('e.assignment_slug IS NOT NULL');
  } else if (attribution === 'unassigned') {
    clauses.push('e.assignment_slug IS NULL');
  } else if (!includesTrackedRows(attribution)) {
    // 'usage-only': no tracked row qualifies.
    clauses.push('0');
  }

  const scope = q.workspaceScope;
  if (scope) {
    // A session belongs to the workspace if its chosen engagement points at one
    // of the workspace's projects OR at one of its standalone assignments.
    const parts: string[] = [];
    if (scope.projectSlugs.length > 0) {
      parts.push(`e.project_slug IN (${scope.projectSlugs.map(() => '?').join(', ')})`);
      params.push(...scope.projectSlugs);
    }
    if (scope.standaloneAssignmentIds.length > 0) {
      parts.push(`e.assignment_id IN (${scope.standaloneAssignmentIds.map(() => '?').join(', ')})`);
      params.push(...scope.standaloneAssignmentIds);
    }
    if (scope.ungrouped) {
      // Unattributed sessions (no engagement, or an engagement with neither a
      // project nor an assignment) read as workspace-less, which is exactly what
      // `_ungrouped` means. This mirrors the client's old lookup, where a null
      // projectSlug resolved to a null workspace.
      parts.push('(e.project_slug IS NULL AND e.assignment_id IS NULL)');
    }
    // No members at all: a named workspace with nothing in it matches nothing,
    // rather than degrading into "no filter".
    clauses.push(parts.length > 0 ? `(${parts.join(' OR ')})` : '0');
  }

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * One page of sessions, filtered and sorted in SQL.
 *
 * Deliberately separate from `listAllSessions` rather than a parameterization of
 * it: the unpaged path is still used by every consumer that wants the full set,
 * and by the endpoint when no `pageSize` is supplied.
 *
 * Usage-only rows are NOT produced here — this queries the `sessions` table. The
 * route unions them in (see `attachUsage`), because the synthetic rows are built
 * from the usage aggregate rather than from any session row.
 */
export function listSessionsPage(q: SessionPageQuery): SessionPageResult {
  const db = getSessionDb();
  const { sql: where, params } = buildSessionFilters(q);

  const totalCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM sessions s
           LEFT JOIN engagement e ON e.id = (
             SELECT e2.id FROM engagement e2
              WHERE e2.session_id = s.session_id
              ORDER BY (e2.ended_at IS NULL) DESC, e2.started_at DESC, e2.id DESC
              LIMIT 1
           )
         ${where}`,
      )
      .get(...params) as { n: number }
  ).n;

  // Some sorts cannot be expressed as ORDER BY (JS-computed cost, and live
  // durations that depend on `now`); the caller pages those via the merge path.
  if (requiresMergeSort(q.sort)) {
    return { sessions: [], totalCount };
  }

  const rows = db
    .prepare(
      `${SESSION_SELECT_WITH_BINDING} ${where} ORDER BY ${ORDER_BY[q.sort]} LIMIT ? OFFSET ?`,
    )
    .all(...params, q.pageSize, q.page * q.pageSize) as SessionRow[];
  return { sessions: rows.map(rowToSession), totalCount };
}

/**
 * Every session id passing the filters, in no particular order, paired with the
 * fields the usage sorts need to order and tie-break. Used by the spend/tokens
 * path, which must rank over the FULL filtered set — including tracked sessions
 * with no usage events, which participate as zero-cost rows exactly as the old
 * client-side comparator did (`right.usage?.totalCost ?? 0`).
 */
export interface SessionSortKey {
  sessionId: string;
  started: string;
  ended: string | null;
  assignmentSlug: string | null;
  projectSlug: string | null;
  agent: string;
}

export function listSessionSortKeys(q: SessionPageQuery): SessionSortKey[] {
  const db = getSessionDb();
  const { sql: where, params } = buildSessionFilters(q);
  const rows = db
    .prepare(
      `SELECT s.session_id AS session_id, s.started AS started, s.ended AS ended, s.agent AS agent,
              e.assignment_slug AS assignment_slug, e.project_slug AS project_slug
         FROM sessions s
         LEFT JOIN engagement e ON e.id = (
           SELECT e2.id FROM engagement e2
            WHERE e2.session_id = s.session_id
            ORDER BY (e2.ended_at IS NULL) DESC, e2.started_at DESC, e2.id DESC
            LIMIT 1
         )
       ${where}`,
    )
    .all(...params) as Array<{
    session_id: string;
    started: string;
    ended: string | null;
    agent: string;
    assignment_slug: string | null;
    project_slug: string | null;
  }>;
  return rows.map((r) => ({
    sessionId: r.session_id,
    started: r.started,
    ended: r.ended ?? null,
    assignmentSlug: r.assignment_slug ?? null,
    projectSlug: r.project_slug ?? null,
    agent: r.agent,
  }));
}

/**
 * Every tracked session id, UNFILTERED.
 *
 * Used to decide what counts as a usage-only "orphan". That question is about
 * existence — does this usage id have a `sessions` row at all — and must never
 * be answered from a filtered list, or any session the filter excluded would be
 * misread as an orphan and resurface as a synthetic row.
 */
export function listAllSessionIds(): Set<string> {
  const db = getSessionDb();
  const rows = db.prepare('SELECT session_id FROM sessions').all() as Array<{ session_id: string }>;
  return new Set(rows.map((r) => r.session_id));
}

/** Hydrate a specific set of session ids, preserving the caller's order. */
export function listSessionsForIds(sessionIds: string[]): AgentSession[] {
  if (sessionIds.length === 0) return [];
  const db = getSessionDb();
  const placeholders = sessionIds.map(() => '?').join(', ');
  const rows = db
    .prepare(`${SESSION_SELECT_WITH_BINDING} WHERE s.session_id IN (${placeholders})`)
    .all(...sessionIds) as SessionRow[];
  const bySessionId = new Map(rows.map((r) => [r.session_id, rowToSession(r)]));
  return sessionIds.map((id) => bySessionId.get(id)).filter((s): s is AgentSession => s !== undefined);
}

/**
 * Fetch a single session by its agent-assigned session id.
 * Returns null when no row matches. Throws if initSessionDb() has not run.
 */
export function getSessionById(sessionId: string): AgentSession | null {
  const db = getSessionDb();
  const row = db
    .prepare(`${SESSION_SELECT_WITH_BINDING} WHERE s.session_id = ? LIMIT 1`)
    .get(sessionId) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

/**
 * List sessions for a specific project, optionally filtered by assignment.
 */
export async function listProjectSessions(
  _projectsDir: string,
  projectSlug: string,
  assignmentSlug?: string,
): Promise<AgentSession[]> {
  const db = getSessionDb();

  if (assignmentSlug) {
    const rows = db
      .prepare(
        `${SESSION_SELECT_WITH_BINDING} WHERE e.project_slug = ? AND e.assignment_slug = ? ORDER BY s.started DESC`,
      )
      .all(projectSlug, assignmentSlug) as SessionRow[];
    return rows.map(rowToSession);
  }

  const rows = db
    .prepare(`${SESSION_SELECT_WITH_BINDING} WHERE e.project_slug = ? ORDER BY s.started DESC`)
    .all(projectSlug) as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * Delete sessions by their IDs. Returns the number of session rows deleted.
 * Cascades to the `engagement` edge in the same transaction so no orphan
 * engagements remain (they would otherwise still drive usage attribution and
 * doctor scans). There is no FK ON DELETE CASCADE — engagement intentionally has
 * no FK to sessions — so the cascade is explicit.
 */
export async function deleteSessions(sessionIds: string[]): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const db = getSessionDb();
  const placeholders = sessionIds.map(() => '?').join(', ');
  const run = db.transaction((): number => {
    db.prepare(`DELETE FROM engagement WHERE session_id IN (${placeholders})`).run(...sessionIds);
    // Also drop summarize_state (lease + retry pacing) — otherwise the rows
    // orphan, and a later session that reuses the same id could inherit a stale
    // `next_attempt_at` and be suppressed for up to 24h.
    db.prepare(`DELETE FROM summarize_state WHERE session_id IN (${placeholders})`).run(...sessionIds);
    const result = db
      .prepare(`DELETE FROM sessions WHERE session_id IN (${placeholders})`)
      .run(...sessionIds);
    return result.changes;
  });
  return run.immediate();
}

// Statuses that imply the working session is done (review means agent finished)
const DONE_ASSIGNMENT_STATUSES = new Set(['completed', 'failed', 'review']);

/**
 * Read the status field from an assignment.md frontmatter without full parsing.
 */
async function readAssignmentStatusFromPath(
  assignmentMdPath: string,
): Promise<string | null> {
  if (!(await fileExists(assignmentMdPath))) return null;
  const raw = await readFile(assignmentMdPath, 'utf-8');
  const match = raw.match(/^status:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

async function readAssignmentStatus(
  projectDir: string,
  assignmentSlug: string,
): Promise<string | null> {
  return readAssignmentStatusFromPath(
    resolve(projectDir, 'assignments', assignmentSlug, 'assignment.md'),
  );
}

/**
 * Reconcile active sessions against assignment statuses.
 * Sessions whose assignments have moved to completed/failed/review are
 * marked as completed (or stopped for failed assignments).
 * Standalone sessions (project_slug NULL) are resolved via assignmentsDir.
 * Returns the number of sessions that were updated.
 */
export async function reconcileActiveSessions(
  projectsDir: string,
  assignmentsDir?: string,
): Promise<number> {
  const db = getSessionDb();

  // Reconcile against the session's CURRENTLY OPEN engagement only — a closed
  // historical engagement must never drive a session to completed (Decision 8).
  // Standalone bindings carry project_slug IS NULL on the engagement.
  const activeSessions = db
    .prepare(
      `SELECT s.*, e.project_slug AS project_slug, e.assignment_slug AS assignment_slug
         FROM sessions s
         JOIN engagement e ON e.session_id = s.session_id AND e.ended_at IS NULL
        WHERE s.status = 'active' AND e.assignment_slug IS NOT NULL`,
    )
    .all() as SessionRow[];

  if (activeSessions.length === 0) return 0;

  // Read assignment statuses from disk. Key is `${projectSlug ?? '__standalone__'}/${slug}`.
  const assignmentStatuses = new Map<string, string>();
  const seen = new Set<string>();
  for (const session of activeSessions) {
    const aslug = session.assignment_slug;
    if (!aslug) continue;

    const projectKey = session.project_slug ?? '__standalone__';
    const key = `${projectKey}/${aslug}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (session.project_slug) {
      const status = await readAssignmentStatus(
        resolve(projectsDir, session.project_slug),
        aslug,
      );
      if (status) assignmentStatuses.set(key, status);
    } else if (assignmentsDir) {
      const status = await readAssignmentStatusFromPath(
        resolve(assignmentsDir, aslug, 'assignment.md'),
      );
      if (status) assignmentStatuses.set(key, status);
    }
  }

  // Update stale sessions
  let totalUpdated = 0;
  for (const session of activeSessions) {
    const projectKey = session.project_slug ?? '__standalone__';
    const key = `${projectKey}/${session.assignment_slug}`;
    const assignmentStatus = assignmentStatuses.get(key);
    if (!assignmentStatus || !DONE_ASSIGNMENT_STATUSES.has(assignmentStatus)) continue;

    const newStatus: AgentSessionStatus =
      assignmentStatus === 'failed' ? 'stopped' : 'completed';
    await updateSessionStatus('', session.session_id, newStatus);
    totalUpdated++;
  }

  return totalUpdated;
}

/**
 * List sessions for a resolved assignment (standalone or project-nested).
 * Standalone: filter by assignment_slug = id AND project_slug IS NULL.
 * Project-nested: filter by project_slug + assignment_slug.
 */
export async function listSessionsByAssignment(
  projectSlug: string | null,
  assignmentSlug: string,
): Promise<AgentSession[]> {
  const db = getSessionDb();
  const rows = projectSlug === null
    ? (db
        .prepare(
          `${SESSION_SELECT_WITH_BINDING} WHERE e.assignment_slug = ? AND e.project_slug IS NULL ORDER BY s.started DESC`,
        )
        .all(assignmentSlug) as SessionRow[])
    : (db
        .prepare(
          `${SESSION_SELECT_WITH_BINDING} WHERE e.project_slug = ? AND e.assignment_slug = ? ORDER BY s.started DESC`,
        )
        .all(projectSlug, assignmentSlug) as SessionRow[]);
  return rows.map(rowToSession);
}

// --- Summarizer lease + finalization --------------------------------------

/** Outcome of {@link finalizeSummarize}. */
export type FinalizeSummarizeResult = 'ok-desc-updated' | 'ok-desc-kept' | 'lost-lease';

/** How long a claim may sit unreleased before another worker may take it. */
const SUMMARIZE_CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * Try to take the summarize lease for `sessionId` under `token`.
 *
 * Claims are atomic across processes: SQLite serializes the write, and the
 * conditional `WHERE claim_token IS NULL` means exactly one concurrent claimant
 * observes `changes === 1`. A claim older than {@link SUMMARIZE_CLAIM_STALE_MS}
 * is treated as abandoned (a crashed worker) and cleared first, so a dead
 * process can never block a session forever.
 *
 * Returns true iff this caller now owns the lease.
 */
export function claimSummarize(sessionId: string, token: string, now = new Date()): boolean {
  const db = getSessionDb();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - SUMMARIZE_CLAIM_STALE_MS).toISOString();

  const claim = db.transaction(() => {
    db.prepare(
      `UPDATE summarize_state
          SET claim_token = NULL, claimed_at = NULL
        WHERE session_id = ? AND claim_token IS NOT NULL AND claimed_at < ?`,
    ).run(sessionId, staleBefore);

    const res = db
      .prepare(
        `INSERT INTO summarize_state (session_id, claim_token, claimed_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           claim_token = excluded.claim_token,
           claimed_at  = excluded.claimed_at
         WHERE summarize_state.claim_token IS NULL`,
      )
      .run(sessionId, token, nowIso);
    return res.changes === 1;
  });
  return claim();
}

/**
 * Release a lease without recording an outcome (used for skip paths).
 * Token-matched: a worker whose lease already went stale and was re-claimed by
 * someone else cannot release the newer owner's claim.
 */
export function releaseSummarize(sessionId: string, token: string): void {
  getSessionDb()
    .prepare(
      `UPDATE summarize_state
          SET claim_token = NULL, claimed_at = NULL
        WHERE session_id = ? AND claim_token = ?`,
    )
    .run(sessionId, token);
}

/**
 * Record a failed or deliberately-deferred attempt: bump `attempts`, store the
 * error, and push `next_attempt_at` out by `retryAfterMs` so the sweep stops
 * re-selecting this session. Token-matched, and releases the lease.
 *
 * This is what makes a capped newest-first sweep fair: without persisted
 * backoff, the same doomed rows would be picked every tick and older valid
 * sessions would never be reached.
 */
export function recordSummarizeFailure(
  sessionId: string,
  token: string,
  error: string,
  retryAfterMs: number,
  now = new Date(),
): void {
  const nextAttempt = new Date(now.getTime() + retryAfterMs).toISOString();
  getSessionDb()
    .prepare(
      `UPDATE summarize_state
          SET claim_token     = NULL,
              claimed_at      = NULL,
              attempts        = attempts + 1,
              next_attempt_at = ?,
              last_error      = ?
        WHERE session_id = ? AND claim_token = ?`,
    )
    .run(nextAttempt, error.slice(0, 2000), sessionId, token);
}

/**
 * Persist a generated summary, honouring description provenance, and release
 * the lease — all in ONE transaction.
 *
 * The ownership check comes first: a worker whose lease expired mid-call gets
 * `lost-lease` and writes nothing, so a slow straggler can never overwrite the
 * work of the worker that superseded it.
 *
 * `description` is written only when the current one is empty or was itself
 * auto-generated; the CASE expressions do that decision IN SQL rather than as a
 * read-then-write, so a human description saved concurrently cannot be lost to
 * a race. `summary` always writes — a human-owned description never suppresses
 * the summary itself, it only means `descriptionUpdated` is false.
 *
 * The lease token is the sole authority: a revive (stop→active) deletes this
 * session's `summarize_state` row in the same transaction as the flip (see
 * `appendSession` / `updateSessionStatus`), so a summarizer that was mid-call
 * when the session resumed finds no matching claim here and returns `lost-lease`
 * — it never persists a pre-resume summary, regardless of sub-second timing.
 */
export function finalizeSummarize(
  sessionId: string,
  token: string,
  fields: { description: string; summary: string },
  now = new Date(),
): FinalizeSummarizeResult {
  const db = getSessionDb();
  const nowIso = now.toISOString();

  const run = db.transaction((): FinalizeSummarizeResult => {
    const state = db
      .prepare('SELECT claim_token FROM summarize_state WHERE session_id = ?')
      .get(sessionId) as { claim_token: string | null } | undefined;
    if (!state || state.claim_token !== token) return 'lost-lease';

    const updated = db
      .prepare(
        `UPDATE sessions SET
           summary = ?,
           summarized_at = ?,
           description = CASE
             WHEN description IS NULL OR description = '' OR description_source = 'auto'
               THEN ? ELSE description END,
           description_source = CASE
             WHEN description IS NULL OR description = '' OR description_source = 'auto'
               THEN 'auto' ELSE description_source END,
           updated_at = datetime('now')
         WHERE session_id = ?`,
      )
      .run(fields.summary, nowIso, fields.description, sessionId);

    // Zero rows: the session row was deleted concurrently, OR (requireTerminal)
    // it was revived to active. Either way drop the lease without pacing so it
    // re-qualifies when it next ends.
    if (updated.changes === 0) {
      db.prepare('DELETE FROM summarize_state WHERE session_id = ? AND claim_token = ?').run(
        sessionId,
        token,
      );
      return 'lost-lease';
    }

    // Read the post-write provenance INSIDE the transaction, so the reported
    // flag reflects exactly what the UPDATE above decided.
    const after = db
      .prepare('SELECT description_source FROM sessions WHERE session_id = ?')
      .get(sessionId) as { description_source: string | null } | undefined;

    db.prepare(
      `UPDATE summarize_state
          SET claim_token = NULL, claimed_at = NULL,
              next_attempt_at = NULL, attempts = 0, last_error = NULL
        WHERE session_id = ? AND claim_token = ?`,
    ).run(sessionId, token);

    return after?.description_source === 'auto' ? 'ok-desc-updated' : 'ok-desc-kept';
  });

  return run();
}

/**
 * Sessions eligible for an automatic summary sweep, newest first.
 *
 * Eligibility deliberately excludes live sessions: a session still in progress
 * would be summarized from a partial transcript and then never revisited
 * (`summary IS NULL` is the sweep's only trigger). Explicit-id calls have no
 * such restriction.
 */
export function listSessionsNeedingSummary(limit: number, now = new Date()): AgentSession[] {
  const rows = getSessionDb()
    .prepare(
      `${SESSION_SELECT_WITH_BINDING}
        WHERE s.summary IS NULL
          AND s.transcript_path IS NOT NULL
          AND s.transcript_path != ''
          AND s.status IN ('stopped', 'completed')
          AND NOT EXISTS (
            SELECT 1 FROM summarize_state ss
             WHERE ss.session_id = s.session_id
               AND ss.next_attempt_at IS NOT NULL
               AND ss.next_attempt_at > ?
          )
        ORDER BY s.started DESC
        LIMIT ?`,
    )
    .all(now.toISOString(), limit) as SessionRow[];
  return rows.map(rowToSession);
}
