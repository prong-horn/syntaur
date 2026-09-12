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
  ['assignmentSlug', 'ticketSlug'],
  ['assignmentPath', 'ticketPath'],
  ['assignmentRef', 'ticketRef'],
  ['.assignmentDir', '.ticketDir'],
  ['assignment: fm', 'ticket: fm'],
  ['assignment,', 'ticket,'],
  ['{ assignment }', '{ ticket }'],
  ['assignment }', 'ticket }'],
  ['assignment:', 'ticket:'],
  ['updateAssignmentFile', 'updateTicketFile'],
  ['parseAssignmentFrontmatter', 'parseTicketFrontmatter'],
  ['resolveAssignmentById', 'resolveTicketById'],
  ['resolveAssignmentBySlug', 'resolveTicketBySlug'],
  ['getAssignmentDetailById', 'getTicketDetailById'],
  ['listAssignmentsBoard', 'listTicketsBoard'],
  ['assignment-updated', 'ticket-updated'],
  ['AssignmentUpdated', 'TicketUpdated'],
  ['AssignmentBoardItem', 'TicketBoardItem'],
  ['AssignmentDetail', 'TicketDetail'],
  ['AssignmentSummary', 'TicketSummary'],
  ['assignments/', 'tickets/'],
  ['assignment.md', 'ticket.md'],
  ["'assignments'", "'tickets'"],
  ['assignmentsDir', 'ticketsDir'],
];

// Don't touch SQL column string literals
function safeReplace(content) {
  let c = content;
  for (const [a, b] of REPS) c = c.split(a).join(b);
  // Restore DB column names
  c = c.replace(/\bticket_id\b/g, 'assignment_id');
  c = c.replace(/\bticket_slug\b/g, 'assignment_slug');
  return c;
}

let n = 0;
for (const f of walk(ROOT)) {
  const orig = readFileSync(f, 'utf8');
  const next = safeReplace(orig);
  if (next !== orig) { writeFileSync(f, next); n++; }
}
console.log(`dashboard: ${n} files`);
