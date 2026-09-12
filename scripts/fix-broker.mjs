#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const f = 'src/chat/broker.ts';
let c = readFileSync(f, 'utf8');

const reps = [
  [/import type \{ ResolvedAssignment \}/g, 'import type { ResolvedTicket }'],
  [/from '\.\.\/utils\/assignment-resolver\.js'/g, "from '../utils/ticket-resolver.js'"],
  [/ResolvedAssignment/g, 'ResolvedTicket'],
  [/assignmentScopeKey/g, 'ticketScopeKey'],
  [/assignmentScopes/g, 'ticketScopes'],
  [/assignmentScope\(/g, 'ticketScope('],
  [/ensureAssignmentSessions/g, 'ensureTicketSessions'],
  [/touchedAssignments/g, 'touchedTickets'],
  [/session\.assignment/g, 'session.ticket'],
  [/AssignmentScope/g, 'TicketScope'],
  [/interface Session \{\n  key: string;\n  assignment: ResolvedTicket/g,
   'interface Session {\n  key: string;\n  ticket: ResolvedTicket'],
  [/existing\.assignment = assignment/g, 'existing.ticket = ticket'],
  [/export function assignmentScopeKey/g, 'export function ticketScopeKey'],
  [/\bassignmentId\b/g, 'ticketId'],
  [/\bassignmentDir\b/g, 'ticketDir'],
  [/\bassignmentSlug\b/g, 'ticketSlug'],
  [/\bassignmentRef\b/g, 'ticketRef'],
  [/\bassignment\.ticketDir\b/g, 'ticket.ticketDir'],
  [/\bassignment\.id\b/g, 'ticket.id'],
  [/\(assignment: ResolvedTicket\)/g, '(ticket: ResolvedTicket)'],
  [/function ticketScope\(assignment:/g, 'function ticketScope(ticket:'],
  [/async function routingContext\(assignment:/g, 'async function routingContext(ticket:'],
  [/async function ensureTicketSessions\(assignment:/g, 'async function ensureTicketSessions(ticket:'],
  [/withdraw\(assignment:/g, 'withdraw(ticket:'],
  [/cancel\(assignment:/g, 'cancel(ticket:'],
  [/items\(assignment:/g, 'items(ticket:'],
  [/reindex\(assignment:/g, 'reindex(ticket:'],
  [/\bticket: ResolvedTicket,\n    definition/g, 'ticket: ResolvedTicket,\n    definition'],
];

for (const [pat, rep] of reps) c = c.replace(pat, rep);

// Keep scope key literal per Phase A plan
c = c.replace(/`\\$\\{ticketId\\}:@ticket`/g, '`${ticketId}:@assignment`');
c = c.replace(/return `\\$\\{ticketId\\}:@ticket`;/g, 'return `${ticketId}:@assignment`;');

// Fix any double-renames
c = c.replace(/ticketScopeKey\(ticket\.id\)/g, 'ticketScopeKey(ticket.id)');

writeFileSync(f, c);
console.log('broker fixed');
