import { randomUUID } from 'node:crypto';
import { SyntaurError } from '../../errors.js';
import { daemonRequest, queryDaemon } from '../../daemon/client.js';
import { appendSession } from '../../dashboard/agent-sessions.js';
import { captureProcessStartedAt } from '../../utils/process-info.js';
import { resolveRunner } from '../../utils/agents-schema.js';
import type { ControlReply, ControlRequest, DispatchReply, ErrorReply, ListReply } from '../../daemon/types.js';
import type { AgentConfig } from '../../utils/config.js';
import type { AgentLaunchPlan } from '../../launch/build-launch.js';

export type DispatchRequest = Extract<ControlRequest, { op: 'dispatch' }>;
export type RequestFn = (req: ControlRequest) => Promise<ControlReply>;

export interface DispatchContext {
  name: string;
  agentId: string;
  sessionId: string;
  cols: number;
  rows: number;
}

/**
 * Pure: map buildLaunchPlan's output onto the daemon dispatch payload.
 * `argv` is one flat array — [command, ...args] — exactly how `syntaur bg`
 * dispatches. Phase B additionally supplies `agent` (else the supervisor
 * infers it) and `sessionId` (the reserved session-db join key).
 */
export function buildDispatchRequest(plan: AgentLaunchPlan, ctx: DispatchContext): DispatchRequest {
  return {
    op: 'dispatch',
    argv: [plan.command, ...plan.args],
    cwd: plan.cwd,
    name: ctx.name,
    agent: ctx.agentId,
    sessionId: ctx.sessionId,
    // Launch-correlation markers: inherited by the worker's env; claude's
    // session-registration hook reads them to reconcile the pre-inserted
    // placeholder row onto claude's real session id and stamp backend
    // provenance. Harmless for agents that never read them. When
    // `--session-id` is injected the ids are equal and reconcile no-ops.
    env: { SYNTAUR_LAUNCH_ID: ctx.sessionId, SYNTAUR_HOSTED_BY: 'syntaurd' },
    cols: ctx.cols,
    rows: ctx.rows,
  };
}

/**
 * Whether `--session-id <uuid>` can be injected into this plan's argv so a
 * claude child adopts the cockpit-generated id (Claude's session-registration
 * hook then upserts the SAME pre-inserted row). Mirrors
 * isNativeLaunchEligible's shell-alias reasoning: an alias plan's argv is
 * `$SHELL -i -c '<quoted>'` — appending flags would hand them to the shell,
 * not claude.
 */
export function canInjectClaudeSessionId(agent: AgentConfig): boolean {
  return resolveRunner(agent) === 'claude' && !agent.resolveFromShellAliases;
}

/** Pure argv injection — mirrors injectBgArgs. */
export function injectSessionIdArgs(args: string[], sessionId: string): string[] {
  return ['--session-id', sessionId, ...args];
}

export interface LaunchSyntaurdInput {
  plan: AgentLaunchPlan;
  /** Rail/daemon display name, e.g. `"<project>/<assignment>"` (same value the --bg tier uses). */
  name: string;
  agent: AgentConfig;
  projectSlug: string | null;
  assignmentSlug: string | null;
  cols?: number;
  rows?: number;
  /** Injectable seams — tests only. */
  request?: RequestFn;
  registerRow?: typeof appendSession;
  generateSessionId?: () => string;
  now?: () => string;
  /**
   * Resolves whether a session with `sessionId` is ALREADY running on the
   * daemon. Used only to disambiguate a failed dispatch request (see
   * `findDispatchedSession`); injectable for tests.
   */
  findSession?: (sessionId: string) => Promise<DispatchedSession | null>;
  /** Injectable clock seam for the placeholder row's pid start time — tests only. */
  pidStartedAt?: (pid: number) => string | null;
}

/** A daemon session confirmed to exist by the post-failure reconciliation probe. */
export interface DispatchedSession {
  short: string;
  pid: number;
  /** The daemon's own spawn-time `ps -o lstart=` capture, when it has one. */
  pidStartedAt: string | null;
}

/**
 * Did the dispatch we just failed to get a reply for actually land?
 *
 * `sendRequest` is one-shot and can reject (timeout, socket teardown) AFTER the
 * supervisor already spawned the session — the request succeeded, only the
 * reply was lost. Treating that as a launch failure would degrade down the
 * ladder and start a SECOND agent in the same worktree, which is the one
 * outcome this tier must never produce. The dispatch-supplied `sessionId` is
 * the join key the daemon stores, so a non-spawning `list` answers the question
 * definitively. Never throws: an unusable probe returns null, which means
 * "unconfirmed" and lets the caller degrade exactly as it does today.
 */
async function findDispatchedSession(sessionId: string): Promise<DispatchedSession | null> {
  try {
    const reply = await queryDaemon({ op: 'list' }, { timeoutMs: 1000 });
    if (reply === null || reply.ok !== true) return null;
    const hit = ((reply as ListReply).sessions ?? []).find((s) => s.sessionId === sessionId);
    return hit ? { short: hit.short, pid: hit.pid, pidStartedAt: hit.pidStartedAt ?? null } : null;
  } catch {
    return null; // unconfirmed — the caller degrades
  }
}

