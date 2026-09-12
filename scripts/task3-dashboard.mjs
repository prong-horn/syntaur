#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DASH = join(ROOT, 'dashboard', 'src');

const RENAMES = [
  ['pages/AssignmentsPage.tsx', 'pages/TicketsPage.tsx'],
  ['pages/AssignmentDetail.tsx', 'pages/TicketDetail.tsx'],
  ['pages/CreateAssignment.tsx', 'pages/CreateTicket.tsx'],
  ['pages/CreateStandaloneAssignment.tsx', 'pages/CreateStandaloneTicket.tsx'],
  ['pages/StandaloneAssignmentDetail.tsx', 'pages/StandaloneTicketDetail.tsx'],
  ['pages/EditAssignment.tsx', 'pages/EditTicket.tsx'],
  ['pages/EditAssignmentPlan.tsx', 'pages/EditTicketPlan.tsx'],
  ['pages/EditAssignmentScratchpad.tsx', 'pages/EditTicketScratchpad.tsx'],
  ['pages/AppendAssignmentHandoff.tsx', 'pages/AppendTicketHandoff.tsx'],
  ['pages/AppendAssignmentDecisionRecord.tsx', 'pages/AppendTicketDecisionRecord.tsx'],
  ['lib/assignments.ts', 'lib/tickets.ts'],
  ['lib/assignmentFilter.ts', 'lib/ticketFilter.ts'],
  ['lib/sortAssignments.ts', 'lib/sortTickets.ts'],
  ['hooks/useAssignmentChat.ts', 'hooks/useTicketChat.ts'],
  ['hooks/useAssignmentEvents.ts', 'hooks/useTicketEvents.ts'],
  ['hooks/__tests__/useAssignmentChat.test.ts', 'hooks/__tests__/useTicketChat.test.ts'],
  ['components/AssignmentStatusPill.tsx', 'components/TicketStatusPill.tsx'],
  ['components/AssignmentTransitionDialog.tsx', 'components/TicketTransitionDialog.tsx'],
  ['components/AssignmentUsageSection.tsx', 'components/TicketUsageSection.tsx'],
];

for (const [from, to] of RENAMES) {
  const a = join(DASH, from);
  const b = join(DASH, to);
  try { renameSync(a, b); console.log('mv', from, '->', to); } catch {}
}

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (/\.(ts|tsx|css)$/.test(name)) files.push(p);
  }
  return files;
}

const REPS = [
  // imports/paths
  ['AssignmentsPage', 'TicketsPage'],
  ['AssignmentDetail', 'TicketDetail'],
  ['CreateAssignment', 'CreateTicket'],
  ['CreateStandaloneAssignment', 'CreateStandaloneTicket'],
  ['StandaloneAssignmentDetail', 'StandaloneTicketDetail'],
  ['EditAssignmentScratchpad', 'EditTicketScratchpad'],
  ['EditAssignmentPlan', 'EditTicketPlan'],
  ['EditAssignment', 'EditTicket'],
  ['AppendAssignmentHandoff', 'AppendTicketHandoff'],
  ['AppendAssignmentDecisionRecord', 'AppendTicketDecisionRecord'],
  ['useAssignmentChat', 'useTicketChat'],
  ['useAssignmentEvents', 'useTicketEvents'],
  ['AssignmentStatusPill', 'TicketStatusPill'],
  ['AssignmentTransitionDialog', 'TicketTransitionDialog'],
  ['AssignmentUsageSection', 'TicketUsageSection'],
  ['lib/assignments', 'lib/tickets'],
  ['lib/assignmentFilter', 'lib/ticketFilter'],
  ['lib/sortAssignments', 'lib/sortTickets'],
  ['assignmentFilter', 'ticketFilter'],
  ['sortAssignments', 'sortTickets'],
  // routes
  ["'/assignments'", "'/tickets'"],
  ['"/assignments"', '"/tickets"'],
  ["'/a/", "'/t/"],
  ['"/a/', '"/t/'],
  ["'/assignments/new'", "'/tickets/new'"],
  ["'/projects/:slug/assignments/new'", "'/projects/:slug/new'"],
  // API paths already done in task 2
  // copy
  ['Assignments', 'Tickets'],
  ['Assignment', 'Ticket'],
  ['assignments', 'tickets'],
  ['assignment', 'ticket'],
  // hotkeys
  ["kind: 'assignment'", "kind: 'ticket'"],
  ["prefix: 'a'", "prefix: 't'"],
  ['new-assignment', 'new-ticket'],
  ["'g a'", "'g t'"],
  ['Go to Assignments', 'Go to Tickets'],
  ['New assignment', 'New ticket'],
  ['Edit assignment', 'Edit ticket'],
  // hooks/types
  ['useAssignmentById', 'useTicketById'],
  ['useAssignments', 'useTickets'],
  ['AssignmentBoardItem', 'TicketBoardItem'],
  ['AssignmentDetail', 'TicketDetail'],
  ['AssignmentSummary', 'TicketSummary'],
  ['assignment-updated', 'ticket-updated'],
  // restore false positives
];

for (const f of walk(DASH)) {
  let c = readFileSync(f, 'utf8');
  const orig = c;
  for (const [a, b] of REPS) c = c.split(a).join(b);
  // restore SQL / known false positives
  c = c.replace(/\bticket_id\b/g, 'assignment_id');
  c = c.replace(/\bticket_slug\b/g, 'assignment_slug');
  c = c.replace(/ticket-chat/g, 'assignment-chat');
  if (c !== orig) writeFileSync(f, c);
}

console.log('task3-dashboard done');
