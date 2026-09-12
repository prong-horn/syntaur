#!/usr/bin/env node
/**
 * Phase A commit 4: burn assignment noun residue in src, dashboard, tests,
 * platforms/codex, statusline, and helper scripts.
 *
 * Preserves allowed residue (restored after transforms):
 * - assignment_id / assignment_slug SQL + wire fields
 * - :@assignment scope key in broker.ts
 * - v1 path/field string literals in migrate-*.ts
 * - legacy frontmatter key 'assignment' in parser sidecar reader
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'fixtures', 'releases', 'superpowers']);
const MIGRATE_FILES = new Set([
  'migrate-workflows.ts',
  'migrate-statuses.ts',
  'migrate-status-history.ts',
  'migrate-events.ts',
  'migrate-derive.ts',
]);

const WIRE_FIELD_FILES = new Set([
  'dashboard/src/hooks/useTicketEvents.ts',
  'dashboard/src/hooks/useProjects.ts',
  'dashboard/src/pages/UsagePage.tsx',
]);

function shouldProcess(rel) {
  if (rel.includes('/fixtures/acp/')) return false;
  if (SKIP_DIRS.has(rel.split('/')[0])) return false;
  const roots = ['src/', 'dashboard/src/', 'platforms/codex/', 'statusline/', 'scripts/'];
  if (!roots.some((r) => rel.startsWith(r))) return false;
  if (!/\.(ts|tsx|sh|mjs)$/.test(rel)) return false;
  if (rel === 'scripts/phase-a-residue-codemod.mjs') return false;
  return true;
}

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(ROOT, p);
    if (SKIP_DIRS.has(name)) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (shouldProcess(rel)) files.push(p);
  }
  return files;
}

/** Ordered identifier / phrase replacements (longest first). */
const IDENT_REPLACEMENTS = [
  // Types / exports
  ['ParsedAssignmentFull', 'ParsedTicketFull'],
  ['ParsedAssignmentSummary', 'ParsedTicketSummary'],
  ['parseAssignmentFull', 'parseTicketFull'],
  ['parseAssignmentSummary', 'parseTicketSummary'],
  ['parseAssignmentComments', 'parseTicketComments'],
  ['parseAssignmentFrontmatter', 'parseTicketFrontmatter'],
  ['AssignmentRecord', 'TicketRecord'],
  ['AssignmentEntry', 'TicketEntry'],
  ['ArchivedAssignmentItem', 'ArchivedTicketItem'],
  ['AssignmentTransitionAction', 'TicketTransitionAction'],
  ['AssignmentReference', 'TicketReference'],
  ['AssignmentProgressEntry', 'TicketProgressEntry'],
  ['AssignmentProgress', 'TicketProgress'],
  ['AssignmentCommentEntry', 'TicketCommentEntry'],
  ['AssignmentComments', 'TicketComments'],
  ['AssignmentsBoardResponse', 'TicketsBoardResponse'],
  ['AssignmentFrontmatter', 'TicketFrontmatter'],
  ['AssignmentStatus', 'TicketStatus'],
  ['ASSIGNMENT_FIELDS', 'TICKET_FIELDS'],

  // Functions
  ['listAssignmentRecords', 'listTicketRecords'],
  ['listAssignmentsBoard', 'listTicketsBoard'],
  ['getAssignmentDetail', 'getTicketDetail'],
  ['getAssignmentDetailById', 'getTicketDetailById'],
  ['resolveAssignmentById', 'resolveTicketById'],
  ['resolveAssignmentBySlug', 'resolveTicketBySlug'],
  ['resolveAssignmentPath', 'resolveTicketPath'],
  ['resolveAssignmentTarget', 'resolveTicketTarget'],
  ['statusConfigForAssignment', 'statusConfigForTicket'],
  ['classifyAssignmentRecord', 'classifyTicketRecord'],
  ['findAssignmentStatus', 'findTicketStatus'],
  ['readAssignmentStatusFromPath', 'readTicketStatusFromPath'],
  ['readAssignmentStatus', 'readTicketStatus'],
  ['makeTicketDoc', 'makeTicketDoc'],
  ['toArchivedAssignmentItem', 'toArchivedTicketItem'],
  ['toAssignmentBoardItem', 'toTicketBoardItem'],
  ['activeAssignments', 'activeTickets'],
  ['totalAssignments', 'totalTickets'],
  ['visibleAssignments', 'visibleTickets'],
  ['inProgressAssignments', 'inProgressTickets'],
  ['blockedAssignments', 'blockedTickets'],
  ['reviewAssignments', 'reviewTickets'],
  ['failedAssignments', 'failedTickets'],
  ['staleAssignments', 'staleTickets'],
  ['onAssignmentChanged', 'onTicketChanged'],
  ['writeAssignmentMd', 'writeTicketMd'],
  ['makeAssignmentBroker', 'makeTicketBroker'],
  ['directAssignmentMd', 'directLegacyTicketMd'],
  ['updateAssignmentFile', 'updateTicketFile'],
  ['updateAssignmentWorkspace', 'updateTicketWorkspace'],
  ['listSessionsByAssignment', 'listSessionsByTicket'],
  ['recomputeAssignmentDir', 'recomputeTicketDir'],
  ['isEngineActiveForAssignment', 'isEngineActiveForTicket'],
  ['assignmentsToInvalidate', 'ticketsToInvalidate'],

  // Variables / fields
  ['withAssignmentMd', 'withTicketMd'],
  ['assignmentMdPath', 'ticketMdPath'],
  ['assignmentContent', 'ticketContent'],
  ['assignmentTitle', 'ticketTitle'],
  ['assignmentsDir', 'ticketsDir'],
  ['assignmentMd', 'ticketMd'],
  ['assignmentWorkflow', 'ticketWorkflow'],
  ['assignmentType', 'ticketType'],
  ['assignmentSummaries', 'ticketSummaries'],
  ['assignmentSlug', 'ticketSlug'],
  ['assignmentId', 'ticketId'],
  ['assignmentRef', 'ticketRef'],
  ['assignmentPath', 'ticketPath'],
  ['assignmentDir', 'ticketDir'],
  ['assignmentCount', 'ticketCount'],
  ['assignmentChat', 'ticketChat'],
  ['assignmentUpdated', 'ticketUpdated'],
  ['assignment_asc', 'ticket_asc'],
  ['ASSIGNMENT_DIR', 'TICKET_DIR'],
  ['ASSIGNMENT_SLUG', 'TICKET_SLUG'],
  ['ASSIGNMENT_SEG', 'TICKET_SEG'],

  // API / routes (comments + strings)
  ['/api/assignments', '/api/tickets'],
  ['GET /api/assignments', 'GET /api/tickets'],
  ['POST /api/assignments', 'POST /api/tickets'],
  ['PATCH /api/assignments', 'PATCH /api/tickets'],
  ['list-assignments', 'list-tickets'],

  // Doctor ids
  ['assignment.required-files-by-status', 'ticket.required-files-by-status'],
  ['assignment.required-files', 'ticket.required-files'],

  // Document / kind literals (not legacy frontmatter reader)
  ["kind: 'assignment'", "kind: 'ticket'"],
  ["type: 'assignment'", "type: 'ticket'"],
  ["=== 'assignment'", "=== 'ticket'"],
  ["| 'assignment'", "| 'ticket'"],
  ["'project' | 'assignment'", "'project' | 'ticket'"],
  ["GroupByMode = 'project' | 'assignment'", "GroupByMode = 'project' | 'ticket'"],
  ["q === 'assignment'", "q === 'ticket'"],
  ["summarize(rows, 'assignment')", "summarize(rows, 'ticket')"],
  ["documentType === 'assignment'", "documentType === 'ticket'"],
  ["getEditableDocumentById(projectsDir, ticketsDir, 'assignment'", "getEditableDocumentById(projectsDir, ticketsDir, 'ticket'"],
  ["'Edit Assignment:", "'Edit Ticket:"],
  ["case 'assignment':", "case 'ticket':"],
  ["ticketSlug || 'assignment'", "ticketSlug || 'ticket'"],

  // JSON response keys (property names)
  ['assignments:', 'tickets:'],
  ['assignments,', 'tickets,'],
  ['assignments)', 'tickets)'],
  ['assignments]', 'tickets]'],
  ['assignments ', 'tickets '],
  ['assignments\n', 'tickets\n'],
  ['assignments.', 'tickets.'],
  ['assignments/', 'tickets/'],
  ['{ assignments', '{ tickets'],
  ['(assignments', '(tickets'],

  // Loop vars
  ['for (const assignment of', 'for (const ticket of'],
  ['for (const assignment ', 'for (const ticket '],
  ['(assignment)', '(ticket)'],
  ['(assignment,', '(ticket,'],
  ['(assignment:', '(ticket:'],
  [' assignment)', ' ticket)'],
  [' assignment,', ' ticket,'],
  [' assignment:', ' ticket:'],
  [' assignment.', ' ticket.'],
  [' assignment ', ' ticket '],
  [' assignment\n', ' ticket\n'],
  ['= assignment', '= ticket'],
  ['const assignment =', 'const ticket ='],
  ['let assignment =', 'let ticket ='],
  ['async (assignment', 'async (ticket'],
  ['function (assignment', 'function (ticket'],

  // Comments / prose (common phrases)
  ['standalone assignments', 'standalone tickets'],
  ['Standalone assignments', 'Standalone tickets'],
  ['Standalone assignment', 'Standalone ticket'],
  ['standalone assignment', 'standalone ticket'],
  ['per-assignment', 'per-ticket'],
  ['Per-assignment', 'Per-ticket'],
  ['child assignments', 'child tickets'],
  ['source assignments', 'source tickets'],
  ['list assignments', 'list tickets'],
  ['List assignments', 'List tickets'],
  ['list source assignments', 'list source tickets'],
  ['Failed to list assignments', 'Failed to list tickets'],
  ['Failed to list source assignments', 'Failed to list source tickets'],
  ['Failed to get assignment', 'Failed to get ticket'],
  ['Error listing assignments', 'Error listing tickets'],
  ['Error getting assignment by id', 'Error getting ticket by id'],
  ['projects/assignments', 'projects/tickets'],
  ['create projects/assignments', 'create projects/tickets'],
  ['assignment-chat', 'ticket-chat'],
  ['assignment chat', 'ticket chat'],
  ['Assignment chat', 'Ticket chat'],
  ['assignment dir', 'ticket dir'],
  ['assignment directory', 'ticket directory'],
  ['assignment folder', 'ticket folder'],
  ['assignment file', 'ticket file'],
  ['assignment header', 'ticket header'],
  ['assignment scope', 'ticket scope'],
  ['assignment lifecycle', 'ticket lifecycle'],
  ['assignment board', 'ticket board'],
  ['assignment status', 'ticket status'],
  ['assignment slug', 'ticket slug'],
  ['assignment title', 'ticket title'],
  ['assignment type', 'ticket type'],
  ['assignment workflow', 'ticket workflow'],
  ['assignment UUID', 'ticket UUID'],
  ['assignment id', 'ticket id'],
  ['assignment IDs', 'ticket IDs'],
  ['assignment worktree', 'ticket worktree'],
  ['an assignment', 'a ticket'],
  ['An assignment', 'A ticket'],
  ['the assignment', 'the ticket'],
  ['The assignment', 'The ticket'],
  ['this assignment', 'this ticket'],
  ['This assignment', 'This ticket'],
  ['one assignment', 'one ticket'],
  ['One assignment', 'One ticket'],
  ['each assignment', 'each ticket'],
  ['Every assignment', 'Every ticket'],
  ['every assignment', 'every ticket'],
  ['all assignments', 'all tickets'],
  ['All assignments', 'All tickets'],
  ['no assignment', 'no ticket'],
  ['No assignment', 'No ticket'],
  ['active assignment', 'active ticket'],
  ['Active assignment', 'Active ticket'],
  ['target assignment', 'target ticket'],
  ['linked assignment', 'linked ticket'],
  ['source assignment', 'source ticket'],
  ['nested assignment', 'nested ticket'],
  ['archived assignment', 'archived ticket'],
  ['individually-archived assignments', 'individually-archived tickets'],
  ['individually-archived assignment', 'individually-archived ticket'],
  ['terminal assignments', 'terminal tickets'],
  ['terminal assignment', 'terminal ticket'],
  ['draft assignment', 'draft ticket'],
  ['failed assignments', 'failed tickets'],
  ['failed assignment', 'failed ticket'],
  ['completed assignment', 'completed ticket'],
  ['reopen a completed or failed assignment', 'reopen a completed or failed ticket'],
  ['Move a ready_to_implement assignment', 'Move a ready_to_implement ticket'],
  ['Promote a draft assignment', 'Promote a draft ticket'],
  ['Promote a ready_for_planning assignment', 'Promote a ready_for_planning ticket'],
  ['Mark the assignment', 'Mark the ticket'],
  ['assignment(s)', 'ticket(s)'],
  ['assignment.', 'ticket.'],
  ['assignments.', 'tickets.'],
  ['assignments,', 'tickets,'],
  ['assignments)', 'tickets)'],
  ['assignments]', 'tickets]'],
  ['assignments ', 'tickets '],
  ['assignments\n', 'tickets\n'],
  ['assignments/', 'tickets/'],
  ['assignments:', 'tickets:'],
  ['assignments', 'tickets'],
  ['assignment', 'ticket'],

  // Test describe / constants
  ['ASSIGNMENT_', 'TICKET_'],
  ['describe(\'assignment', "describe('ticket"],
  ['describe("assignment', 'describe("ticket'],
  ['it(\'assignment', "it('ticket"],
  ['it("assignment', 'it("ticket'],

  // Section headers in parser
  ['// --- Assignment Summary Parser ---', '// --- Ticket Summary Parser ---'],
  ['// --- Full Assignment Parser ---', '// --- Full Ticket Parser ---'],
  ['relatedAssignments', 'relatedTickets'],
];

