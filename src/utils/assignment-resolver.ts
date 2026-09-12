/** @deprecated Task 1 compat shim — use ticket-resolver.js */
export {
  resolveTicketById,
  resolveTicketBySlug,
  resolveTicketById as resolveAssignmentById,
  resolveTicketBySlug as resolveAssignmentBySlug,
  type ResolvedTicket,
  type ResolvedTicketBySlug,
  type ResolvedTicket as ResolvedAssignment,
  type ResolvedTicketBySlug as ResolvedAssignmentBySlug,
} from './ticket-resolver.js';
