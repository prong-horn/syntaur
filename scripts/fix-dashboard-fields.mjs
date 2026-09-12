#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'src', 'dashboard');

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (name.endsWith('.ts')) files.push(p);
  }
  return files;
}

const REPS = [
  ['ticketSlug', 'ticketSlug'],
  ['ticketPath', 'ticketPath'],
  ['ticketRef', 'ticketRef'],
  ['.ticketDir', '.ticketDir'],
  ['ticket: fm', 'ticket: fm'],
  ['ticket,', 'ticket,'],
  ['{ ticket }', '{ ticket }'],
  ['ticket }', 'ticket }'],
  ['ticket:', 'ticket:'],
  ['updateTicketFile', 'updateTicketFile'],
  ['parseTicketFrontmatter', 'parseTicketFrontmatter'],
  ['resolveTicketById', 'resolveTicketById'],
  ['resolveTicketBySlug', 'resolveTicketBySlug'],
  ['getTicketDetailById', 'getTicketDetailById'],
  ['listTicketsBoard', 'listTicketsBoard'],
  ['ticket-updated', 'ticket-updated'],
  ['TicketUpdated', 'TicketUpdated'],
  ['TicketBoardItem', 'TicketBoardItem'],
  ['TicketDetail', 'TicketDetail'],
  ['TicketSummary', 'TicketSummary'],
  ['tickets/', 'tickets/'],
  ['ticket.md', 'ticket.md'],
  ["'tickets'", "'tickets'"],
  ['ticketsDir', 'ticketsDir'],
];

// Don't touch SQL column string literals
function safeReplace(content) {
  let c = content;
  for (const [a, b] of REPS) c = c.split(a).join(b);
  // Restore DB column names
  c = c.replace(/\bticket_id\b/g, 'assignment_id');
  c = c.replace(/\bticket_slug\b/g, 'ticket_slug');
  return c;
}

let n = 0;
for (const f of walk(ROOT)) {
  const orig = readFileSync(f, 'utf8');
  const next = safeReplace(orig);
  if (next !== orig) { writeFileSync(f, next); n++; }
}
console.log(`dashboard: ${n} files`);