function protectMigrateLiterals(content) {
  const placeholders = [];
  let i = 0;
  const patterns = [
    /'assignments\/[^']*'/g,
    /"assignments\/[^"]*"/g,
    /'assignments'/g,
    /"assignments"/g,
    /'assignment\.md'/g,
    /"assignment\.md"/g,
    /'assignment'/g,
    /"assignment"/g,
    /`assignments\/[^`]*`/g,
    /`assignment\.md`/g,
  ];
  let out = content;
  for (const pat of patterns) {
    out = out.replace(pat, (m) => {
      const key = `__MIGRATE_LITERAL_${i++}__`;
      placeholders.push([key, m]);
      return key;
    });
  }
  return { content: out, placeholders };
}

function restorePlaceholders(content, placeholders) {
  let out = content;
  for (const [key, val] of placeholders) {
    out = out.split(key).join(val);
  }
  return out;
}

function protectBrokerScopeKey(content) {
  return content.replace(/`(\$\{ticketId\}:)@assignment`/g, '`$1__BROKER_SCOPE_ASSIGNMENT__`');
}

function restoreBrokerScopeKey(content) {
  return content.replace(/`(\$\{ticketId\}:)__BROKER_SCOPE_ASSIGNMENT__`/g, '`$1@assignment`');
}

function protectLegacyFrontmatterReader(content) {
  return content.replace(
    /getField\(frontmatter, 'ticket'\) \?\? getField\(frontmatter, 'assignment'\)/g,
    "getField(frontmatter, 'ticket') ?? getField(frontmatter, '__LEGACY_ASSIGNMENT_KEY__')",
  );
}

function restoreLegacyFrontmatterReader(content) {
  return content.replace(
    /getField\(frontmatter, 'ticket'\) \?\? getField\(frontmatter, '__LEGACY_ASSIGNMENT_KEY__'\)/g,
    "getField(frontmatter, 'ticket') ?? getField(frontmatter, 'assignment')",
  );
}

function protectSqlAndWire(content, rel) {
  const placeholders = [];
  let i = 0;
  const add = (pat) => {
    content = content.replace(pat, (m) => {
      const key = `__SQLWIRE_${i++}__`;
      placeholders.push([key, m]);
      return key;
    });
  };
  add(/\bassignment_id\b/g);
  if (WIRE_FIELD_FILES.has(rel)) {
    add(/\bassignment_slug\b/g);
  }
  return { content, placeholders };
}

function restoreSqlAndWire(content, placeholders) {
  let out = content;
  for (const [key, val] of placeholders) {
    out = out.split(key).join(val);
  }
  return out;
}

function transformFile(filePath) {
  const rel = relative(ROOT, filePath);
  let content = readFileSync(filePath, 'utf8');
  const orig = content;
  const isMigrate = MIGRATE_FILES.has(rel.split('/').pop() ?? '');
  const isBroker = rel === 'src/chat/broker.ts';

  let migratePh = [];
  if (isMigrate) {
    const p = protectMigrateLiterals(content);
    content = p.content;
    migratePh = p.placeholders;
  }

  if (rel === 'src/dashboard/parser.ts') {
    content = protectLegacyFrontmatterReader(content);
  }

  if (isBroker) {
    content = protectBrokerScopeKey(content);
  }

  const sqlWire = protectSqlAndWire(content, rel);
  content = sqlWire.content;

  for (const [from, to] of IDENT_REPLACEMENTS) {
    content = content.split(from).join(to);
  }

  content = restoreSqlAndWire(content, sqlWire.placeholders);

  if (rel === 'src/dashboard/parser.ts') {
    content = restoreLegacyFrontmatterReader(content);
  }

  if (isBroker) {
    content = restoreBrokerScopeKey(content);
  }

  if (isMigrate) {
    content = restorePlaceholders(content, migratePh);
  }

  // Fix double-renames from overlapping rules
  content = content.replace(/ticket-chat-chat/g, 'ticket-chat');
  content = content.replace(/ticketsDirDir/g, 'ticketsDir');
  content = content.replace(/ticketMdPathPath/g, 'ticketMdPath');
  content = content.replace(/ParsedTicketTicketFull/g, 'ParsedTicketFull');
  content = content.replace(/parseTicketTicketFull/g, 'parseTicketFull');

  if (content !== orig) {
    writeFileSync(filePath, content);
    return true;
  }
  return false;
}

const files = [
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'dashboard', 'src')),
  ...walk(join(ROOT, 'platforms', 'codex')),
  ...walk(join(ROOT, 'statusline')),
  ...walk(join(ROOT, 'scripts')),
];

let changed = 0;
for (const f of files) {
  if (transformFile(f)) changed++;
}
console.log(`phase-a-residue-codemod: updated ${changed} files`);
