import { assignTicket } from '../lifecycle/assign.js';
import { resolveTicketTarget } from '../utils/ticket-target.js';

export interface AssignOptions {
  project?: string;
  dir?: string;
  agent?: string;
}

export async function assignCommand(
  ticket: string,
  options: AssignOptions,
): Promise<void> {
  if (!options.agent) {
    throw new Error('--agent <name> is required.');
  }
  const target = await resolveTicketTarget(ticket, {
    project: options.project,
    dir: options.dir,
  });
  const result = await assignTicket(target.ticketDir, options.agent, options.agent);
  console.log(result.message);
}
