import { readConfig } from './config.js';
import { expandHome } from './paths.js';
import { isValidSlug } from './slug.js';
import { isTicketId } from './ticket-ids.js';
import {
  resolveTicketById,
  resolveTicketSlugInProject,
  type ResolvedTicket,
} from './ticket-resolver.js';
import type { EngagementBinding } from './engagement-binding.js';

export interface TicketTargetOptions {
  project?: string;
  dir?: string;
  cwd?: string;
  resolveEngagement?: () => Promise<EngagementBinding | null>;
}

export class TicketTargetError extends Error {}

export interface ContextJsonShape {
  sessionId?: string | null;
  transcriptPath?: string | null;
  ticketId?: string | null;
  ticketDir?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  repository?: string | null;
  boundAt?: string | null;
}

export type ContextKind = 'standalone' | 'empty';

export function classifyContext(ctx: ContextJsonShape | null): ContextKind {
  if (!ctx) return 'empty';
  if (ctx.sessionId || ctx.transcriptPath) return 'standalone';
  return 'empty';
}

/**
 * Resolve a ticket target:
 *   1. `--project <slug> + <slug>` (legacy slug path within a project)
 *   2. bare ticket id (`<PREFIX>-<n>`)
 *   3. no positional → the session's open engagement
 */
export async function resolveTicketTarget(
  input: string | undefined,
  opts: TicketTargetOptions = {},
): Promise<ResolvedTicket> {
  const config = await readConfig();
  const baseDir = opts.dir ? expandHome(opts.dir) : config.defaultProjectDir;

  if (opts.project) {
    if (!input) {
      throw new TicketTargetError(
        '--project requires a ticket slug or id as a positional argument.',
      );
    }
    if (!isValidSlug(opts.project)) {
      throw new TicketTargetError(`Invalid project slug "${opts.project}".`);
    }
    if (isTicketId(input)) {
      const resolved = await resolveTicketById(baseDir, undefined, input);
      if (!resolved || resolved.projectSlug !== opts.project) {
        throw new TicketTargetError(
          `Ticket "${input}" not found in project "${opts.project}".`,
        );
      }
      return resolved;
    }
    if (!isValidSlug(input)) {
      throw new TicketTargetError(`Invalid ticket slug "${input}".`);
    }
    const resolved = await resolveTicketSlugInProject(baseDir, opts.project, input);
    if (!resolved) {
      throw new TicketTargetError(
        `Ticket "${input}" not found in project "${opts.project}".`,
      );
    }
    return resolved;
  }

  if (input) {
    if (!isTicketId(input)) {
      throw new TicketTargetError(
        `Ticket "${input}" is not a valid ticket id. Use <PREFIX>-<n> (e.g. SCR-1).`,
      );
    }
    const resolved = await resolveTicketById(baseDir, undefined, input);
    if (!resolved) {
      throw new TicketTargetError(`Ticket "${input}" not found.`);
    }
    return resolved;
  }

  const binding = opts.resolveEngagement ? await opts.resolveEngagement() : null;
  if (binding) {
    return reconstructFromBinding(binding, baseDir);
  }

  throw new TicketTargetError(
    'No open engagement for this session. Pass a ticket id, or grab one first.',
  );
}

export async function reconstructFromBinding(
  binding: EngagementBinding,
  baseDir: string,
): Promise<ResolvedTicket> {
  const ticketId = binding.ticketId;
  if (!ticketId || !isTicketId(ticketId)) {
    throw new TicketTargetError(
      `Open engagement has invalid ticket id: "${ticketId ?? ''}".`,
    );
  }
  const resolved = await resolveTicketById(baseDir, undefined, ticketId);
  if (!resolved) {
    throw new TicketTargetError(
      `Open engagement points to a missing ticket: ${ticketId}.`,
    );
  }
  return { ...resolved, stage: binding.stage };
}
