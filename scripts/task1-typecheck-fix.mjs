#!/usr/bin/env node
/**
 * Task 1 typecheck fixes: compat shims + incomplete codemod cleanup.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

function walk(dir, files = [], skip = new Set()) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files, skip);
    else if (/\.ts$/.test(name)) files.push(p);
  }
  return files;
}

// --- broker.ts: fix loop variable / destructuring bugs from partial codemod ---
{
  let c = readFileSync(join(ROOT, 'src/chat/broker.ts'), 'utf8');
  c = c.replace(
    /for \(const ticket of touchedTickets\.values\(\)\) \{\s+const participants = await readParticipants\(ticket\.ticketDir/g,
    'for (const ticket of touchedTickets.values()) {\n        const participants = await readParticipants(ticket.ticketDir',
  );
  c = c.replace(/\brecordTicket\(ticket,/g, 'recordTicket(ticket,');
  c = c.replace(/async send\(\{ ticket, agentId/g, 'async send({ ticket, agentId');
  c = c.replace(/routingContext\(ticket\)/g, 'routingContext(ticket)');
  // AgentSession fields: dashboard still uses ticketSlug through Task 2
  c = c.replace(/ticketSlug:/g, 'ticketSlug:');
  c = c.replace(/ticketId:/g, 'ticketId:');
  writeFileSync(join(ROOT, 'src/chat/broker.ts'), c);
  console.log('fixed broker.ts');
}

// --- commands: opts.ticket -> opts.ticket ---
const CMD_FILES = [
  'src/commands/plan.ts',
  'src/commands/progress.ts',
  'src/commands/workspace.ts',
  'src/commands/worktree.ts',
  'src/commands/usage.ts',
  'src/commands/setup-adapter.ts',
  'src/commands/track-session.ts',
  'src/commands/session.ts',
  'src/commands/open.ts',
];
for (const rel of CMD_FILES) {
  const p = join(ROOT, rel);
  let c = readFileSync(p, 'utf8');
  const orig = c;
  c = c.replace(/\bopts\.ticket\b/g, 'opts.ticket');
  c = c.replace(/\boptions\.ticket\b/g, 'options.ticket');
  c = c.replace(/\bticketArg\b/g, 'ticketArg');
  // open.ts recreate deps
  c = c.replace(/ticketsDir: ticketsDir\(\)/g, 'ticketsDir: ticketsDir()');
  c = c.replace(/kind: 'ticket'/g, "kind: 'ticket'");
  // track-session / session AgentSession
  c = c.replace(/ticketSlug: options\.ticket/g, 'ticketSlug: options.ticket');
  if (c !== orig) {
    writeFileSync(p, c);
    console.log('fixed', rel);
  }
}

// plan.ts ticketMd
{
  const p = join(ROOT, 'src/commands/plan.ts');
  let c = readFileSync(p, 'utf8');
  c = c.replace(/\bticketMd\b/g, 'ticketMd');
  writeFileSync(p, c);
}

// setup-adapter ProtocolContext + options
{
  const p = join(ROOT, 'src/commands/setup-adapter.ts');
  let c = readFileSync(p, 'utf8');
  c = c.replace(/\boptions\.ticket\b/g, 'options.ticket');
  c = c.replace(/\bopts\.ticket\b/g, 'opts.ticket');
  writeFileSync(p, c);
}

console.log('task1-typecheck-fix done');
