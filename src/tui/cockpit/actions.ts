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
 * `launchAgent`/`getAssignmentDetail` require it); Attach needs a live
 * session with tmux available and a non-null `assignmentSlug` (the tmux
 * session name is derived from project+assignment slugs) -- this is also
 * the app's graceful-degradation rule: no tmux ⇒ Attach is disabled, but
 * Launch stays enabled and degrades to an in-process hand-off (see runLaunch).
 * Quit is always enabled.
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
      enabled: selection.kind === 'session' && tmuxAvailable && selection.session.assignmentSlug != null,
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
