#!/usr/bin/env node
/**
 * Phase A Task 1 codemod: assignment → ticket in src/ (excl dashboard) + tests (excl fixtures) + statusline
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'fixtures', 'dashboard',
]);
const SKIP_FILES = new Set([
  // migrate commands keep v1 field name string literals
  'migrate-workflows.ts', 'migrate-statuses.ts', 'migrate-status-history.ts',
  'migrate-events.ts', 'migrate-derive.ts',
  // Task 4 scope
  'install-skills.ts', 'codex-agents.ts', 'cursor-rules.ts', 'opencode-config.ts', 'help.ts',
]);

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(ROOT, p);
    if (SKIP_DIRS.has(name)) continue;
    if (rel.startsWith('dashboard/')) continue;
    if (rel.includes('/fixtures/')) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (/\.(ts|tsx|sh|json)$/.test(name) && !SKIP_FILES.has(name)) files.push(p);
  }
  return files;
}

// Ordered replacements (longest/most specific first)
const REPLACEMENTS = [
  // Import paths (after git mv)
  ['assignment-resolver.js', 'ticket-resolver.js'],
  ['assignment-target.js', 'ticket-target.js'],
  ['assignment-walk.js', 'ticket-walk.js'],
  ['create-assignment.js', 'new.js'],
  ['templates/assignment.js', 'templates/ticket.js'],
  ['doctor/checks/assignment.js', 'doctor/checks/ticket.js'],

  // Types and interfaces
  ['ResolveAssignmentWorkflowContextInput', 'ResolveTicketWorkflowContextInput'],
  ['resolveAssignmentWorkflowContext', 'resolveTicketWorkflowContext'],
  ['resolveAssignmentWorkflowId', 'resolveTicketWorkflowId'],
  ['AssignmentBindingFields', 'TicketBindingFields'],
  ['AssignmentFrontmatter', 'TicketFrontmatter'],
  ['AssignmentStatus', 'TicketStatus'],
  ['CreateAssignmentOptions', 'NewTicketOptions'],
  ['CreateAssignmentResult', 'NewTicketResult'],
  ['createAssignmentCommand', 'newCommand'],

  // Functions
  ['parseAssignmentFrontmatter', 'parseTicketFrontmatter'],
  ['updateAssignmentWorkspace', 'updateTicketWorkspace'],
  ['updateAssignmentFile', 'updateTicketFile'],
  ['resolveAssignmentById', 'resolveTicketById'],
  ['resolveAssignmentBySlug', 'resolveTicketBySlug'],
  ['resolveAssignmentPath', 'resolveTicketPath'],
  ['resolveAssignmentTarget', 'resolveTicketTarget'],
  ['walkAssignments', 'walkTickets'],
  ['listAssignments', 'listTickets'],
  ['renderAssignment', 'renderTicket'],
  ['assignmentsDir', 'ticketsDir'],
  ['assignmentsDirFn', 'ticketsDirFn'],

  // File/path literals
  ['_index-assignments.md', '_index-tickets.md'],
  ['assignment.md', 'ticket.md'],

  // Context json fields
  ['assignmentSlug', 'ticketSlug'],
  ['assignmentDir', 'ticketDir'],

  // Variables (after compound names)
  ['assignmentId', 'ticketId'],
  ['assignmentPath', 'ticketPath'],
  ['assignmentWorkflow', 'ticketWorkflow'],
  ['assignmentType', 'ticketType'],

  // CLI
  ['create-assignment', 'new'],
  ['<assignment>', '<ticket>'],
  ['--assignment', '--ticket'],

  // Path segments and JSON keys
  ["'assignments'", "'tickets'"],
  ['"assignments"', '"tickets"'],
  ['assignments/', 'tickets/'],

  // Sidecar frontmatter key (after assignmentId etc)
  ['\nassignment:', '\nticket:'],
  [" assignment:", " ticket:"],

  // Statusline segment name
  ['"assignment"', '"ticket"'],
  ["'assignment'", "'ticket'"],

  // User-facing noun in messages (careful - do after identifiers)
  ['Assignment "', 'Ticket "'],
  ['assignment "', 'ticket "'],
  ['an assignment', 'a ticket'],
  ['An assignment', 'A ticket'],
  ['the assignment', 'the ticket'],
  ['The assignment', 'The ticket'],
  ['assignment state', 'ticket state'],
  ['assignment slug', 'ticket slug'],
  ['Assignment slug', 'Ticket slug'],
  ['assignment title', 'ticket title'],
  ['Assignment title', 'Ticket title'],
  ['active assignment', 'active ticket'],
  ['Active assignment', 'Active ticket'],
  ['target assignment', 'target ticket'],
  ['Target assignment', 'Target ticket'],
  ['standalone assignment', 'standalone ticket'],
  ['Standalone assignment', 'Standalone ticket'],
  ['linked assignment', 'linked ticket'],
  ['source assignment', 'source ticket'],
  ['Source assignment', 'Source ticket'],
  ['source-assignments', 'source-tickets'],
  ['project-nested assignment', 'project-nested ticket'],
  ['for assignment', 'for ticket'],
  ['to assignment', 'to ticket'],
  ['on assignment', 'on ticket'],
  ['per assignment', 'per ticket'],
  ['each assignment', 'each ticket'],
  ['every assignment', 'every ticket'],
  ['no assignment', 'no ticket'],
  ['No assignment', 'No ticket'],
  ['assignment folder', 'ticket folder'],
  ['assignment file', 'ticket file'],
  ['assignment tree', 'ticket tree'],
  ['assignment board', 'ticket board'],
  ['assignment chat', 'ticket chat'],
  ['assignment lifecycle', 'ticket lifecycle'],
  ['assignment status', 'ticket status'],
  ['assignment type', 'ticket type'],
  ['assignment workflow', 'ticket workflow'],
  ['assignment directory', 'ticket directory'],
  ['assignment UUID', 'ticket UUID'],
  ['assignment id', 'ticket id'],
  ['assignment IDs', 'ticket IDs'],
  ['assignment ids', 'ticket ids'],
  ['Assignment IDs', 'Ticket IDs'],
  ['Assignment ID', 'Ticket ID'],
  ['assignment ID', 'ticket ID'],
  ['Assignment type', 'Ticket type'],
  ['Assignment workflow', 'Ticket workflow'],
  ['Assignment status', 'Ticket status'],
  ['Assignment directory', 'Ticket directory'],
  ['Assignment folder', 'Ticket folder'],
  ['Assignment file', 'Ticket file'],
  ['Assignment UUID', 'Ticket UUID'],
  ['Assignment chat', 'Ticket chat'],
  ['Assignment board', 'Ticket board'],
  ['Assignment lifecycle', 'Ticket lifecycle'],
  ['Add a task', 'Add a ticket'],
  ['Add login', 'Add login'], // no-op safeguard
  ['grab one', 'grab one'], // no-op
];

// Paths to process
const paths = [
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'statusline')),
];

let changed = 0;
for (const file of paths) {
  if (file.includes('/dashboard/')) continue;
  if (file.includes('/fixtures/')) continue;
  let content = readFileSync(file, 'utf8');
  const orig = content;
  for (const [from, to] of REPLACEMENTS) {
    content = content.split(from).join(to);
  }
  // assignmentsDir function name in paths.ts
  if (content.includes('function assignmentsDir')) {
    content = content.replace(/function assignmentsDir/g, 'function ticketsDir');
  }
  if (content !== orig) {
    writeFileSync(file, content);
    changed++;
  }
}

console.log(`Updated ${changed} files`);
