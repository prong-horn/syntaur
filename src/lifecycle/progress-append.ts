import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { formatProgressEntry, renderProgress } from '../templates/index.js';
import { parseTicketFrontmatter } from './frontmatter.js';
import { syntaurRoot } from '../utils/paths.js';
import {
  loadTemplate,
  resolveTemplateForTicket,
  LEGACY_TEMPLATE_ID,
} from '../ticket-templates/registry.js';
import { logRoleFile } from '../ticket-templates/manifest.js';
import { injectPurpose } from '../ticket-templates/scaffold.js';

/**
 * Insert a new entry immediately after the `# Progress` H1 (reverse-chronological),
 * replacing the `No progress yet.` placeholder if present. Frontmatter `entryCount`
 * is incremented and `updated` bumped; `ticket` and `generated` are preserved
 * verbatim (we edit the raw frontmatter rather than round-tripping through a parser
 * that would drop `generated`).
 */
export function appendProgressEntry(content: string, entry: string, now: string): string {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---\n?)([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error('progress.md has no YAML frontmatter.');
  }
  const [, open, fmBody, close, body] = fmMatch;

  let newFm = fmBody;
  const countMatch = newFm.match(/^entryCount:\s*(\d+)\s*$/m);
  const nextCount = countMatch ? parseInt(countMatch[1], 10) + 1 : 1;
  if (countMatch) {
    newFm = newFm.replace(/^entryCount:\s*\d+\s*$/m, `entryCount: ${nextCount}`);
  } else {
    newFm = `${newFm}\nentryCount: ${nextCount}`;
  }
  if (/^updated:\s*.*$/m.test(newFm)) {
    newFm = newFm.replace(/^updated:\s*.*$/m, `updated: "${now}"`);
  } else {
    newFm = `${newFm}\nupdated: "${now}"`;
  }

  const entryBlock = formatProgressEntry(entry, now);

  let newBody = body.replace(/\n?No progress yet\.\s*\n?/, '\n');
  const h1 = newBody.match(/^#\sProgress\s*$/m);
  if (h1) {
    const idx = newBody.indexOf(h1[0]) + h1[0].length;
    const before = newBody.slice(0, idx).replace(/\s*$/, '');
    const after = newBody.slice(idx).replace(/^\s*/, '');
    newBody = `${before}\n\n${entryBlock}${after.length > 0 ? `\n${after}` : ''}`;
  } else {
    newBody = `# Progress\n\n${entryBlock}${newBody.trim().length > 0 ? `\n${newBody.trim()}\n` : ''}`;
  }
  if (!newBody.endsWith('\n')) newBody += '\n';

  return `${open}${newFm}${close.startsWith('\n') ? close : `\n${close}`}${newBody}`;
}

function appendJournalEntry(content: string, entry: string, now: string, author: string): string {
  const heading = `## ${now} · progress · ${author}`;
  const block = `${heading}\n\n${entry.trim()}\n`;
  const trimmed = content.trimEnd();
  if (trimmed.length === 0) {
    return `${block}\n`;
  }
  return `${trimmed}\n\n${block}\n`;
}

async function resolveLogRole(ticketDir: string): Promise<{
  templateId: string;
  logPath: string;
  description: string;
  legacyProgress: boolean;
}> {
  const ticketMdPath = resolve(ticketDir, 'ticket.md');
  let templateId = LEGACY_TEMPLATE_ID;
  if (await fileExists(ticketMdPath)) {
    const content = await readFile(ticketMdPath, 'utf-8');
    const fm = parseTicketFrontmatter(content);
    templateId = resolveTemplateForTicket(fm);
  }

  const manifest = await loadTemplate(syntaurRoot(), templateId);
  const logRole = logRoleFile(manifest);
  if (!logRole) {
    throw new Error(`template ${templateId} has no log role; use the chat`);
  }

  return {
    templateId,
    logPath: logRole.path,
    description: logRole.description,
    legacyProgress: logRole.path === 'progress.md',
  };
}

export interface AppendProgressLogInput {
  ticketDir: string;
  ticketRef: string;
  text: string;
  author: string;
}

/** Append a progress entry to the template's log-role file. */
export async function appendProgressLog(
  input: AppendProgressLogInput,
): Promise<{ path: string; timestamp: string }> {
  const { logPath, description, legacyProgress } = await resolveLogRole(input.ticketDir);
  const path = resolve(input.ticketDir, logPath);
  const now = nowTimestamp();

  if (legacyProgress) {
    const content = (await fileExists(path))
      ? await readFile(path, 'utf-8')
      : renderProgress({ ticket: input.ticketRef, timestamp: now });

    const next = appendProgressEntry(content, input.text, now);
    await writeFileForce(path, next);
    return { path, timestamp: now };
  }

  let content: string;
  if (await fileExists(path)) {
    content = await readFile(path, 'utf-8');
  } else {
    content = injectPurpose('', description);
  }

  const next = appendJournalEntry(content, input.text, now, input.author);
  await writeFileForce(path, next);
  return { path, timestamp: now };
}

/** Whether the ticket template declares a log role (for broker skip). */
export async function ticketHasLogRole(ticketDir: string): Promise<boolean> {
  try {
    await resolveLogRole(ticketDir);
    return true;
  } catch {
    return false;
  }
}
