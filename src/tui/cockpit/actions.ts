import type { DetailSelection } from './DetailPane.js';
import type { Action } from './actionBarLayout.js';
import type { launchInTmux as LaunchInTmux } from '../tmux/launch.js';
import type { AgentLaunchPlan } from '../../launch/build-launch.js';

export interface ActionCallbacks {
  onLaunch: () => void;
  onAttach: () => void;
  onQuit: () => void;
}

/**
 * Pure enable/disable + wiring for the cockpit's context-sensitive action
 * bar, extracted out of Cockpit.tsx so the enable/disable matrix is
 * unit-testable without rendering (Ink strips dimColor/color from a
 * non-TTY `lastFrame()`, so a render-only test can't distinguish enabled
 * from disabled buttons).
 *
 * Enable rules mirror Task 15's nullability guards: Launch needs a
 * project-nested assignment selection (non-null `projectSlug` --
 * `launchAgent`/`getAssignmentDetail` require it); Attach needs a LIVE
 * session (`session.isLive === true` -- the rail also lists dead sessions,
 * and `tmux attach-session` against a dead session's name is a foot-gun)
 * with tmux available and a non-null `assignmentSlug` (the tmux session
 * name is derived from project+assignment slugs) -- this is also the app's
 * graceful-degradation rule: no tmux ⇒ Attach is disabled, but Launch stays
 * enabled and degrades to an in-process hand-off (see runLaunch). Quit is
 * always enabled.
 */
export function buildActions(
  selection: DetailSelection,
  tmuxAvailable: boolean,
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
      enabled:
        selection.kind === 'session' &&
        tmuxAvailable &&
        selection.session.isLive === true &&
        selection.session.assignmentSlug != null,
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
}

/**
 * Launch degradation: tmux-available means launch detached into a named tmux
 * session (Cockpit stays resident, session shows up in Live Sessions);
 * otherwise fall back to an in-process hand-off (the caller suspends the
 * terminal, spawns the plan with inherited stdio, and exits the cockpit once
 * the agent exits). Kept side-effect-free besides the two injected deps so
 * this degradation matrix is unit-testable without tmux, Ink, or a real spawn.
 */
export async function runLaunch(
  sessionName: string,
  plan: LaunchExecPlan,
  deps: LaunchDeps,
): Promise<'tmux' | 'handoff'> {
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
