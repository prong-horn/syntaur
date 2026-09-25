import { readConfig } from './config.js';
import { expandHome } from './paths.js';
import { isValidSlug } from './slug.js';
import { isTicketId } from './ticket-ids.js';
import {
  resolveTicketByIdDirect,
  resolveTicketByMovedFromAlias,
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
  worktree?: string | null;
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
 * Resolve a ticket id, optionally constrained to a project slug. On a direct
 * folder miss or a direct hit in the wrong project, falls back to `movedFrom`.
 */
export async function resolveTicketWithProject(
  baseDir: string,
  id: string,
  project?: string,
): Promise<ResolvedTicket | null> {
  const direct = await resolveTicketByIdDirect(baseDir, id);
  if (direct && (!project || direct.projectSlug === project)) {
    return direct;
  }
  const alias = await resolveTicketByMovedFromAlias(baseDir, id, project);
  if (alias) return alias;
  if (direct && project && direct.projectSlug !== project) {
    return null;
  }
  return direct;
}

/**
 * Resolve a ticket target:
 *   1. `--project <slug> <ticket-id>` (id must belong to that project)
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
        '--project requires a ticket id (<PREFIX>-<n>) as a positional argument.',
      );
    }
    if (!isValidSlug(opts.project)) {
      throw new TicketTargetError(`Invalid project slug "${opts.project}".`);
    }
    if (!isTicketId(input)) {
      throw new TicketTargetError(
        `Ticket "${input}" is not a valid ticket id. Use <PREFIX>-<n> (e.g. SCR-1).`,
      );
    }
    const resolved = await resolveTicketWithProject(baseDir, input, opts.project);
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
    const resolved = await resolveTicketWithProject(baseDir, input);
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
  const resolved = await resolveTicketWithProject(baseDir, ticketId);
  if (!resolved) {
    throw new TicketTargetError(
      `Open engagement points to a missing ticket: ${ticketId}.`,
    );
  }
  return { ...resolved, stage: binding.stage };
}
