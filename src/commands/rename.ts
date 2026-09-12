import { rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { readConfig } from '../utils/config.js';
import { expandHome } from '../utils/paths.js';
import { writeFileForce, fileExists } from '../utils/fs.js';
import { isValidSlug, slugify } from '../utils/slug.js';
import { isTicketId } from '../utils/ticket-ids.js';
import { resolveTicketById } from '../utils/ticket-resolver.js';
import { formatTicketFolderName } from '../utils/ticket-folder.js';
import { extractFrontmatter } from '../dashboard/parser.js';

export interface RenameTicketOptions {
  dir?: string;
}

export async function renameCommand(
  ticketId: string,
  newSlug: string,
  options: RenameTicketOptions = {},
): Promise<void> {
  if (!isTicketId(ticketId)) {
    throw new Error(`Invalid ticket id "${ticketId}". Expected <PREFIX>-<n>.`);
  }

  const slug = isValidSlug(newSlug) ? newSlug : slugify(newSlug);
  if (!isValidSlug(slug)) {
    throw new Error(
      `Invalid slug "${slug}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }

  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;
  const resolved = await resolveTicketById(baseDir, ticketId);
  if (!resolved) {
    throw new Error(`Ticket "${ticketId}" not found.`);
  }

  const newFolder = formatTicketFolderName(ticketId, slug);
  const newTicketDir = resolve(
    baseDir,
    resolved.projectSlug,
    'tickets',
    newFolder,
  );
  if (resolved.ticketDir === newTicketDir) {
    console.log(`Ticket ${ticketId} already uses slug "${slug}".`);
    return;
  }
  if (await fileExists(newTicketDir)) {
    throw new Error(`Ticket folder already exists: ${newTicketDir}`);
  }

  const ticketMd = resolve(resolved.ticketDir, 'ticket.md');
  const content = await readFile(ticketMd, 'utf-8');
  const [fm, body] = extractFrontmatter(content);
  const updatedFm = /^slug:\s/m.test(fm)
    ? fm.replace(/^slug:\s*.*$/m, `slug: ${slug}`)
    : `${fm}\nslug: ${slug}`;
  await writeFileForce(ticketMd, `---\n${updatedFm}\n---${body}`);

  await rename(resolved.ticketDir, newTicketDir);

  console.log(`Renamed ticket ${ticketId} to slug "${slug}".`);
  console.log(`  ${resolved.ticketDir}`);
  console.log(`  → ${newTicketDir}`);
}
