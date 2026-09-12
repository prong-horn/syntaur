import { resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileExists } from './fs.js';
import { extractFrontmatter, getField } from '../dashboard/parser.js';

export interface ResolvedTicket {
  ticketDir: string;
  projectSlug: string | null;
  ticketSlug: string;
  id: string;
  standalone: boolean;
  /**
   * The engagement stage this target was resolved at, when resolution came from
   * the session's open engagement (Case 3). Undefined for explicit `--project`
   * / bare-id resolution, which carries no engagement.
   */
  stage?: string;
  /** @deprecated Dashboard compat until Task 2 */
  assignmentDir: string;
  /** @deprecated Dashboard compat until Task 2 */
  assignmentSlug: string;
  /** @deprecated Dashboard compat until Task 2 */
  assignmentId: string;
}

export function withResolvedCompat(
  ticket: Omit<ResolvedTicket, 'assignmentDir' | 'assignmentSlug' | 'assignmentId'>,
): ResolvedTicket {
  return {
    ...ticket,
    assignmentDir: ticket.ticketDir,
    assignmentSlug: ticket.ticketSlug,
    assignmentId: ticket.id,
  };
}

export async function resolveTicketById(
  projectsDir: string,
  ticketsDir: string,
  id: string,
): Promise<ResolvedTicket | null> {
  let standaloneMatch: ResolvedTicket | null = null;
  let projectMatch: ResolvedTicket | null = null;

  // 1) Standalone: <ticketsDir>/<id>/ticket.md
  const standaloneDir = resolve(ticketsDir, id);
  const standalonePath = resolve(standaloneDir, 'ticket.md');
  if (await fileExists(standalonePath)) {
    standaloneMatch = withResolvedCompat({
      ticketDir: standaloneDir,
      projectSlug: null,
      ticketSlug: id,
      id,
      standalone: true,
    });
  }

  // 2) Project-nested: scan <projectsDir>/*/tickets/*/ticket.md and match by frontmatter id
  if (await fileExists(projectsDir)) {
    try {
      const projects = await readdir(projectsDir, { withFileTypes: true });
      for (const p of projects) {
        if (!p.isDirectory()) continue;
        if (p.name.startsWith('.') || p.name.startsWith('_')) continue;
        const assignmentsPath = resolve(projectsDir, p.name, 'tickets');
        if (!(await fileExists(assignmentsPath))) continue;

        const entries = await readdir(assignmentsPath, { withFileTypes: true });
        for (const a of entries) {
          if (!a.isDirectory()) continue;
          const aPath = resolve(assignmentsPath, a.name, 'ticket.md');
          if (!(await fileExists(aPath))) continue;

          try {
            const content = await readFile(aPath, 'utf-8');
            const [fm] = extractFrontmatter(content);
            const fileId = getField(fm, 'id');
            if (fileId === id) {
              projectMatch = withResolvedCompat({
                ticketDir: resolve(assignmentsPath, a.name),
                projectSlug: p.name,
                ticketSlug: a.name,
                id,
                standalone: false,
              });
              break;
            }
          } catch {
            // skip unreadable
          }
        }
        if (projectMatch) break;
      }
    } catch {
      // projectsDir not readable
    }
  }

  if (standaloneMatch && projectMatch) {
    console.warn(
      `Duplicate ticket ID ${id} found in both standalone and project-nested locations; using standalone`,
    );
    return standaloneMatch;
  }

  return standaloneMatch ?? projectMatch ?? null;
}

export interface ResolvedTicketBySlug {
  /** True iff the ticket.md exists and is readable at the deterministic path. */
  exists: boolean;
  /** The frontmatter `id`, or null when the file is missing/unreadable/idless. */
  id: string | null;
}

/**
 * Resolve a ticket's frontmatter `id` (and existence) from its SLUGS via the
 * deterministic on-disk path — no directory scan. Project-nested:
 * `<projectsDir>/<projectSlug>/tickets/<ticketSlug>/ticket.md`;
 * standalone (`projectSlug == null`): `<ticketsDir>/<ticketSlug>/ticket.md`.
 *
 * Returns `{exists:false, id:null}` when the file is absent/unreadable,
 * `{exists:true, id:null}` when it exists but has no frontmatter `id`, and
 * `{exists:true, id}` otherwise. Never throws — registration/binding callers use it
 * best-effort: M1 (track/grab/API) takes `.id` to store `assignment_id`; the L
 * dashboard-POST gate gates on `.exists`. Distinguishing missing-vs-idless is why
 * this returns a struct rather than `string | null`.
 */
export async function resolveTicketBySlug(
  projectsDir: string,
  ticketsDir: string,
  projectSlug: string | null,
  ticketSlug: string,
): Promise<ResolvedTicketBySlug> {
  const path = projectSlug
    ? resolve(projectsDir, projectSlug, 'tickets', ticketSlug, 'ticket.md')
    : resolve(ticketsDir, ticketSlug, 'ticket.md');
  if (!(await fileExists(path))) return { exists: false, id: null };
  try {
    const content = await readFile(path, 'utf-8');
    const [fm] = extractFrontmatter(content);
    const id = getField(fm, 'id');
    return { exists: true, id: id ?? null };
  } catch {
    // exists on disk but unreadable — treat as not-resolvable (best-effort)
    return { exists: false, id: null };
  }
}
