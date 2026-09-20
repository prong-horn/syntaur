import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { renderProgress } from '../templates/index.js';
import { parseTicketFrontmatter } from './frontmatter.js';
import { syntaurRoot } from '../utils/paths.js';
import {
  loadTemplate,
  resolveTemplateForTicket,
  LEGACY_TEMPLATE_ID,
} from '../ticket-templates/registry.js';
import { logRoleFile, type LogEntryType } from '../ticket-templates/manifest.js';
import { injectPurpose } from '../ticket-templates/scaffold.js';
import { formatLogEntry, parseLogEntries } from '../ticket-templates/log-reader.js';
import { emitEvent } from './event-emit.js';

function formatYamlValue(value: boolean | number | string | null): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return `"${value}"`;
  }
  if (value === '' || /[:#{}[\],&*?|>!%@`]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Exported for regression testing (AC5). Pure string transform.
export function setTopLevelField(
  content: string,
  key: string,
  value: boolean | number | string | null,
): string {
  const formatted = formatYamlValue(value);

  const closingIdx = content.indexOf('\n---', 4);
  if (closingIdx === -1) {
    return content;
  }
  const frontmatter = content.slice(0, closingIdx);
  const rest = content.slice(closingIdx);
  const fieldRegex = new RegExp(`^(${escapeRegExp(key)}:)\\s*.*$`, 'm');

  if (fieldRegex.test(frontmatter)) {
    return `${frontmatter.replace(fieldRegex, `$1 ${formatted}`)}${rest}`;
  }

  return `${frontmatter}\n${key}: ${formatted}${rest}`;
}

export async function resolveLogRole(ticketDir: string): Promise<{
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

/** Whether the ticket template declares a log role (for broker skip). */
export async function ticketHasLogRole(ticketDir: string): Promise<boolean> {
  try {
    await resolveLogRole(ticketDir);
    return true;
  } catch {
    return false;
  }
}

function insertLegacyLogEntry(content: string, entryBlock: string): string {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---\n?)([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error('progress.md has no YAML frontmatter.');
  }
  const [, open, fmBody, close, body] = fmMatch;

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

  return `${open}${fmBody}${close.startsWith('\n') ? close : `\n${close}`}${newBody}`;
}

function appendJournalLogEntry(content: string, entryBlock: string): string {
  const trimmed = content.trimEnd();
  if (trimmed.length === 0) {
    return `${entryBlock}\n`;
  }
  return `${trimmed}\n\n${entryBlock}\n`;
}

function countSameSecond(entries: ReturnType<typeof parseLogEntries>, ts: string): number {
  return entries.filter((e) => e.timestamp === ts).length;
}

export interface AppendTypedLogEntryInput {
  ticketDir: string;
  ticketId: string;
  projectSlug?: string | null;
  type: LogEntryType;
  body: string;
  author: string;
  keys?: Record<string, string>;
  actor?: string;
}

/** Append a typed §4.2 log entry to the template's log-role file. */
export async function appendTypedLogEntry(
  input: AppendTypedLogEntryInput,
): Promise<{ path: string; timestamp: string }> {
  const { logPath, description, legacyProgress } = await resolveLogRole(input.ticketDir);
  const path = resolve(input.ticketDir, logPath);
  const now = nowTimestamp();

  const entryBlock = formatLogEntry({
    timestamp: now,
    type: input.type,
    author: input.author,
    keys: input.keys,
    body: input.body,
  });

  let content: string;
  if (await fileExists(path)) {
    content = await readFile(path, 'utf-8');
  } else if (legacyProgress) {
    content = renderProgress({ ticket: input.ticketId, timestamp: now });
  } else {
    content = injectPurpose('', description);
  }

  const next = legacyProgress
    ? insertLegacyLogEntry(content, entryBlock)
    : appendJournalLogEntry(content, entryBlock);

  await writeFileForce(path, next);

  const entries = parseLogEntries(next);
  const n = countSameSecond(entries, now);

  const details: Record<string, string> = { type: input.type };
  if (input.type === 'review' && input.keys?.verdict) {
    details.verdict = input.keys.verdict;
  }

  emitEvent({
    ticketId: input.ticketId,
    projectSlug: input.projectSlug ?? null,
    type: 'logged',
    actor: input.actor ?? input.author,
    at: now,
    details,
    sourceKey: `log~${input.ticketId}~${now}~${n}`,
  });

  return { path, timestamp: now };
}

export interface AppendProgressLogInput {
  ticketDir: string;
  ticketRef: string;
  text: string;
  author: string;
  projectSlug?: string | null;
}

/** Append a progress entry to the template's log-role file. */
export async function appendProgressLog(
  input: AppendProgressLogInput,
): Promise<{ path: string; timestamp: string }> {
  const ticketMdPath = resolve(input.ticketDir, 'ticket.md');
  let ticketId = input.ticketRef;
  if (await fileExists(ticketMdPath)) {
    const fm = parseTicketFrontmatter(await readFile(ticketMdPath, 'utf-8'));
    if (fm.id) ticketId = fm.id;
  }

  return appendTypedLogEntry({
    ticketDir: input.ticketDir,
    ticketId,
    projectSlug: input.projectSlug,
    type: 'progress',
    body: input.text,
    author: input.author,
  });
}
