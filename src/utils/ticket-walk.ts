import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileExists } from './fs.js';
import { parseTicketFolderName } from './ticket-folder.js';

export interface TicketEntry {
  projectDir: string;
  projectSlug: string;
  ticketDir: string;
  /** Slug from frontmatter or parsed from the `<ID>-<slug>` folder name. */
  ticketSlug: string;
  /** Ticket id parsed from the folder name when present. */
  ticketId: string | null;
  /** @deprecated Standalone tickets were removed; always false. */
  standalone: false;
}

export interface TicketWalkResult {
  withTicketMd: TicketEntry[];
  orphanFolders: TicketEntry[];
}

export async function listTicketsByProject(
  projectsDir: string,
): Promise<TicketWalkResult> {
  const result: TicketWalkResult = {
    withTicketMd: [],
    orphanFolders: [],
  };

  if (await fileExists(projectsDir)) {
    const projects = await readdir(projectsDir, { withFileTypes: true });
    for (const m of projects) {
      if (!m.isDirectory()) continue;
      if (m.name.startsWith('.') || m.name.startsWith('_')) continue;
      const ticketsPath = resolve(projectsDir, m.name, 'tickets');
      if (!(await fileExists(ticketsPath))) continue;

      const entries = await readdir(ticketsPath, { withFileTypes: true });
      for (const a of entries) {
        if (!a.isDirectory()) continue;
        if (a.name.startsWith('.') || a.name.startsWith('_')) continue;
        const ticketDir = resolve(ticketsPath, a.name);
        const ticketMd = resolve(ticketDir, 'ticket.md');
        const parsedFolder = parseTicketFolderName(a.name);
        const entry: TicketEntry = {
          projectDir: resolve(projectsDir, m.name),
          projectSlug: m.name,
          ticketDir,
          ticketSlug: parsedFolder?.slug ?? a.name,
          ticketId: parsedFolder?.id ?? null,
          standalone: false,
        };
        if (await fileExists(ticketMd)) {
          result.withTicketMd.push(entry);
        } else {
          result.orphanFolders.push(entry);
        }
      }
    }
  }

  return result;
}
