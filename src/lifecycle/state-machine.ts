import type { AssignmentStatus, TransitionCommand } from './types.js';
import { TERMINAL_STATUSES } from './types.js';

/**
 * Maps a command to its target status. Commands always produce the same
 * target regardless of the current status — workflow enforcement is
 * handled via agent prompting, not code guards.
 */
export const DEFAULT_COMMAND_TARGETS = new Map<string, string>([
  ['start', 'in_progress'],
  ['block', 'blocked'],
  ['unblock', 'in_progress'],
  ['review', 'review'],
  ['complete', 'completed'],
  ['fail', 'failed'],
  ['reopen', 'in_progress'],
]);

/** @deprecated Transition guards removed — kept for API compat, always returns true */
export const DEFAULT_TRANSITION_TABLE = new Map<string, string>([
  ['pending:start', 'in_progress'],
  ['pending:block', 'blocked'],
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
  // Try command-only lookup first, fall back to from:command for backwards compat
  if (!table || table === DEFAULT_TRANSITION_TABLE) {
    return DEFAULT_COMMAND_TARGETS.get(command) ?? null;
  }
  // Custom table: try command-only key first, then from:command
  return table.get(command) ?? table.get(`${_from}:${command}`) ?? null;
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
