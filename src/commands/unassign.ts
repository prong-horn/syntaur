import { unassignTicket } from '../lifecycle/assign.js';
import { resolveTicketTarget } from '../utils/ticket-target.js';

export interface UnassignOptions {
  project?: string;
  dir?: string;
  agent?: string;
}

export async function unassignCommand(
  ticket: string,
  options: UnassignOptions,
): Promise<void> {
  const target = await resolveTicketTarget(ticket, {
    project: options.project,
    dir: options.dir,
  });
  const result = await unassignTicket(target.ticketDir, options.agent ?? null);
  console.log(result.message);
}
