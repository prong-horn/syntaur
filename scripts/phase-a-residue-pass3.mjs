#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'dist', 'fixtures', 'releases', 'superpowers', 'phase-a-residue-codemod.mjs', 'phase-a-residue-fixpass.mjs', 'phase-a-residue-pass3.mjs']);

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.has(name)) continue;
    const rel = relative(ROOT, p);
    if (rel.includes('/fixtures/acp/')) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (/\.(ts|tsx|sh|snap)$/.test(name)) files.push(p);
  }
  return files;
}

const REPS = [
  ['SourceAssignment', 'SourceTicket'],
  ['toSourceAssignment', 'toSourceTicket'],
  ['getProjectSourceAssignments', 'getProjectSourceTickets'],
  ['getStandaloneSourceAssignments', 'getStandaloneSourceTickets'],
  ['cursorAssignment', 'cursorTicket'],
  ['CursorAssignmentParams', 'CursorTicketParams'],
  ['newestAssignment', 'newestTicket'],
  ['ASSIGNMENT scope', 'TICKET scope'],
  ['FOR THIS ASSIGNMENT', 'FOR THIS TICKET'],
  ['Assignment Query Language', 'Ticket Query Language'],
  ['Assignment-chat', 'Ticket-chat'],
  ['Assignment-chat', 'Ticket-chat'],
  ['Assignment cost', 'Ticket cost'],
  ['Assignment id', 'Ticket id'],
  ['Assignment `type`', 'Ticket `type`'],
  ['Assignment-file', 'Ticket-file'],
  ['Assignment not found', 'Ticket not found'],
  ['Assignment is terminal', 'Ticket is terminal'],
  ['Assignment is ${', 'Ticket is ${'],
  ['Assignment "', 'Ticket "'],
  ['My New Assignment', 'My New Ticket'],
  ['`Assignment:', '`Ticket:'],
  ['Assignment:', 'Ticket:'],
  ['Assignment is', 'Ticket is'],
  ['parseAssignmentFrontmatter', 'parseTicketFrontmatter'],
  ['updateAssignmentFile', 'updateTicketFile'],
  ['updateAssignmentWorkspace', 'updateTicketWorkspace'],
  ['executeAssign', 'executeAssign'],
  ['listAssignments', 'listTickets'],
  ['getAssignment', 'getTicket'],
  ['createAssignment', 'createTicket'],
  ['grabAssignment', 'grabTicket'],
  ['completeAssignment', 'completeTicket'],
  ['planAssignment', 'planTicket'],
  ['assignmentDir', 'ticketDir'],
  ['assignmentSlug', 'ticketSlug'],
  ['assignmentId', 'ticketId'],
  ['assignmentPath', 'ticketPath'],
  ['assignmentTitle', 'ticketTitle'],
  ['assignmentContent', 'ticketContent'],
  ['assignmentMd', 'ticketMd'],
  ['assignmentRef', 'ticketRef'],
  ['assignmentType', 'ticketType'],
  ['assignmentWorkflow', 'ticketWorkflow'],
  ['assignmentStatus', 'ticketStatus'],
  ['assignmentUpdated', 'ticketUpdated'],
  ['assignmentChat', 'ticketChat'],
  ['assignmentBoard', 'ticketBoard'],
  ['assignmentCount', 'ticketCount'],
  ['assignmentList', 'ticketList'],
  ['assignmentKey', 'ticketKey'],
  ['assignmentName', 'ticketName'],
  ['assignmentLabel', 'ticketLabel'],
  ['assignmentHref', 'ticketHref'],
  ['assignmentUrl', 'ticketUrl'],
  ['assignmentRoute', 'ticketRoute'],
  ['assignmentFilter', 'ticketFilter'],
  ['assignmentDetail', 'ticketDetail'],
  ['assignmentSummary', 'ticketSummary'],
  ['assignmentRecord', 'ticketRecord'],
  ['assignmentEntry', 'ticketEntry'],
  ['assignmentItem', 'ticketItem'],
  ['assignmentNode', 'ticketNode'],
  ['assignmentLink', 'ticketLink'],
  ['assignmentLinks', 'ticketLinks'],
  ['assignmentDeps', 'ticketDeps'],
  ['assignmentGraph', 'ticketGraph'],
  ['assignmentTree', 'ticketTree'],
  ['assignmentWalk', 'ticketWalk'],
  ['assignmentTarget', 'ticketTarget'],
  ['assignmentScope', 'ticketScope'],
  ['assignmentSession', 'ticketSession'],
  ['assignmentSessions', 'ticketSessions'],
  ['assignmentEvents', 'ticketEvents'],
  ['assignmentFacts', 'ticketFacts'],
  ['assignmentPhase', 'ticketPhase'],
  ['assignmentStage', 'ticketStage'],
  ['assignmentState', 'ticketState'],
  ['assignmentMeta', 'ticketMeta'],
  ['assignmentInfo', 'ticketInfo'],
  ['assignmentData', 'ticketData'],
  ['assignmentField', 'ticketField'],
  ['assignmentFields', 'ticketFields'],
  ['assignmentQuery', 'ticketQuery'],
  ['assignmentRules', 'ticketRules'],
  ['assignmentConfig', 'ticketConfig'],
  ['assignmentBinding', 'ticketBinding'],
  ['assignmentResolver', 'ticketResolver'],
  ['assignmentResolver', 'ticketResolver'],
  ['ASSIGNMENT_', 'TICKET_'],
  ['assignment_', 'ticket_'],
  ['assignments/', 'tickets/'],
  ['assignments', 'tickets'],
  ['assignment', 'ticket'],
];

