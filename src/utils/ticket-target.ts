import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expandHome, ticketsDir as ticketsDirFn } from './paths.js';
import { fileExists } from './fs.js';
import { readConfig } from './config.js';
import { isValidSlug } from './slug.js';
import { resolveTicketById, withResolvedCompat, type ResolvedTicket } from './ticket-resolver.js';
import { extractFrontmatter, getField } from '../dashboard/parser.js';
import type { EngagementBinding } from './engagement-binding.js';

export interface AssignmentTargetOptions {
  project?: string;
  dir?: string;
  cwd?: string;
  /**
   * Resolve the active (ticket, stage) from the session's OPEN engagement
   * (Case 3). Injected by callers — the real implementation is
   * `resolveEngagementBinding(cwd)` from engagement-binding.ts; tests pass a
   * stub. When unset or it resolves null, Case 3 throws the no-target selector
   * error. This replaces the demoted `context.json` ticket scalar.
   */
  resolveEngagement?: () => Promise<EngagementBinding | null>;
}

export class AssignmentTargetError extends Error {}

/**
 * `.syntaur/context.json` is a WORKSPACE MARKER, not the active-assignment
 * source. The authoritative active (ticket, stage) lives on the session's
 * open engagement (see resolveTicketTarget Case 3); the legacy
 * `projectSlug`/`ticketSlug`/`ticketDir` scalars were removed here to
 * close the multi-assignment-in-one-worktree clobber.
 */
export interface ContextJsonShape {
  // Session metadata (populated by Claude Code's SessionStart hook). These are
  // a legacy, co-tenant-clobberable HINT — never trust the sessionId value as
  // identity (resolve that from the process via resolveOwnSessionId). Their
  // PRESENCE vs absence is still a stable signal for classification.
  sessionId?: string | null;
  transcriptPath?: string | null;
  // Workspace markers.
  branch?: string | null;
  worktreePath?: string | null;
  repository?: string | null;
  boundAt?: string | null;
}

export type ContextKind = 'standalone' | 'empty';

export function classifyContext(ctx: ContextJsonShape | null): ContextKind {
  if (!ctx) return 'empty';
  // Standalone = a session-only context. Classify on the
  // PRESENCE of session metadata (sessionId or transcriptPath), not the specific
  // id value — the value is a clobberable hint, but presence-vs-absence is
  // stable under co-tenancy.
  if (ctx.sessionId || ctx.transcriptPath) return 'standalone';
  return 'empty';
}

async function readTicketFrontmatterId(ticketDir: string): Promise<string | null> {
  const path = resolve(ticketDir, 'ticket.md');
  if (!(await fileExists(path))) return null;
  try {
    const content = await readFile(path, 'utf-8');
    const [fm] = extractFrontmatter(content);
    return getField(fm, 'id');
  } catch {
    return null;
  }
}

/**
 * Resolve a ticket target across the three input shapes:
 *
 *   1. `--project <slug> + <assignment-slug>` (positional, explicit)
 *   2. bare UUID (positional, resolves standalone or project-nested via frontmatter id)
 *   3. no positional → the session's OPEN engagement (via `opts.resolveEngagement`).
 *      The legacy `.syntaur/context.json` ticket scalar is NO LONGER a
 *      resolution source — `context.json` is now a workspace marker only. With no
 *      positional and no open engagement, this throws the selector error.
 *
 * `--dir` overrides the projects base dir for cases 1 and 3 (project-nested).
 *
 * Throws AssignmentTargetError on any unresolved input. The returned shape
 * mirrors `ResolvedTicket` from ticket-resolver.ts; Case 3 also carries
 * the engagement `stage`.
 */
