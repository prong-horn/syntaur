import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { parseTicketFrontmatter, updateTicketFile } from './frontmatter.js';
import { emitEvent, resolveActor } from './event-emit.js';
import type { TransitionResult } from './types.js';

async function readTicket(
  ticketDir: string,
): Promise<{ content: string; frontmatter: ReturnType<typeof parseTicketFrontmatter> }> {
  const filePath = resolve(ticketDir, 'ticket.md');
  if (!(await fileExists(filePath))) {
    throw new Error(`Ticket file not found: ${filePath}`);
  }
  const content = await readFile(filePath, 'utf-8');
  return { content, frontmatter: parseTicketFrontmatter(content) };
}

export async function assignTicket(
  ticketDir: string,
  assignee: string,
  actor?: string | null,
): Promise<TransitionResult> {
  const { content, frontmatter } = await readTicket(ticketDir);
  const now = nowTimestamp();
  const updatedContent = updateTicketFile(content, { assignee, updated: now });
  await writeFileForce(resolve(ticketDir, 'ticket.md'), updatedContent);

  if (frontmatter.assignee !== assignee) {
    emitEvent({
      ticketId: frontmatter.id,
      projectSlug: frontmatter.project,
      type: 'assignee-change',
      actor: resolveActor(actor ?? assignee ?? frontmatter.assignee ?? null),
      details: { from: frontmatter.assignee, to: assignee },
    });
  }

  return {
    success: true,
    message: `Ticket "${frontmatter.id}" assigned to '${assignee}'.`,
    fromStatus: frontmatter.status,
  };
}

export async function unassignTicket(
  ticketDir: string,
  actor?: string | null,
): Promise<TransitionResult> {
  const { content, frontmatter } = await readTicket(ticketDir);
  const now = nowTimestamp();
  const updatedContent = updateTicketFile(content, { assignee: null, updated: now });
  await writeFileForce(resolve(ticketDir, 'ticket.md'), updatedContent);

  if (frontmatter.assignee !== null) {
    emitEvent({
      ticketId: frontmatter.id,
      projectSlug: frontmatter.project,
      type: 'assignee-change',
      actor: resolveActor(actor ?? frontmatter.assignee ?? null),
      details: { from: frontmatter.assignee, to: null },
    });
  }

  return {
    success: true,
    message: `Ticket "${frontmatter.id}" unassigned.`,
    fromStatus: frontmatter.status,
  };
}