export interface LaunchSyntaurdResult {
  short: string;
  sessionId: string;
  /** false = the daemon session is running but BOTH registry writes failed — the caller shows a warning status. */
  registered: boolean;
}

/**
 * Dispatch a launch plan to the syntaur daemon (auto-spawning it via
 * ensureDaemon — desired on explicit user action) and pre-insert the durable
 * session-db row keyed by the SAME generated sessionId. Throws on dispatch
 * failure so runLaunch's catch degrades to the next tier; NEVER throws after
 * the daemon session exists (a row-registration failure must not trigger a
 * second launch via tmux).
 */
export async function launchSyntaurd(input: LaunchSyntaurdInput): Promise<LaunchSyntaurdResult> {
  const request: RequestFn = input.request ?? ((req) => daemonRequest(req));
  const registerRow = input.registerRow ?? appendSession;
  const sessionId = (input.generateSessionId ?? randomUUID)();

  const args = canInjectClaudeSessionId(input.agent)
    ? injectSessionIdArgs(input.plan.args, sessionId)
    : input.plan.args;
  const plan: AgentLaunchPlan = { ...input.plan, args };

  const dispatchRequest = buildDispatchRequest(plan, {
    name: input.name,
    agentId: input.agent.id,
    sessionId,
    cols: input.cols ?? 80,
    rows: input.rows ?? 24,
  });

  // Three outcomes, and only ONE of them may degrade to the next tier:
  //  - ErrorReply  → the daemon answered "no". Definitely nothing spawned;
  //                  throwing is correct and the ladder degrades.
  //  - rejection   → AMBIGUOUS. ensureDaemon may have failed (nothing spawned)
  //                  OR the session spawned and only the reply was lost. Ask
  //                  the daemon which it was before starting a second agent.
  //  - DispatchReply → success.
  let session: DispatchedSession;
  try {
    const reply = (await request(dispatchRequest)) as DispatchReply | ErrorReply;
    if (!reply.ok) {
      throw new SyntaurError(`daemon dispatch failed: ${reply.error}`, {
        remediation: 'Inspect `syntaur daemon logs`.',
      });
    }
    session = { short: reply.short, pid: reply.pid, pidStartedAt: null };
  } catch (err) {
    if (err instanceof SyntaurError && err.message.startsWith('daemon dispatch failed:')) {
      throw err; // definite refusal — degrade
    }
    // A probe that itself fails means "unconfirmed" — degrade with the
    // ORIGINAL dispatch error, which is the informative one.
    let landed: DispatchedSession | null = null;
    try {
      landed = await (input.findSession ?? findDispatchedSession)(sessionId);
    } catch {
      landed = null;
    }
    if (!landed) throw err; // unconfirmed — degrade, exactly as before
    // The session IS running; the reply was merely lost. Adopting it here is
    // what prevents a duplicate agent in the same worktree.
    session = landed;
  }

  // Insert the durable registry row: the daemon⇄session-db join is keyed on
  // this sessionId; non-claude agents never self-register, so this is their
  // only row source — without it the session cannot join the rail. pid = the
  // pty-host pid, a real liveness signal for the scanner sweep.
  // Registration MUST NOT throw (the daemon session IS running; a throw would
  // make runLaunch degrade to tmux and double-launch), but its failure MUST
  // NOT be silent either. Contract: one bounded retry, then report
  // registered:false so the caller surfaces a warning status.
  // WHY not insert-before-dispatch: appendSession opens an engagement in the
  // same txn and status is forward-only — a failed dispatch would strand an
  // active row (compensating 'stopped' would then block the tmux fallback's
  // re-registration of the same identity). Dispatch-first + retry has no such
  // trap; the un-registered window is one poll tick.
  // pid_started_at is captured (not left NULL) because the scanner's recycle
  // guard SHORT-CIRCUITS on a null baseline — `!row.pid_started_at || …`
  // (scanner.ts:373) — so a null would let a recycled pid keep a dead session
  // 'active' indefinitely. The daemon captures the same `ps -o lstart=` string
  // at spawn; we re-capture it here because DispatchReply doesn't carry it,
  // and adopt the daemon's own value on the reply-lost path above.
  const capturePidStart = input.pidStartedAt ?? captureProcessStartedAt;
  const row = {
    sessionId,
    agent: input.agent.id,
    started: (input.now ?? (() => new Date().toISOString()))(),
    status: 'active' as const,
    path: input.plan.cwd,
    pid: session.pid,
    pidStartedAt: session.pidStartedAt ?? capturePidStart(session.pid),
    projectSlug: input.projectSlug,
    assignmentSlug: input.assignmentSlug,
    hostedBy: 'syntaurd' as const,
  };
  let registered = true;
  try {
    await registerRow('', row);
  } catch {
    try {
      await registerRow('', row); // one bounded retry (transient lock/IO)
    } catch {
      registered = false; // never fall through to a second launch
    }
  }
  return { short: session.short, sessionId, registered };
}