function protect(content, rel) {
  const ph = [];
  let i = 0;
  const add = (pat) => {
    content = content.replace(pat, (m) => {
      const k = `__P${i++}__`;
      ph.push([k, m]);
      return k;
    });
  };
  add(/\bassignment_id\b/g);
  if (rel.startsWith('src/db/') || rel.startsWith('src/usage/') ||
      rel === 'src/utils/engagement-binding.ts' ||
      rel.endsWith('dashboard/src/hooks/useTicketEvents.ts') ||
      rel.endsWith('dashboard/src/hooks/useProjects.ts') ||
      rel.endsWith('dashboard/src/pages/UsagePage.tsx')) {
    add(/\bassignment_slug\b/g);
  }
  if (rel === 'src/chat/broker.ts') {
    add(/`(\$\{ticketId\}:)@assignment`/g);
  }
  if (rel === 'src/dashboard/parser.ts') {
    add(/getField\(frontmatter, 'assignment'\)/g);
  }
  if (/migrate-/.test(rel)) {
    add(/'assignments\/[^']*'/g);
    add(/"assignments\/[^"]*"/g);
    add(/'assignments'/g);
    add(/"assignments"/g);
    add(/'assignment\.md'/g);
    add(/"assignment\.md"/g);
    add(/'assignment'/g);
    add(/"assignment"/g);
  }
  return { content, ph };
}

function restore(content, ph) {
  let out = content;
  for (const [k, v] of ph) out = out.split(k).join(v);
  return out;
}

let changed = 0;
for (const root of ['src', join('dashboard', 'src'), join('platforms', 'codex'), 'statusline']) {
  for (const f of walk(join(ROOT, root))) {
    const rel = relative(ROOT, f);
    let content = readFileSync(f, 'utf8');
    const orig = content;
    const p = protect(content, rel);
    content = p.content;
    for (const [a, b] of REPS) content = content.split(a).join(b);
    content = restore(content, p.ph);
    content = content.replace(/ticket_id/g, 'assignment_id');
    if (!rel.endsWith('dashboard/src/hooks/useProjects.ts') &&
        !rel.endsWith('dashboard/src/pages/UsagePage.tsx')) {
      content = content.replace(/ticket_slug/g, 'assignment_slug');
    }
    if (content !== orig) {
      writeFileSync(f, content);
      changed++;
    }
  }
}
console.log(`pass3: ${changed} files`);
