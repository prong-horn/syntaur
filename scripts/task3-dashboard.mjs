#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DASH = join(ROOT, 'dashboard', 'src');

const RENAMES = [
  ['pages/TicketsPage.tsx', 'pages/TicketsPage.tsx'],
  ['pages/TicketDetail.tsx', 'pages/TicketDetail.tsx'],
  ['pages/CreateTicket.tsx', 'pages/CreateTicket.tsx'],
  ['pages/CreateStandaloneTicket.tsx', 'pages/CreateStandaloneTicket.tsx'],
  ['pages/StandaloneTicketDetail.tsx', 'pages/StandaloneTicketDetail.tsx'],
  ['pages/EditTicket.tsx', 'pages/EditTicket.tsx'],
  ['pages/EditTicketPlan.tsx', 'pages/EditTicketPlan.tsx'],
  ['pages/EditTicketScratchpad.tsx', 'pages/EditTicketScratchpad.tsx'],
  ['pages/AppendTicketHandoff.tsx', 'pages/AppendTicketHandoff.tsx'],
  ['pages/AppendTicketDecisionRecord.tsx', 'pages/AppendTicketDecisionRecord.tsx'],
  ['lib/tickets.ts', 'lib/tickets.ts'],
  ['lib/ticketFilter.ts', 'lib/ticketFilter.ts'],
  ['lib/sortTickets.ts', 'lib/sortTickets.ts'],
  ['hooks/useTicketChat.ts', 'hooks/useTicketChat.ts'],
  ['hooks/useTicketEvents.ts', 'hooks/useTicketEvents.ts'],
  ['hooks/__tests__/useTicketChat.test.ts', 'hooks/__tests__/useTicketChat.test.ts'],
  ['components/TicketStatusPill.tsx', 'components/TicketStatusPill.tsx'],
  ['components/TicketTransitionDialog.tsx', 'components/TicketTransitionDialog.tsx'],
  ['components/TicketUsageSection.tsx', 'components/TicketUsageSection.tsx'],
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
  ['TicketsPage', 'TicketsPage'],
  ['TicketDetail', 'TicketDetail'],
  ['CreateTicket', 'CreateTicket'],
  ['CreateStandaloneTicket', 'CreateStandaloneTicket'],
  ['StandaloneTicketDetail', 'StandaloneTicketDetail'],
  ['EditTicketScratchpad', 'EditTicketScratchpad'],
  ['EditTicketPlan', 'EditTicketPlan'],
  ['EditTicket', 'EditTicket'],
  ['AppendTicketHandoff', 'AppendTicketHandoff'],
  ['AppendTicketDecisionRecord', 'AppendTicketDecisionRecord'],
  ['useTicketChat', 'useTicketChat'],
  ['useTicketEvents', 'useTicketEvents'],
  ['TicketStatusPill', 'TicketStatusPill'],
  ['TicketTransitionDialog', 'TicketTransitionDialog'],
  ['TicketUsageSection', 'TicketUsageSection'],
  ['lib/tickets', 'lib/tickets'],
  ['lib/ticketFilter', 'lib/ticketFilter'],
  ['lib/sortTickets', 'lib/sortTickets'],
  ['ticketFilter', 'ticketFilter'],
  ['sortTickets', 'sortTickets'],
  // routes
  ["'/tickets'", "'/tickets'"],
  ['"/tickets"', '"/tickets"'],
  ["'/a/", "'/t/"],
  ['"/a/', '"/t/'],
  ["'/tickets/new'", "'/tickets/new'"],
  ["'/projects/:slug/tickets/new'", "'/projects/:slug/new'"],
  // API paths already done in task 2
  // copy
  ['Tickets', 'Tickets'],
  ['Ticket', 'Ticket'],
  ['tickets', 'tickets'],
  ['ticket', 'ticket'],
  // hotkeys
  ["kind: 'ticket'", "kind: 'ticket'"],
  ["prefix: 'a'", "prefix: 't'"],
  ['new-ticket', 'new-ticket'],
  ["'g t'", "'g t'"],
  ['Go to Tickets', 'Go to Tickets'],
  ['New ticket', 'New ticket'],
  ['Edit ticket', 'Edit ticket'],
  // hooks/types
  ['useTicketById', 'useTicketById'],
  ['useTickets', 'useTickets'],
  ['TicketBoardItem', 'TicketBoardItem'],
  ['TicketDetail', 'TicketDetail'],
  ['TicketSummary', 'TicketSummary'],
  ['ticket-updated', 'ticket-updated'],
  // restore false positives
];

for (const f of walk(DASH)) {
  let c = readFileSync(f, 'utf8');
  const orig = c;
  for (const [a, b] of REPS) c = c.split(a).join(b);
  // restore SQL / known false positives
  c = c.replace(/\bticket_id\b/g, 'assignment_id');
  c = c.replace(/\bticket_slug\b/g, 'ticket_slug');
  c = c.replace(/ticket-chat/g, 'ticket-chat');
  if (c !== orig) writeFileSync(f, c);
}

console.log('task3-dashboard done');
