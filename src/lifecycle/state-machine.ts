import type { AssignmentStatus, TransitionCommand } from './types.js';
import { TERMINAL_STATUSES } from './types.js';

const TRANSITION_TABLE = new Map<string, AssignmentStatus>([
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

function transitionKey(from: AssignmentStatus, command: TransitionCommand): string {
  return `${from}:${command}`;
}

export function canTransition(from: AssignmentStatus, command: TransitionCommand): boolean {
  return TRANSITION_TABLE.has(transitionKey(from, command));
}

export function getTargetStatus(
  from: AssignmentStatus,
  command: TransitionCommand,
): AssignmentStatus | null {
  return TRANSITION_TABLE.get(transitionKey(from, command)) ?? null;
}

export function isTerminalStatus(status: AssignmentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
