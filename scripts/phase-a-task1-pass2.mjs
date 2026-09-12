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
  ['ResolvedTicketBySlug', 'ResolvedTicketBySlug'],
  ['ResolvedTicket', 'ResolvedTicket'],
  ['ResolvedTicketView', 'ResolvedTicketView'],
  ['TicketScope', 'TicketScope'],
  ['ticketScopeKey', 'ticketScopeKey'],
  ['ticketScopes', 'ticketScopes'],
  ['ticketScope(', 'ticketScope('],
  ['ensureTicketSessions', 'ensureTicketSessions'],
  ['touchedTickets', 'touchedTickets'],
  ['session.ticket', 'session.ticket'],
  ['(ticket: ResolvedTicket)', '(ticket: ResolvedTicket)'],
  ['(ticket: ResolvedTicket,', '(ticket: ResolvedTicket,'],
  ['function ticketScope(ticket:', 'function ticketScope(ticket:'],
  ['async function routingContext(ticket:', 'async function routingContext(ticket:'],
  ['async function ensureTicketSessions(ticket:', 'async function ensureTicketSessions(ticket:'],
  ['ticketScope(ticket)', 'ticketScope(ticket)'],
  ['ticketScope(session.ticket)', 'ticketScope(session.ticket)'],
  ['await ticketScope(', 'await ticketScope('],
  ['ticketSlug', 'ticketSlug'],
  ['ticketDir', 'ticketDir'],
  // Remaining identifier patterns
  ['ticket-resolver', 'ticket-resolver'],
  ['ticket-target', 'ticket-target'],
  ['ticket-walk', 'ticket-walk'],
  ['createTicket', 'createTicket'],
  ['listTicket', 'listTicket'],
  ['getTicket', 'getTicket'],
  ['findTicket', 'findTicket'],
  ['loadTicket', 'loadTicket'],
  ['readTicket', 'readTicket'],
  ['writeTicket', 'writeTicket'],
  ['openTicket', 'openTicket'],
  ['activeTicket', 'activeTicket'],
  ['currentTicket', 'currentTicket'],
  ['targetTicket', 'targetTicket'],
  ['selectedTicket', 'selectedTicket'],
  ['nestedTicket', 'nestedTicket'],
  ['standaloneTicket', 'standaloneTicket'],
  ['sourceTicket', 'sourceTicket'],
  ['linkedTicket', 'linkedTicket'],
  ['parentTicket', 'parentTicket'],
  ['childTicket', 'childTicket'],
  ['byTicket', 'byTicket'],
  ['forTicket', 'forTicket'],
  ['perTicket', 'perTicket'],
  ['allTickets', 'allTickets'],
  ['noTickets', 'noTickets'],
  ['hasTicket', 'hasTicket'],
  ['isTicket', 'isTicket'],
  ['checkTicket', 'checkTicket'],
  ['validateTicket', 'validateTicket'],
  ['formatTicket', 'formatTicket'],
  ['parseTicket', 'parseTicket'],
  ['updateTicket', 'updateTicket'],
  ['deleteTicket', 'deleteTicket'],
  ['archiveTicket', 'archiveTicket'],
  ['restoreTicket', 'restoreTicket'],
  ['completeTicket', 'completeTicket'],
  ['startTicket', 'startTicket'],
  ['shapeTicket', 'shapeTicket'],
  ['planTicket', 'planTicket'],
  ['grabTicket', 'grabTicket'],
  ['clearTicket', 'clearTicket'],
  ['reopenTicket', 'reopenTicket'],
  ['failTicket', 'failTicket'],
  ['blockTicket', 'blockTicket'], // noop guard
  ['ticketFilter', 'ticketFilter'],
  ['sortTickets', 'sortTickets'],
  ['ticketsPage', 'ticketsPage'],
  ['TicketsPage', 'TicketsPage'],
  ['TicketDetail', 'TicketDetail'],
  ['ticketChat', 'ticketChat'],
  ['ticketPath', 'ticketPath'],
  ['ticketFile', 'ticketFile'],
  ['ticketTitle', 'ticketTitle'],
  ['ticketStatus', 'ticketStatus'],
  ['ticketType', 'ticketType'],
  ['ticketWorkflow', 'ticketWorkflow'],
  ['ticketBoard', 'ticketBoard'],
  ['ticketCount', 'ticketCount'],
  ['ticketList', 'ticketList'],
  ['ticketRef', 'ticketRef'],
  ['ticketKey', 'ticketKey'],
  ['ticketName', 'ticketName'],
  ['ticketLabel', 'ticketLabel'],
  ['ticketHref', 'ticketHref'],
  ['ticketUrl', 'ticketUrl'],
  ['ticketRoute', 'ticketRoute'],
  ['ticketId', 'ticketId'],
  // Parameter names in common patterns
  ['(ticket, ', '(ticket, '],
  ['(ticket)', '(ticket)'],
  [', ticket)', ', ticket)'],
  [', ticket,', ', ticket,'],
  [' ticket)', ' ticket)'],
  [' ticket,', ' ticket,'],
  [' ticket:', ' ticket:'],
  [' ticket ', ' ticket '],
  [' ticket\n', ' ticket\n'],
  [' ticket.', ' ticket.'],
  [' ticket?', ' ticket?'],
  [' ticket;', ' ticket;'],
  [' ticket]', ' ticket]'],
  ['{ ticket }', '{ ticket }'],
  ['{ ticket,', '{ ticket,'],
  ['= ticket', '= ticket'],
  ['const ticket =', 'const ticket ='],
  ['let ticket =', 'let ticket ='],
  ['async (ticket', 'async (ticket'],
  ['function (ticket', 'function (ticket'],
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
