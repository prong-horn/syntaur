import type { DetailSelection } from './DetailPane.js';
import type { Action } from './actionBarLayout.js';
import type { launchClaudeBg as LaunchClaudeBg } from '../claude-agents/launch.js';
import { isNativeLaunchEligible } from '../claude-agents/launch.js';
import { resolveRunner } from '../../utils/agents-schema.js';
import type { AgentConfig } from '../../utils/config.js';
import type { AgentLaunchPlan } from '../../launch/build-launch.js';
import type { AgentSessionWithLiveness, NativeAgentState } from '../../dashboard/types.js';

export interface ActionCallbacks {
  onLaunch: () => void;
  onAttach: () => void;
  onQuit: () => void;
}

/** Native states that mean the session is over — Attach against it would just fail. */
const NATIVE_TERMINAL_STATES: ReadonlySet<NativeAgentState> = new Set(['done', 'failed', 'stopped']);

/**
 * True when a session should be attached via the native `claude attach`
 * path: it has a native short id and its `state` is anything OTHER than
 * terminal (`working`, `blocked` — a permission prompt — or any future
 * waiting-ish state all count; only done/failed/stopped disqualify it).
 * Exported so Cockpit's `handleAttach` can pick the SAME path this enable
 * check assumes, rather than re-deriving the rule a second time.
 */
export function isNativeAttachReachable(session: AgentSessionWithLiveness): boolean {
  return session.agentShortId != null && session.state != null && !NATIVE_TERMINAL_STATES.has(session.state);
}

/**
 * True when a session should be attached via `syntaur attach <short>`:
 * it carries the daemon join's short id and a non-terminal state. Checked
 * BEFORE the native path — mirrors the feed join precedence (syntaurd owns
 * the PTY; its truth wins on overlap). Exported so Cockpit's `handleAttach`
 * picks the SAME path this enable check assumes.
 */
export function isSyntaurdAttachReachable(session: AgentSessionWithLiveness): boolean {
  return session.syntaurdShortId != null && session.state != null && !NATIVE_TERMINAL_STATES.has(session.state);
}

/**
 * Attach is enabled via ONE of two independent paths, in precedence order:
 *  - syntaurd (see `isSyntaurdAttachReachable`) — daemon-hosted sessions;
 *    AUTHORITATIVE when the short id is present (a terminal daemon state must
 *    not fall through to gates whose isLive could read stale-true off a
 *    lingering pid).
 *  - Native (see `isNativeAttachReachable`) — AUTHORITATIVE when present: a
 *    terminal-state native session must not fall through to a gate whose
 *    isLive can still read stale-true off a lingering pid the native truth
 *    already knows ended.
 * A row reachable by neither daemon backend is not attachable (Phase C
 * removed the tmux tier — see the final `return false`).
 */
function attachEnabled(selection: DetailSelection): boolean {
  if (selection.kind !== 'session') return false;
  const { session } = selection;
  if (session.syntaurdShortId != null && session.state != null) {
    return isSyntaurdAttachReachable(session);
  }
  if (session.agentShortId != null && session.state != null) {
    return isNativeAttachReachable(session);
  }
  if (session.hostedBy === 'syntaurd' || session.hostedBy === 'claude-bg') return false;
  // No tmux tier (Phase C): a row reachable by neither daemon backend is not attachable.
  return false;
}

/**
 * Pure enable/disable + wiring for the cockpit's context-sensitive action
 * bar, extracted out of Cockpit.tsx so the enable/disable matrix is
 * unit-testable without rendering (Ink strips dimColor/color from a
 * non-TTY `lastFrame()`, so a render-only test can't distinguish enabled
 * from disabled buttons).
 *
 * Launch needs a project-nested assignment selection (non-null
 * `projectSlug` -- `launchAgent`/`getAssignmentDetail` require it). Attach's
 * rule is `attachEnabled` above. Quit is always enabled.
 */
export function buildActions(
  selection: DetailSelection,
  callbacks: ActionCallbacks,
): Action[] {
  return [
    {
      key: 'l',
      label: 'Launch',
      enabled: selection.kind === 'assignment' && selection.projectSlug != null,
      onRun: callbacks.onLaunch,
    },
    {
      key: 'a',
      label: 'Attach',
      enabled: attachEnabled(selection),
      onRun: callbacks.onAttach,
    },
    { key: 'q', label: 'Quit', enabled: true, onRun: callbacks.onQuit },
  ];
}

/**
 * Routes a single keypress to the action whose shortcut it matches, but
 * ONLY calls `onRun` if that action is enabled -- a disabled action must
 * ignore both mouse clicks (see ActionBar's onClick guard) and keyboard
 * shortcuts.
 */
export function dispatchActionKey(actions: Action[], input: string): void {
  const action = actions.find((a) => a.key === input);
  if (action?.enabled) action.onRun();
}

/**
 * The resolved spawn invocation `runLaunch` hands to `handOff`. Same
 * shape as `AgentLaunchPlan` (`../../launch/build-launch.js`) — the only
 * producer of this value is `buildLaunchPlan`, so this is a type alias rather
 * than a redeclaration to avoid two independently-drifting definitions.
 */
export type LaunchExecPlan = AgentLaunchPlan;

