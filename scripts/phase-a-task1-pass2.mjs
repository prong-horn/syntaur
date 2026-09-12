#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'fixtures', 'dashboard']);
const SKIP_FILES = new Set([
  'migrate-workflows.ts', 'migrate-statuses.ts', 'migrate-status-history.ts',
  'migrate-events.ts', 'migrate-derive.ts',
  'install-skills.ts', 'codex-agents.ts', 'cursor-rules.ts', 'opencode-config.ts', 'help.ts',
]);

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP_DIRS.has(name)) continue;
    if (relative(ROOT, p).includes('/fixtures/')) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (/\.(ts|tsx|sh)$/.test(name) && !SKIP_FILES.has(name)) files.push(p);
  }
  return files;
}

const REPLACEMENTS = [
  ['ResolvedAssignmentBySlug', 'ResolvedTicketBySlug'],
  ['ResolvedAssignment', 'ResolvedTicket'],
  ['ResolvedAssignmentView', 'ResolvedTicketView'],
  ['AssignmentScope', 'TicketScope'],
  ['assignmentScopeKey', 'ticketScopeKey'],
  ['assignmentScopes', 'ticketScopes'],
  ['assignmentScope(', 'ticketScope('],
  ['ensureAssignmentSessions', 'ensureTicketSessions'],
  ['touchedAssignments', 'touchedTickets'],
  ['session.assignment', 'session.ticket'],
  ['(assignment: ResolvedTicket)', '(ticket: ResolvedTicket)'],
  ['(assignment: ResolvedTicket,', '(ticket: ResolvedTicket,'],
  ['function ticketScope(assignment:', 'function ticketScope(ticket:'],
  ['async function routingContext(assignment:', 'async function routingContext(ticket:'],
  ['async function ensureTicketSessions(assignment:', 'async function ensureTicketSessions(ticket:'],
  ['assignmentScope(assignment)', 'ticketScope(ticket)'],
  ['assignmentScope(session.ticket)', 'ticketScope(session.ticket)'],
  ['await assignmentScope(', 'await ticketScope('],
  ['assignmentSlug', 'ticketSlug'],
  ['assignmentDir', 'ticketDir'],
  // Remaining identifier patterns
  ['assignment-resolver', 'ticket-resolver'],
  ['assignment-target', 'ticket-target'],
  ['assignment-walk', 'ticket-walk'],
  ['createAssignment', 'createTicket'],
  ['listAssignment', 'listTicket'],
  ['getAssignment', 'getTicket'],
  ['findAssignment', 'findTicket'],
  ['loadAssignment', 'loadTicket'],
  ['readAssignment', 'readTicket'],
  ['writeAssignment', 'writeTicket'],
  ['openAssignment', 'openTicket'],
  ['activeAssignment', 'activeTicket'],
  ['currentAssignment', 'currentTicket'],
  ['targetAssignment', 'targetTicket'],
  ['selectedAssignment', 'selectedTicket'],
  ['nestedAssignment', 'nestedTicket'],
  ['standaloneAssignment', 'standaloneTicket'],
  ['sourceAssignment', 'sourceTicket'],
  ['linkedAssignment', 'linkedTicket'],
  ['parentAssignment', 'parentTicket'],
  ['childAssignment', 'childTicket'],
  ['byAssignment', 'byTicket'],
  ['forAssignment', 'forTicket'],
  ['perAssignment', 'perTicket'],
  ['allAssignments', 'allTickets'],
  ['noAssignments', 'noTickets'],
  ['hasAssignment', 'hasTicket'],
  ['isAssignment', 'isTicket'],
  ['checkAssignment', 'checkTicket'],
  ['validateAssignment', 'validateTicket'],
  ['formatAssignment', 'formatTicket'],
  ['parseAssignment', 'parseTicket'],
  ['updateAssignment', 'updateTicket'],
  ['deleteAssignment', 'deleteTicket'],
  ['archiveAssignment', 'archiveTicket'],
  ['restoreAssignment', 'restoreTicket'],
  ['completeAssignment', 'completeTicket'],
  ['startAssignment', 'startTicket'],
  ['shapeAssignment', 'shapeTicket'],
  ['planAssignment', 'planTicket'],
  ['grabAssignment', 'grabTicket'],
  ['clearAssignment', 'clearTicket'],
  ['reopenAssignment', 'reopenTicket'],
  ['failAssignment', 'failTicket'],
  ['blockAssignment', 'blockAssignment'], // noop guard
  ['assignmentFilter', 'ticketFilter'],
  ['sortAssignments', 'sortTickets'],
  ['assignmentsPage', 'ticketsPage'],
  ['AssignmentsPage', 'TicketsPage'],
  ['AssignmentDetail', 'TicketDetail'],
  ['assignmentChat', 'ticketChat'],
  ['assignmentPath', 'ticketPath'],
  ['assignmentFile', 'ticketFile'],
  ['assignmentTitle', 'ticketTitle'],
  ['assignmentStatus', 'ticketStatus'],
  ['assignmentType', 'ticketType'],
  ['assignmentWorkflow', 'ticketWorkflow'],
  ['assignmentBoard', 'ticketBoard'],
  ['assignmentCount', 'ticketCount'],
  ['assignmentList', 'ticketList'],
  ['assignmentRef', 'ticketRef'],
  ['assignmentKey', 'ticketKey'],
  ['assignmentName', 'ticketName'],
  ['assignmentLabel', 'ticketLabel'],
  ['assignmentHref', 'ticketHref'],
  ['assignmentUrl', 'ticketUrl'],
  ['assignmentRoute', 'ticketRoute'],
  ['assignmentId', 'ticketId'],
  // Parameter names in common patterns
  ['(assignment, ', '(ticket, '],
  ['(assignment)', '(ticket)'],
  [', assignment)', ', ticket)'],
  [', assignment,', ', ticket,'],
  [' assignment)', ' ticket)'],
  [' assignment,', ' ticket,'],
  [' assignment:', ' ticket:'],
  [' assignment ', ' ticket '],
  [' assignment\n', ' ticket\n'],
  [' assignment.', ' ticket.'],
  [' assignment?', ' ticket?'],
  [' assignment;', ' ticket;'],
  [' assignment]', ' ticket]'],
  ['{ assignment }', '{ ticket }'],
  ['{ assignment,', '{ ticket,'],
  ['= assignment', '= ticket'],
  ['const assignment =', 'const ticket ='],
  ['let assignment =', 'let ticket ='],
  ['async (assignment', 'async (ticket'],
  ['function (assignment', 'function (ticket'],
];

const paths = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'statusline'))];

let changed = 0;
for (const file of paths) {
  if (file.includes('/dashboard/') || file.includes('/fixtures/')) continue;
  let content = readFileSync(file, 'utf8');
  const orig = content;
  for (const [from, to] of REPLACEMENTS) {
    content = content.split(from).join(to);
  }
  if (content !== orig) {
    writeFileSync(file, content);
    changed++;
  }
}

console.log(`Pass 2 updated ${changed} files`);