export async function resolveTicketTarget(
  input: string | undefined,
  opts: AssignmentTargetOptions = {},
): Promise<ResolvedTicket> {
  const config = await readConfig();
  const baseDir = opts.dir ? expandHome(opts.dir) : config.defaultProjectDir;

  // Case 1: --project + positional slug
  if (opts.project) {
    if (!input) {
      throw new AssignmentTargetError(
        '--project requires a ticket slug as a positional argument.',
      );
    }
    if (!isValidSlug(opts.project)) {
      throw new AssignmentTargetError(`Invalid project slug "${opts.project}".`);
    }
    if (!isValidSlug(input)) {
      throw new AssignmentTargetError(`Invalid ticket slug "${input}".`);
    }
    const projectDir = resolve(baseDir, opts.project);
    const projectMdPath = resolve(projectDir, 'project.md');
    if (!(await fileExists(projectDir)) || !(await fileExists(projectMdPath))) {
      throw new AssignmentTargetError(
        `Project "${opts.project}" not found at ${projectDir}.`,
      );
    }
    const ticketDir = resolve(projectDir, 'tickets', input);
    const assignmentMdPath = resolve(ticketDir, 'ticket.md');
    if (!(await fileExists(assignmentMdPath))) {
      throw new AssignmentTargetError(
        `Ticket "${input}" not found in project "${opts.project}".`,
      );
    }
    const id = (await readTicketFrontmatterId(ticketDir)) ?? input;
    return withResolvedCompat({
      ticketDir,
      projectSlug: opts.project,
      ticketSlug: input,
      id,
      standalone: false,
    });
  }

  // Case 2: bare UUID/id positional
  if (input) {
    const resolved = await resolveTicketById(baseDir, ticketsDirFn(), input);
    if (!resolved) {
      throw new AssignmentTargetError(
        `Ticket "${input}" not found. Provide --project <slug> + <slug> or a valid standalone UUID.`,
      );
    }
    return resolved;
  }

  // Case 3: no positional → resolve from the session's OPEN engagement.
  const binding = opts.resolveEngagement ? await opts.resolveEngagement() : null;
  if (binding) {
    return reconstructFromBinding(binding, baseDir);
  }

  throw new AssignmentTargetError(
    'No open engagement for this session. Pass --ticket <slug> (and --project) to target a ticket, or grab one first.',
  );
}

/**
 * Rebuild a `ResolvedTicket` from the session's open-engagement binding.
 * Project-nested reconstructs `baseDir/<project>/tickets/<slug>`; standalone
 * uses the resolved `ticketId` (preferred) or the slug-as-UUID under the
 * standalone tickets dir. Rejects a binding with no usable identity.
 */
export async function reconstructFromBinding(
  binding: EngagementBinding,
  baseDir: string,
): Promise<ResolvedTicket> {
  // Project-nested engagement.
  if (binding.projectSlug) {
    if (
      !isValidSlug(binding.projectSlug) ||
      !binding.ticketSlug ||
      !isValidSlug(binding.ticketSlug)
    ) {
      throw new AssignmentTargetError(
        `Open engagement has invalid slugs: project="${binding.projectSlug}" assignment="${binding.ticketSlug}".`,
      );
    }
    const ticketDir = resolve(baseDir, binding.projectSlug, 'tickets', binding.ticketSlug);
    const assignmentMdPath = resolve(ticketDir, 'ticket.md');
    if (!(await fileExists(assignmentMdPath))) {
      throw new AssignmentTargetError(
        `Open engagement points to a missing ticket: ${ticketDir}.`,
      );
    }
    const id =
      (await readTicketFrontmatterId(ticketDir)) ??
      binding.ticketId ??
      binding.ticketSlug;
    return withResolvedCompat({
      ticketDir,
      projectSlug: binding.projectSlug,
      ticketSlug: binding.ticketSlug,
      id,
      standalone: false,
      stage: binding.stage,
    });
  }

  // Standalone engagement: prefer the resolved id, else the slug-as-UUID.
  const standaloneId = binding.ticketId ?? binding.ticketSlug;
  if (!standaloneId) {
    throw new AssignmentTargetError(
      'Open engagement has neither a ticket id nor a slug to resolve.',
    );
  }
  // The id becomes a path segment under the standalone tickets dir — reject
  // separators / traversal / absolute so a malformed DB binding can't resolve
  // outside ticketsDir(). (Project-nested slugs go through isValidSlug above.)
  if (
    standaloneId.includes('/') ||
    standaloneId.includes('\\') ||
    standaloneId.includes('..') ||
    standaloneId.startsWith('.')
  ) {
    throw new AssignmentTargetError(
      `Open engagement has an unsafe standalone ticket id: "${standaloneId}".`,
    );
  }
  const dir = resolve(ticketsDirFn(), standaloneId);
  const assignmentMdPath = resolve(dir, 'ticket.md');
  if (!(await fileExists(assignmentMdPath))) {
    throw new AssignmentTargetError(
      `Open engagement points to a missing standalone ticket: ${dir}.`,
    );
  }
  const id = (await readTicketFrontmatterId(dir)) ?? standaloneId;
  return withResolvedCompat({
    ticketDir: dir,
    projectSlug: null,
    ticketSlug: standaloneId,
    id,
    standalone: true,
    stage: binding.stage,
  });
}
