import { randomUUID } from 'node:crypto';
import { SyntaurError } from '../../errors.js';
import { daemonRequest } from '../../daemon/client.js';
import { appendSession } from '../../dashboard/agent-sessions.js';
import { resolveRunner } from '../../utils/agents-schema.js';
import type { ControlReply, ControlRequest, DispatchReply, ErrorReply } from '../../daemon/types.js';
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

  const reply = (await request(
    buildDispatchRequest(plan, {
      name: input.name,
      agentId: input.agent.id,
      sessionId,
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
    }),
  )) as DispatchReply | ErrorReply;
  if (!reply.ok) {
    throw new SyntaurError(`daemon dispatch failed: ${reply.error}`, {
      remediation: 'Inspect `syntaur daemon logs`.',
    });
  }

  // Insert the durable registry row: the daemon⇄session-db join is keyed on
  // this sessionId; non-claude agents never self-register, so this is their
  // only row source — without it the session cannot join the rail. pid = the
  // pty-host pid — a real liveness signal for the scanner sweep;
  // pid_started_at stays NULL (the lstart guard short-circuits on it).
  // Registration MUST NOT throw (the daemon session IS running; a throw would
  // make runLaunch degrade to tmux and double-launch), but its failure MUST
  // NOT be silent either. Contract: one bounded retry, then report
  // registered:false so the caller surfaces a warning status.
  // WHY not insert-before-dispatch: appendSession opens an engagement in the
  // same txn and status is forward-only — a failed dispatch would strand an
  // active row (compensating 'stopped' would then block the tmux fallback's
  // re-registration of the same identity). Dispatch-first + retry has no such
  // trap; the un-registered window is one poll tick.
  const row = {
    sessionId,
    agent: input.agent.id,
    started: (input.now ?? (() => new Date().toISOString()))(),
    status: 'active' as const,
    path: input.plan.cwd,
    pid: reply.pid,
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
  return { short: reply.short, sessionId, registered };
}
