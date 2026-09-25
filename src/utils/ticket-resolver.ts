import { basename, dirname, resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileExists } from './fs.js';
import { extractFrontmatter, getField } from '../dashboard/parser.js';
import { isTicketId } from './ticket-ids.js';
import {
  folderNameForTicketId,
  parseTicketFolderName,
} from './ticket-folder.js';

export interface MovedFromHint {
  id: string;
  project: string;
}

export interface ResolvedTicket {
  ticketDir: string;
  projectSlug: string;
  ticketSlug: string;
  id: string;
  /** @deprecated Standalone tickets were removed; always false. */
  standalone: false;
  /**
   * The engagement stage this target was resolved at, when resolution came from
   * the session's open engagement (Case 3). Undefined for explicit id resolution.
   */
  stage?: string;
  /** Set when the requested id was resolved via a ticket's `movedFrom` alias. */
  movedFrom?: MovedFromHint;
}

export class TicketResolverError extends Error {}

import { parseYamlBlockList } from './ticket-frontmatter-patch.js';

/** Parse `movedFrom:` block-list entries (`OLD@project`). */
export function parseMovedFrom(frontmatter: string): MovedFromHint[] {
  const results: MovedFromHint[] = [];
  for (const raw of parseYamlBlockList(frontmatter, 'movedFrom')) {
    const at = raw.indexOf('@');
    if (at <= 0) continue;
    const aliasId = raw.slice(0, at).trim();
    const project = raw.slice(at + 1).trim();
    if (!isTicketId(aliasId) || !project) continue;
    results.push({ id: aliasId, project });
  }
  return results;
}

export async function resolveTicketByIdDirect(
  projectsDir: string,
  id: string,
): Promise<ResolvedTicket | null> {
  if (!isTicketId(id)) return null;
  if (!(await fileExists(projectsDir))) return null;

  const matches: ResolvedTicket[] = [];
  try {
    const projects = await readdir(projectsDir, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      if (project.name.startsWith('.') || project.name.startsWith('_')) continue;
      const ticketsPath = resolve(projectsDir, project.name, 'tickets');
      if (!(await fileExists(ticketsPath))) continue;

      const entries = await readdir(ticketsPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
        if (!folderNameForTicketId(entry.name, id)) continue;

        const ticketDir = resolve(ticketsPath, entry.name);
        const ticketMdPath = resolve(ticketDir, 'ticket.md');
        if (!(await fileExists(ticketMdPath))) continue;

        const parsedFolder = parseTicketFolderName(entry.name);
        let ticketSlug = parsedFolder?.slug ?? entry.name;
        let fileId = id;
        try {
          const content = await readFile(ticketMdPath, 'utf-8');
          const [fm] = extractFrontmatter(content);
          fileId = getField(fm, 'id') ?? id;
          ticketSlug = getField(fm, 'slug') ?? ticketSlug;
        } catch {
          // keep folder-derived slug
        }

        if (fileId !== id) continue;

        matches.push({
          ticketDir,
          projectSlug: project.name,
          ticketSlug,
          id,
          standalone: false,
        });
      }
    }
  } catch {
    return null;
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new TicketResolverError(
      `Multiple tickets match id "${id}"; expected exactly one folder matching ^${id}-`,
    );
  }
  return matches[0];
}

