#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const f = 'src/chat/broker.ts';
let c = readFileSync(f, 'utf8');

// Loop variable mismatch
c = c.replace(
  /for \(const assignment of touchedTickets\.values\(\)\) \{\s+const participants = await readParticipants\(ticket\.ticketDir/g,
  'for (const ticket of touchedTickets.values()) {\n        const participants = await readParticipants(ticket.ticketDir',
);

// recordTicket body
c = c.replace(/const scope = await ticketScope\(assignment\);/g, 'const scope = await ticketScope(ticket);');

// AgentSession registration — dashboard type still uses assignment* fields
c = c.replace(
  /projectSlug: session\.ticket\.projectSlug,\s+ticketSlug: session\.ticket\.ticketSlug,\s+ticketId: session\.ticket\.id,/g,
  'projectSlug: session.ticket.projectSlug,\n        assignmentSlug: session.ticket.ticketSlug,\n        assignmentId: session.ticket.id,',
);

// send() implementation
c = c.replace(
  /async send\(\{ assignment, agentId, text, attachments \}\) \{/,
  'async send({ ticket: ticketArg, assignment, agentId, text, attachments }) {\n      const ticket = ticketArg ?? assignment;\n      if (!ticket) throw new ChatSendError(\'No ticket target\', 400);',
);
c = c.replace(/routingContext\(assignment\)/g, 'routingContext(ticket)');
c = c.replace(/recordTicket\(assignment,/g, 'recordTicket(ticket,');

// recordTicket calls in fileRecord path
c = c.replace(/await recordTicket\(assignment,/g, 'await recordTicket(ticket,');

// Fix broadcast payloads that incorrectly use ticketSlug (keep for WS until task 2 - actually dashboard expects assignmentSlug in WS?)
// For now broker internal - check lines 910-911 - these might need to stay as assignmentSlug for dashboard compat
c = c.replace(/ticketSlug: ticket\.ticketSlug,\s+timestamp: iso\(\),\s+payload: \{\s+ticketId: ticket\.id,/g,
  'assignmentSlug: ticket.ticketSlug,\n          timestamp: iso(),\n          payload: {\n            assignmentId: ticket.id,');

writeFileSync(f, c);
console.log('broker pass2 done');
