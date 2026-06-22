import type { AssignmentStatus, TransitionCommand } from './types.js';
import { TERMINAL_STATUSES } from './types.js';

/**
 * Maps a command to its target status. Commands always produce the same
 * target regardless of the current status — workflow enforcement is
 * handled via agent prompting, not code guards.
 */
export const DEFAULT_COMMAND_TARGETS = new Map<string, string>([
  ['start', 'in_progress'],
  ['shape', 'ready_for_planning'],
  ['plan-ready', 'ready_to_implement'],
  ['implement', 'in_progress'],
  ['block', 'blocked'],
  ['unblock', 'in_progress'],
  ['review', 'review'],
  ['complete', 'completed'],
  ['fail', 'failed'],
  ['reopen', 'in_progress'],
]);

/**
 * Built-in `from:command` → `to` map for the default (no custom config) status
 * set. Used by the dashboard to guard which transitions are valid from a given
 * status (see getTargetStatus when a table is passed). The CLI transition path
 * passes no table and stays guard-free via DEFAULT_COMMAND_TARGETS.
 */
export const DEFAULT_TRANSITION_TABLE = new Map<string, string>([
  ['pending:start', 'in_progress'],
  ['pending:block', 'blocked'],
  ['draft:shape', 'ready_for_planning'],
  ['draft:start', 'in_progress'],
  ['ready_for_planning:plan-ready', 'ready_to_implement'],
  ['ready_for_planning:start', 'in_progress'],
  ['ready_to_implement:implement', 'in_progress'],
  ['in_progress:block', 'blocked'],
  ['in_progress:review', 'review'],
  ['in_progress:complete', 'completed'],
  ['in_progress:fail', 'failed'],
  ['blocked:unblock', 'in_progress'],
  ['review:start', 'in_progress'],
  ['review:complete', 'completed'],
  ['review:fail', 'failed'],
  ['completed:reopen', 'in_progress'],
  ['failed:reopen', 'in_progress'],
]);

export function buildTransitionTable(
  transitions: Array<{ from: string; command: string; to: string }>,
): Map<string, string> {
  const table = new Map<string, string>();
  for (const t of transitions) {
    table.set(`${t.from}:${t.command}`, t.to);
  }
  return table;
}

export function buildCommandTargets(
  transitions: Array<{ from: string; command: string; to: string }>,
): Map<string, string> {
  const targets = new Map<string, string>();
  for (const t of transitions) {
    targets.set(t.command, t.to);
  }
  return targets;
}

export function getTargetStatus(
  _from: AssignmentStatus,
  command: TransitionCommand,
  table?: Map<string, string>,
): AssignmentStatus | null {
  // No table provided (e.g. the CLI transition path): commands are guard-free —
  // workflow enforcement happens via agent prompting, not code — so a command
  // resolves to its canonical target regardless of the current status.
  if (!table) {
    return DEFAULT_COMMAND_TARGETS.get(command) ?? null;
  }
  // A table was provided (the dashboard passes one — custom, or the built-in
  // DEFAULT_TRANSITION_TABLE): honor `from:command` so only transitions valid
  // from the current status resolve. The kanban inline picker renders these
  // directly and must not offer e.g. `start` on an in_progress card. Look up the
  // status-specific `from:command` key FIRST so a per-status guard always wins;
  // the bare-command key is only a defensive fallback (no current table emits
  // one — DEFAULT_TRANSITION_TABLE and buildTransitionTable() key by
  // `from:command`). The old bare-first order would have let a future bare entry
  // silently override the status-specific guard.
  return table.get(`${_from}:${command}`) ?? table.get(command) ?? null;
}

/** @deprecated Guards removed — always returns true for known commands */
export function canTransition(
  _from: AssignmentStatus,
  command: TransitionCommand,
  table?: Map<string, string>,
): boolean {
  return getTargetStatus(_from, command, table) !== null;
}

export function isTerminalStatus(
  status: AssignmentStatus,
  terminalSet?: ReadonlySet<string>,
): boolean {
  return (terminalSet ?? TERMINAL_STATUSES).has(status);
}
