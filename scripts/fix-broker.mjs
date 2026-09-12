#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const f = 'src/chat/broker.ts';
let c = readFileSync(f, 'utf8');

const reps = [
  [/import type \{ ResolvedTicket \}/g, 'import type { ResolvedTicket }'],
  [/from '\.\.\/utils\/ticket-resolver\.js'/g, "from '../utils/ticket-resolver.js'"],
  [/ResolvedTicket/g, 'ResolvedTicket'],
  [/ticketScopeKey/g, 'ticketScopeKey'],
  [/ticketScopes/g, 'ticketScopes'],
  [/ticketScope\(/g, 'ticketScope('],
  [/ensureTicketSessions/g, 'ensureTicketSessions'],
  [/touchedTickets/g, 'touchedTickets'],
  [/session\.ticket/g, 'session.ticket'],
  [/TicketScope/g, 'TicketScope'],
  [/interface Session \{\n  key: string;\n  ticket: ResolvedTicket/g,
   'interface Session {\n  key: string;\n  ticket: ResolvedTicket'],
  [/existing\.ticket = ticket/g, 'existing.ticket = ticket'],
  [/export function ticketScopeKey/g, 'export function ticketScopeKey'],
  [/\bticketId\b/g, 'ticketId'],
  [/\bticketDir\b/g, 'ticketDir'],
  [/\bticketSlug\b/g, 'ticketSlug'],
  [/\bticketRef\b/g, 'ticketRef'],
  [/\bticket\.ticketDir\b/g, 'ticket.ticketDir'],
  [/\bticket\.id\b/g, 'ticket.id'],
  [/\(ticket: ResolvedTicket\)/g, '(ticket: ResolvedTicket)'],
  [/function ticketScope\(ticket:/g, 'function ticketScope(ticket:'],
  [/async function routingContext\(ticket:/g, 'async function routingContext(ticket:'],
  [/async function ensureTicketSessions\(ticket:/g, 'async function ensureTicketSessions(ticket:'],
  [/withdraw\(ticket:/g, 'withdraw(ticket:'],
  [/cancel\(ticket:/g, 'cancel(ticket:'],
  [/items\(ticket:/g, 'items(ticket:'],
  [/reindex\(ticket:/g, 'reindex(ticket:'],
  [/\bticket: ResolvedTicket,\n    definition/g, 'ticket: ResolvedTicket,\n    definition'],
];

for (const [pat, rep] of reps) c = c.replace(pat, rep);

// Keep scope key literal per Phase A plan
c = c.replace(/`\\$\\{ticketId\\}:@ticket`/g, '`${ticketId}:@ticket`');
c = c.replace(/return `\\$\\{ticketId\\}:@ticket`;/g, 'return `${ticketId}:@ticket`;');

// Fix any double-renames
c = c.replace(/ticketScopeKey\(ticket\.id\)/g, 'ticketScopeKey(ticket.id)');

writeFileSync(f, c);
console.log('broker fixed');
