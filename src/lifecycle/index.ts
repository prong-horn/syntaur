export type {
  TicketStatus,
  TransitionCommand,
  TicketFrontmatter,
  ExternalId,
  Workspace,
  TransitionResult,
} from './types.js';
export { TERMINAL_STATUSES, DEFAULT_STATUSES, DEFAULT_COMMANDS, DEFAULT_TERMINAL_STATUSES } from './types.js';
export { canTransition, getTargetStatus, isTerminalStatus, DEFAULT_TRANSITION_TABLE, DEFAULT_COMMAND_TARGETS, buildTransitionTable, buildCommandTargets, unambiguousCommandTarget } from './state-machine.js';
export { parseTicketFrontmatter, updateTicketFile, updateTicketWorkspace } from './frontmatter.js';
/** @deprecated Dashboard compat until Task 2 */
export {
  parseTicketFrontmatter as parseAssignmentFrontmatter,
  updateTicketFile as updateAssignmentFile,
  updateTicketWorkspace as updateAssignmentWorkspace,
} from './frontmatter.js';
export type { TicketFrontmatter as AssignmentFrontmatter } from './types.js';
export { executeTransition, executeAssign, executeTransitionByDir, executeAssignByDir, executeUnassign, executeUnassignByDir } from './transitions.js';
export type { TransitionOptions, TransitionByDirOptions } from './transitions.js';
