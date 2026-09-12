#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'dist', 'fixtures', 'releases', 'superpowers']);

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.has(name)) continue;
    const rel = relative(ROOT, p);
    if (rel.includes('/fixtures/acp/')) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (/\.(ts|tsx|sh|mjs)$/.test(name)) files.push(p);
  }
  return files;
}

const EXTRA_REPS = [
  ['TicketWalkResult', 'TicketWalkResult'],
  ['TicketTargetOptions', 'TicketTargetOptions'],
  ['TicketTargetError', 'TicketTargetError'],
  ['AffectedTicket', 'AffectedTicket'],
  ['scanTicketsByStatus', 'scanTicketsByStatus'],
  ['scanTicketsReferencingStatus', 'scanTicketsReferencingStatus'],
  ['hasAnyTicketField', 'hasAnyTicketField'],
  ['contextTicketResolves', 'contextTicketResolves'],
  ['newestTicketMtime', 'newestTicketMtime'],
  ['TicketIdentity', 'TicketIdentity'],
  ['TicketFacts', 'TicketFacts'],
  ['TicketWindowCostOpts', 'TicketWindowCostOpts'],
  ['TicketWindowCost', 'TicketWindowCost'],
  ['listEventsByTicket', 'listEventsByTicket'],
  ['hasEventsForTicket', 'hasEventsForTicket'],
  ['getEngagementsByTicketId', 'getEngagementsByTicketId'],
  ['buildTicketEngagements', 'buildTicketEngagements'],
  ['handleTicketArchive', 'handleTicketArchive'],
  ['TicketUsageSummary', 'TicketUsageSummary'],
  ['TicketCostKey', 'TicketCostKey'],
  ['projectTicketRollup', 'projectTicketRollup'],
  ['excludeTicketId', 'excludeTicketId'],
  ['getTicketTypes', 'getTicketTypes'],
  ['makeTicketDoc', 'makeTicketDoc'],
];

function fixContent(content) {
  let c = content;
  for (const [a, b] of EXTRA_REPS) c = c.split(a).join(b);

  // Remove deprecated duplicate fields (assignmentId renamed into existing ticketId, etc.)
  c = c.replace(/\n\s*\/\*\* @deprecated[^\n]*\*\/\n\s*(ticket[A-Za-z]+)(\??:[^;\n]+;)/g, (m, field, rest) => {
    // drop deprecated duplicate if same field name appears on previous line
    return '';
  });

  // Remove self-alias compat exports
  c = c.replace(/\n\/\*\* @deprecated[^\n]*\*\/\nexport const (parseTicketFull|parseTicketSummary|listSessionsByTicket|ticketWindowCost|getTicketTypes) = \1;/g, '');
  c = c.replace(/\n\/\*\* Core rename aliases[^\n]*\*\/\nexport const parseTicketFull = parseTicketFull;\nexport const parseTicketSummary = parseTicketSummary;\n?/g, '\n');

  // Remove duplicate TicketStatus alias
  c = c.replace(/\n\/\*\* @deprecated Dashboard compat until Task 2 \*\/\nexport type TicketStatus = TicketStatus;\n/, '\n');

  // Fix self-nullish coalescing
  c = c.replace(/(\w+)\.ticketId \?\? \1\.ticketId/g, '$1.ticketId');
  c = c.replace(/(\w+)\.ticketSlug \?\? \1\.ticketSlug/g, '$1.ticketSlug');
  c = c.replace(/(\w+)\.ticketPath \?\? \1\.ticketPath/g, '$1.ticketPath');
  c = c.replace(/(\w+)\.ticketDir \?\? \1\.ticketDir/g, '$1.ticketDir');
  c = c.replace(/(\w+)\.ticketWorkflow \?\? \1\.ticketWorkflow/g, '$1.ticketWorkflow');
  c = c.replace(/(\w+)\.ticketType \?\? \1\.ticketType/g, '$1.ticketType');
  c = c.replace(/opts\.ticketSlug \?\? opts\.ticketSlug \?\? ''/g, "opts.ticketSlug ?? ''");

  return c;
}

const roots = ['src', join('dashboard', 'src'), join('platforms', 'codex'), 'statusline', 'scripts'];
let changed = 0;
for (const root of roots) {
  for (const f of walk(join(ROOT, root))) {
    const orig = readFileSync(f, 'utf8');
    const next = fixContent(orig);
    if (next !== orig) {
      writeFileSync(f, next);
      changed++;
    }
  }
}
console.log(`fixpass: ${changed} files`);
