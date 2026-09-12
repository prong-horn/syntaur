#!/usr/bin/env node
/**
 * Task 2: collapse API routes to /api/tickets/:id and rename response fields in dashboard backend.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

function walk(dir, files = [], skip = new Set(['node_modules', 'dist', 'fixtures'])) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files, skip);
    else if (/\.(ts|tsx)$/.test(name)) files.push(p);
  }
  return files;
}

const ROUTE_REPLACEMENTS = [
  // paths (longest first)
  ["'/api/projects/:slug/tickets/:aslug/", "'/api/projects/:slug/tickets/:aslug/"], // removed below
  ["'/api/templates/ticket'", "'/api/templates/ticket'"],
  ["'/api/tickets/", "'/api/tickets/"],
  ["'/api/tickets'", "'/api/tickets'"],
  ["'/api/projects/:slug/tickets'", "'/api/projects/:slug/tickets'"],
];

const CODE_REPLACEMENTS = [
  ['listTicketsBoard', 'listTicketsBoard'],
  ['getTicketDetailById', 'getTicketDetailById'],
  ['getTicketDetail(', 'getTicketDetail('],
  ['resolveTicketById', 'resolveTicketById'],
  ['resolveTicketBySlug', 'resolveTicketBySlug'],
  ['listSessionsByTicket', 'listSessionsByTicket'],
  ['recomputeTicketDir', 'recomputeTicketDir'],
  ['isEngineActiveForTicket', 'isEngineActiveForTicket'],
  ['TicketBoardItem', 'TicketBoardItem'],
  ['TicketDetail', 'TicketDetail'],
  ['TicketSummary', 'TicketSummary'],
  ['TicketUpdated', 'TicketUpdated'],
  ["'ticket-updated'", "'ticket-updated'"],
  ['ticket-updated', 'ticket-updated'],
  ['source-tickets', 'source-tickets'],
  ['sourceTickets', 'sourceTickets'],
];

function removeSlugTicketRoutes(content) {
  // Drop router handlers whose path includes tickets/:aslug (slug form deleted per decision 5)
  const lines = content.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const routeMatch = line.match(/router\.(get|post|put|patch|delete)\(\s*['`]([^'"`]+)['`]/);
    if (routeMatch && routeMatch[2].includes('tickets/:aslug')) {
      // skip until closing `});` at same indent level as router line
      const baseIndent = line.match(/^(\s*)/)[1];
      i++;
      while (i < lines.length) {
        if (lines[i].startsWith(baseIndent + '});') && !lines[i].includes('router.')) break;
        i++;
      }
      i++; // skip });
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

function applyReplacements(content, reps) {
  let c = content;
  for (const [a, b] of reps) c = c.split(a).join(b);
  return c;
}

const dashboardBackend = [
  'src/dashboard/server.ts',
  'src/dashboard/api.ts',
  'src/dashboard/api-write.ts',
  'src/dashboard/api-chat.ts',
  'src/dashboard/api-events.ts',
  'src/dashboard/api-usage.ts',
  'src/dashboard/api-inbox.ts',
  'src/dashboard/api-status-config.ts',
  'src/dashboard/watcher.ts',
  'src/dashboard/types.ts',
  'src/dashboard/recreate-target.ts',
  'src/dashboard/help.ts',
];

for (const rel of dashboardBackend) {
  const p = join(ROOT, rel);
  let c = readFileSync(p, 'utf8');
  const orig = c;
  if (rel === 'src/dashboard/api-write.ts') {
    c = removeSlugTicketRoutes(c);
  }
  c = applyReplacements(c, ROUTE_REPLACEMENTS);
  c = applyReplacements(c, CODE_REPLACEMENTS);
  // Response/json field renames in dashboard backend (not SQL columns)
  c = c.replace(/\bticketSlug\b/g, 'ticketSlug');
  c = c.replace(/\bticketId\b/g, 'ticketId');
  c = c.replace(/\bticketDir\b/g, 'ticketDir');
  c = c.replace(/\bticketPath\b/g, 'ticketPath');
  c = c.replace(/\bticketsDir\b/g, 'ticketsDir');
  // Restore SQL column names in strings
  c = c.replace(/\bticket_id\b/g, 'assignment_id');
  c = c.replace(/\bticket_slug\b/g, 'assignment_slug');
  if (c !== orig) {
    writeFileSync(p, c);
    console.log('updated', rel);
  }
}

// Tests under src/__tests__ for dashboard API
for (const f of walk(join(ROOT, 'src', '__tests__'))) {
  if (!f.includes('dashboard')) continue;
  let c = readFileSync(f, 'utf8');
  const orig = c;
  c = applyReplacements(c, ROUTE_REPLACEMENTS);
  c = applyReplacements(c, CODE_REPLACEMENTS);
  c = c.replace(/\/api\/tickets/g, '/api/tickets');
  c = c.replace(/tickets\/:aslug/g, 'tickets/:id');
  if (c !== orig) {
    writeFileSync(f, c);
    console.log('updated', relative(ROOT, f));
  }
}

console.log('task2-api-routes done');