export interface LaunchDeps {
  handOff: (plan: LaunchExecPlan) => Promise<void>;
  /** Native path deps — optional so existing hand-off-only call sites and tests need no changes. */
  claudeBgAvailable?: boolean;
  launchClaudeBg?: typeof LaunchClaudeBg;
  /**
   * Called when a `--bg` spawn throws, before falling through to hand-off
   * (design spec §7: "surface in status line, fall back... if available").
   * The overall `runLaunch` result still reports the FALLBACK mode
   * ('handoff') — this hook is how the caller learns the native
   * attempt failed first, to compose a richer status message.
   */
  onNativeLaunchFailure?: (error: unknown) => void;
  /**
   * syntaurd (daemon) tier deps — optional like the native pair above, so
   * existing call sites and tests need no changes. The dep signature is a thin
   * closure: the Cockpit supplies projectSlug/assignment/cols/rows context and
   * calls the tier module (src/tui/syntaurd/launch.ts).
   */
  syntaurdAvailable?: boolean;
  launchSyntaurd?: (input: { plan: LaunchExecPlan; name: string; agent: AgentConfig }) => Promise<void>;
  /**
   * Called when a syntaurd dispatch throws (ensureDaemon start-timeout
   * SyntaurError, dispatch ErrorReply), before degrading to
   * claude-bg/hand-off — same contract as onNativeLaunchFailure.
   */
  onSyntaurdLaunchFailure?: (error: unknown) => void;
}

/** Native-launch context, when the selection's agent might be eligible for `--bg`. */
export interface NativeLaunchInput {
  agent: AgentConfig;
  /** The `--name` value, e.g. `"<project>/<assignment>"` (design spec §5.6). */
  name: string;
}

/**
 * Launch degradation, in priority order (Phase C removed the tmux tier):
 *  1. syntaurd (the syntaur daemon), for ALL agents.
 *  2. Native `claude --bg`, when `native` is supplied AND `deps.claudeBgAvailable`
 *     AND the agent resolves to the claude runner AND Task 6's eligibility
 *     guards pass (not shell-alias-wrapped, no `-p`/`--print`). A failed `--bg`
 *     spawn is caught and falls through to hand-off below rather than
 *     surfacing as a bare launch failure — the resulting 'handoff' status is
 *     what the caller shows the user.
 *  3. In-process hand-off (the caller suspends the terminal, spawns the plan
 *     with inherited stdio, and exits the cockpit once the agent exits).
 * INTENDED UX change: a launch with no daemon and no claude-bg now lands in
 * in-process hand-off rather than a detached tmux session.
 * Kept side-effect-free besides the injected deps so this degradation matrix
 * is unit-testable without claude, Ink, or a real spawn.
 */
export async function runLaunch(
  plan: LaunchExecPlan,
  deps: LaunchDeps,
  native?: NativeLaunchInput,
): Promise<'syntaurd' | 'claude-bg' | 'handoff'> {
  // Tier 0: the syntaur daemon — for ALL agents (no runner/eligibility guard:
  // a PTY runs anything, including shell-alias plans). Gated only on `native`
  // (agent+name context), the capability boolean, and the injected dep.
  // try/catch matches the claude-bg branch below: ensureDaemon throws
  // SyntaurError on start-timeout — without this, a daemon hiccup would abort
  // a launch hand-off could serve.
  if (native && deps.syntaurdAvailable && deps.launchSyntaurd) {
    try {
      await deps.launchSyntaurd({ plan, name: native.name, agent: native.agent });
      return 'syntaurd';
    } catch (err) {
      deps.onSyntaurdLaunchFailure?.(err);
    }
  }
  if (
    native &&
    deps.claudeBgAvailable &&
    deps.launchClaudeBg &&
    resolveRunner(native.agent) === 'claude' &&
    isNativeLaunchEligible(native.agent, plan.args)
  ) {
    try {
      await deps.launchClaudeBg({ plan, name: native.name });
      return 'claude-bg';
    } catch (err) {
      // Fall through to hand-off below — a failed --bg spawn degrades
      // exactly like native being ineligible, rather than aborting the launch.
      deps.onNativeLaunchFailure?.(err);
    }
  }
  await deps.handOff(plan);
  return 'handoff';
}

/**
 * How a spawned/attached child process ended, as reported by a Node child
 * 'exit'/'error' listener pair. Shared shape for both the syntaurd-attach
 * child (`runSyntaurdAttach`) and the hand-off agent child (Cockpit's
 * `handOff`), so their pass/fail decisions can share the same pure
 * classification below instead of duplicating ad hoc checks at each call site.
 */
export interface ChildOutcome {
  code: number | null;
  error?: Error;
}

/**
 * True when a child ended without error and with exit code 0. A `null` code
 * (no error, but no code either -- e.g. terminated by a signal, or a
 * best-effort coercion of a missing exit-code argument) is NOT clean by
 * default, since for a hand-off launch it's indistinguishable from an
 * abnormal termination and silently exiting the cockpit on it would repeat
 * the bug this type exists to prevent. Pass `allowNullCode: true` for
 * attach, where a normal detach can legitimately report a null code and
 * still be a clean detach.
 */
export function isCleanExit(outcome: ChildOutcome, opts: { allowNullCode?: boolean } = {}): boolean {
  if (outcome.error) return false;
  if (outcome.code === 0) return true;
  return Boolean(opts.allowNullCode) && outcome.code === null;
}

/**
 * Human-readable failure description for a non-clean `ChildOutcome`, mirroring
 * `launchAgent`'s ENOENT/EACCES wording (`../launch.ts`) so a failed hand-off
 * reads the same as a failed direct launch. `command` is optional context
 * (the binary that was spawned) appended to the ENOENT/EACCES cases.
 */
export function describeChildFailure(outcome: ChildOutcome, command?: string): string {
  if (outcome.error) {
    const code = (outcome.error as NodeJS.ErrnoException).code;
    const suffix = command ? ` (${command})` : '';
    if (code === 'ENOENT') return `command not found${suffix}`;
    if (code === 'EACCES') return `permission denied${suffix}`;
    return outcome.error.message;
  }
  return `exited with code ${outcome.code}`;
}
