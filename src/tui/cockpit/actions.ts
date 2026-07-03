import type { DetailSelection } from './DetailPane.js';
import type { Action } from './actionBarLayout.js';
import type { launchInTmux as LaunchInTmux } from '../tmux/launch.js';
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

/** Capabilities the action-bar enable matrix and launch dispatch degrade on. */
export interface ActionCaps {
  tmuxAvailable: boolean;
  claudeBgAvailable: boolean;
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
 * Attach is enabled via ONE of two independent paths:
 *  - Native (see `isNativeAttachReachable`) — reachable with no tmux
 *    installed at all, and AUTHORITATIVE when present: a terminal-state
 *    native session must not fall through to the tmux gate below, whose
 *    isLive can still read stale-true off a lingering pid the native truth
 *    already knows ended.
 *  - tmux (existing v1 gate, unchanged): tmux available, the session is LIVE,
 *    and it has a non-null `assignmentSlug` (the tmux session name is derived
 *    from project+assignment slugs).
 */
function attachEnabled(selection: DetailSelection, caps: ActionCaps): boolean {
  if (selection.kind !== 'session') return false;
  const { session } = selection;
  if (session.agentShortId != null && session.state != null) {
    return isNativeAttachReachable(session);
  }
  return caps.tmuxAvailable && session.isLive === true && session.assignmentSlug != null;
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
  caps: ActionCaps,
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
      enabled: attachEnabled(selection, caps),
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
 * The resolved spawn invocation `runLaunch` hands to tmux or `handOff`. Same
 * shape as `AgentLaunchPlan` (`../../launch/build-launch.js`) — the only
 * producer of this value is `buildLaunchPlan`, so this is a type alias rather
 * than a redeclaration to avoid two independently-drifting definitions.
 */
export type LaunchExecPlan = AgentLaunchPlan;

export interface LaunchDeps {
  tmuxAvailable: boolean;
  launchInTmux: typeof LaunchInTmux;
  handOff: (plan: LaunchExecPlan) => Promise<void>;
  /** Native path deps — optional so existing tmux/hand-off-only call sites and tests need no changes. */
  claudeBgAvailable?: boolean;
  launchClaudeBg?: typeof LaunchClaudeBg;
}

/** Native-launch context, when the selection's agent might be eligible for `--bg`. */
export interface NativeLaunchInput {
  agent: AgentConfig;
  /** The `--name` value, e.g. `"<project>/<assignment>"` (design spec §5.6) — distinct from the tmux session name. */
  name: string;
}

/**
 * Launch degradation, in priority order:
 *  1. Native `claude --bg`, when `native` is supplied AND `deps.claudeBgAvailable`
 *     AND the agent resolves to the claude runner AND Task 6's eligibility
 *     guards pass (not shell-alias-wrapped, no `-p`/`--print`). A failed `--bg`
 *     spawn is caught and falls through to tmux/hand-off below rather than
 *     surfacing as a bare launch failure — the resulting 'tmux'/'handoff'
 *     status is what the caller shows the user.
 *  2. tmux-available: launch detached into a named tmux session (Cockpit
 *     stays resident, session shows up in Live Sessions).
 *  3. In-process hand-off (the caller suspends the terminal, spawns the plan
 *     with inherited stdio, and exits the cockpit once the agent exits).
 * Kept side-effect-free besides the injected deps so this degradation matrix
 * is unit-testable without tmux, claude, Ink, or a real spawn.
 */
export async function runLaunch(
  sessionName: string,
  plan: LaunchExecPlan,
  deps: LaunchDeps,
  native?: NativeLaunchInput,
): Promise<'claude-bg' | 'tmux' | 'handoff'> {
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
    } catch {
      // Fall through to tmux/hand-off below — a failed --bg spawn degrades
      // exactly like native being ineligible, rather than aborting the launch.
    }
  }
  if (deps.tmuxAvailable) {
    await deps.launchInTmux({ sessionName, cwd: plan.cwd, command: plan.command, args: plan.args });
    return 'tmux';
  }
  await deps.handOff(plan);
  return 'handoff';
}

/**
 * How a spawned/attached child process ended, as reported by a Node child
 * 'exit'/'error' listener pair. Shared shape for both the tmux-attach child
 * (`runTmuxAttach`) and the hand-off agent child (Cockpit's `handOff`), so
 * their pass/fail decisions can share the same pure classification below
 * instead of duplicating ad hoc checks at each call site.
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
 * attach, where a normal `tmux detach-client` can legitimately report a
 * null code and still be a clean detach.
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
