import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileExists } from './fs.js';

export interface TicketEntry {
  projectDir: string;
  /** `null` for standalone tickets (no containing project). */
  projectSlug: string | null;
  ticketDir: string;
  /** For standalone, this is the UUID folder name. */
  ticketSlug: string;
  standalone: boolean;
}

export interface TicketWalkResult {
  withTicketMd: TicketEntry[];
  orphanFolders: TicketEntry[];
}

export async function listTicketsByProject(
  projectsDir: string,
  standaloneDir: string | null,
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
      const ticketsDir = resolve(projectsDir, m.name, 'tickets');
      if (!(await fileExists(ticketsDir))) continue;

      const entries = await readdir(ticketsDir, { withFileTypes: true });
      for (const a of entries) {
        if (!a.isDirectory()) continue;
        if (a.name.startsWith('.') || a.name.startsWith('_')) continue;
        const ticketDir = resolve(ticketsDir, a.name);
        const ticketMd = resolve(ticketDir, 'ticket.md');
        const entry: TicketEntry = {
          projectDir: resolve(projectsDir, m.name),
          projectSlug: m.name,
          ticketDir,
          ticketSlug: a.name,
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

  if (standaloneDir !== null && (await fileExists(standaloneDir))) {
    const entries = await readdir(standaloneDir, { withFileTypes: true });
    for (const a of entries) {
      if (!a.isDirectory()) continue;
      if (a.name.startsWith('.') || a.name.startsWith('_')) continue;
      const ticketDir = resolve(standaloneDir, a.name);
      const ticketMd = resolve(ticketDir, 'ticket.md');
      const entry: TicketEntry = {
        projectDir: standaloneDir,
        projectSlug: null,
        ticketDir,
        ticketSlug: a.name,
        standalone: true,
      };
      if (await fileExists(ticketMd)) {
        result.withTicketMd.push(entry);
      } else {
        result.orphanFolders.push(entry);
      }
    }
  }

  return result;
}
