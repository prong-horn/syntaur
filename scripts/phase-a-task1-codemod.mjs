#!/usr/bin/env node
/**
 * Phase A Task 1 codemod: ticket → ticket in src/ (excl dashboard) + tests (excl fixtures) + statusline
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
  ['ticket-resolver.js', 'ticket-resolver.js'],
  ['ticket-target.js', 'ticket-target.js'],
  ['ticket-walk.js', 'ticket-walk.js'],
  ['create-ticket.js', 'new.js'],
  ['templates/ticket.js', 'templates/ticket.js'],
  ['doctor/checks/ticket.js', 'doctor/checks/ticket.js'],

  // Types and interfaces
  ['ResolveTicketWorkflowContextInput', 'ResolveTicketWorkflowContextInput'],
  ['resolveTicketWorkflowContext', 'resolveTicketWorkflowContext'],
  ['resolveTicketWorkflowId', 'resolveTicketWorkflowId'],
  ['TicketBindingFields', 'TicketBindingFields'],
  ['TicketFrontmatter', 'TicketFrontmatter'],
  ['TicketStatus', 'TicketStatus'],
  ['CreateTicketOptions', 'NewTicketOptions'],
  ['CreateTicketResult', 'NewTicketResult'],
  ['createTicketCommand', 'newCommand'],

  // Functions
  ['parseTicketFrontmatter', 'parseTicketFrontmatter'],
  ['updateTicketWorkspace', 'updateTicketWorkspace'],
  ['updateTicketFile', 'updateTicketFile'],
  ['resolveTicketById', 'resolveTicketById'],
  ['resolveTicketBySlug', 'resolveTicketBySlug'],
  ['resolveTicketPath', 'resolveTicketPath'],
  ['resolveTicketTarget', 'resolveTicketTarget'],
  ['walkTickets', 'walkTickets'],
  ['listTickets', 'listTickets'],
  ['renderTicket', 'renderTicket'],
  ['ticketsDir', 'ticketsDir'],
  ['ticketsDirFn', 'ticketsDirFn'],

  // File/path literals
  ['_index-tickets.md', '_index-tickets.md'],
  ['ticket.md', 'ticket.md'],

  // Context json fields
  ['ticketSlug', 'ticketSlug'],
  ['ticketDir', 'ticketDir'],

  // Variables (after compound names)
  ['ticketId', 'ticketId'],
  ['ticketPath', 'ticketPath'],
  ['ticketWorkflow', 'ticketWorkflow'],
  ['ticketType', 'ticketType'],

  // CLI
  ['create-ticket', 'new'],
  ['<ticket>', '<ticket>'],
  ['--ticket', '--ticket'],

  // Path segments and JSON keys
  ["'tickets'", "'tickets'"],
  ['"tickets"', '"tickets"'],
  ['tickets/', 'tickets/'],

  // Sidecar frontmatter key (after ticketId etc)
  ['\nticket:', '\nticket:'],
  [" ticket:", " ticket:"],

  // Statusline segment name
  ['"ticket"', '"ticket"'],
  ["'ticket'", "'ticket'"],

  // User-facing noun in messages (careful - do after identifiers)
  ['Ticket "', 'Ticket "'],
  ['ticket "', 'ticket "'],
  ['an ticket', 'a ticket'],
  ['An ticket', 'A ticket'],
  ['the ticket', 'the ticket'],
  ['The ticket', 'The ticket'],
  ['ticket state', 'ticket state'],
  ['ticket slug', 'ticket slug'],
  ['Ticket slug', 'Ticket slug'],
  ['ticket title', 'ticket title'],
  ['Ticket title', 'Ticket title'],
  ['active ticket', 'active ticket'],
  ['Active ticket', 'Active ticket'],
  ['target ticket', 'target ticket'],
  ['Target ticket', 'Target ticket'],
  ['standalone ticket', 'standalone ticket'],
  ['Standalone ticket', 'Standalone ticket'],
  ['linked ticket', 'linked ticket'],
  ['source ticket', 'source ticket'],
  ['Source ticket', 'Source ticket'],
  ['source-tickets', 'source-tickets'],
  ['project-nested ticket', 'project-nested ticket'],
  ['for ticket', 'for ticket'],
  ['to ticket', 'to ticket'],
  ['on ticket', 'on ticket'],
  ['per ticket', 'per ticket'],
  ['each ticket', 'each ticket'],
  ['every ticket', 'every ticket'],
  ['no ticket', 'no ticket'],
  ['No ticket', 'No ticket'],
  ['ticket folder', 'ticket folder'],
  ['ticket file', 'ticket file'],
  ['ticket tree', 'ticket tree'],
  ['ticket board', 'ticket board'],
  ['ticket chat', 'ticket chat'],
  ['ticket lifecycle', 'ticket lifecycle'],
  ['ticket status', 'ticket status'],
  ['ticket type', 'ticket type'],
  ['ticket workflow', 'ticket workflow'],
  ['ticket directory', 'ticket directory'],
  ['ticket UUID', 'ticket UUID'],
  ['ticket id', 'ticket id'],
  ['ticket IDs', 'ticket IDs'],
  ['ticket ids', 'ticket ids'],
  ['Ticket IDs', 'Ticket IDs'],
  ['Ticket ID', 'Ticket ID'],
  ['ticket ID', 'ticket ID'],
  ['Ticket type', 'Ticket type'],
  ['Ticket workflow', 'Ticket workflow'],
  ['Ticket status', 'Ticket status'],
  ['Ticket directory', 'Ticket directory'],
  ['Ticket folder', 'Ticket folder'],
  ['Ticket file', 'Ticket file'],
  ['Ticket UUID', 'Ticket UUID'],
  ['Ticket chat', 'Ticket chat'],
  ['Ticket board', 'Ticket board'],
  ['Ticket lifecycle', 'Ticket lifecycle'],
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
  // ticketsDir function name in paths.ts
  if (content.includes('function ticketsDir')) {
    content = content.replace(/function ticketsDir/g, 'function ticketsDir');
  }
  if (content !== orig) {
    writeFileSync(file, content);
    changed++;
  }
}

console.log(`Updated ${changed} files`);