export async function resolveTicketByMovedFromAlias(
  projectsDir: string,
  id: string,
  projectFilter?: string,
): Promise<ResolvedTicket | null> {
  if (!isTicketId(id)) return null;
  if (!(await fileExists(projectsDir))) return null;

  const matches: ResolvedTicket[] = [];
  try {
    const projects = await readdir(projectsDir, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      if (project.name.startsWith('.') || project.name.startsWith('_')) continue;
      const ticketsPath = resolve(projectsDir, project.name, 'tickets');
      if (!(await fileExists(ticketsPath))) continue;

      const entries = await readdir(ticketsPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

        const ticketDir = resolve(ticketsPath, entry.name);
        const ticketMdPath = resolve(ticketDir, 'ticket.md');
        if (!(await fileExists(ticketMdPath))) continue;

        try {
          const content = await readFile(ticketMdPath, 'utf-8');
          const [fm] = extractFrontmatter(content);
          const fileId = getField(fm, 'id');
          const ticketSlug = getField(fm, 'slug') ?? parseTicketFolderName(entry.name)?.slug ?? entry.name;
          if (!fileId || !isTicketId(fileId)) continue;

          for (const alias of parseMovedFrom(fm)) {
            if (alias.id !== id) continue;
            if (projectFilter && alias.project !== projectFilter) continue;
            matches.push({
              ticketDir,
              projectSlug: project.name,
              ticketSlug,
              id: fileId,
              standalone: false,
              movedFrom: { id: alias.id, project: alias.project },
            });
          }
        } catch {
          // skip unreadable
        }
      }
    }
  } catch {
    return null;
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new TicketResolverError(
      `Multiple tickets match id "${id}" via movedFrom; expected exactly one.`,
    );
  }
  return matches[0];
}

export async function resolveTicketById(
  projectsDir: string,
  id: string,
): Promise<ResolvedTicket | null> {
  const direct = await resolveTicketByIdDirect(projectsDir, id);
  if (direct) return direct;
  return resolveTicketByMovedFromAlias(projectsDir, id);
}

/** Resolve `ticket.md` within a project dir by slug or ticket id. */
export async function resolveTicketMdPathInProject(
  projectDir: string,
  slugOrId: string,
): Promise<string | null> {
  const ticketsPath = resolve(projectDir, 'tickets');
  const direct = resolve(ticketsPath, slugOrId, 'ticket.md');
  if (await fileExists(direct)) return direct;

  if (isTicketId(slugOrId)) {
    try {
      const entries = await readdir(ticketsPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!folderNameForTicketId(entry.name, slugOrId)) continue;
        const path = resolve(ticketsPath, entry.name, 'ticket.md');
        if (await fileExists(path)) return path;
      }
    } catch {
      return null;
    }
    return null;
  }

  const projectsDir = dirname(projectDir);
  const projectSlug = basename(projectDir);
  const resolved = await resolveTicketSlugInProject(projectsDir, projectSlug, slugOrId);
  return resolved ? resolve(resolved.ticketDir, 'ticket.md') : null;
}

/** Resolve a ticket slug within one project by scanning `tickets/` folder names. */
export async function resolveTicketSlugInProject(
  projectsDir: string,
  projectSlug: string,
  ticketSlug: string,
): Promise<ResolvedTicket | null> {
  const ticketsPath = resolve(projectsDir, projectSlug, 'tickets');
  if (!(await fileExists(ticketsPath))) return null;

  const suffix = `-${ticketSlug}`;
  const entries = await readdir(ticketsPath, { withFileTypes: true });
  const matches: ResolvedTicket[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parsed = parseTicketFolderName(entry.name);
    const slugMatches =
      parsed?.slug === ticketSlug || entry.name === ticketSlug || entry.name.endsWith(suffix);
    if (!slugMatches) continue;

    const ticketDir = resolve(ticketsPath, entry.name);
    const ticketMdPath = resolve(ticketDir, 'ticket.md');
    if (!(await fileExists(ticketMdPath))) continue;

    try {
      const content = await readFile(ticketMdPath, 'utf-8');
      const [fm] = extractFrontmatter(content);
      const id = getField(fm, 'id');
      const slug = getField(fm, 'slug') ?? parsed?.slug ?? ticketSlug;
      if (!id || !isTicketId(id)) continue;
      if (slug !== ticketSlug) continue;
      matches.push({
        ticketDir,
        projectSlug,
        ticketSlug: slug,
        id,
        standalone: false,
      });
    } catch {
      // skip unreadable
    }
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new TicketResolverError(
      `Multiple tickets match slug "${ticketSlug}" in project "${projectSlug}".`,
    );
  }
  return matches[0];
}
