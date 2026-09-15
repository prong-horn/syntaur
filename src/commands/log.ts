import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { resolveTicketTarget } from '../utils/ticket-target.js';
import { resolveSessionEngagement } from '../utils/engagement-binding.js';
import { assertMayMutate } from '../utils/session-id.js';
import { VerbRefusedError } from '../lifecycle/verbs.js';
import { appendTypedLogEntry, resolveLogRole } from '../lifecycle/log-append.js';
import { appendChatNote } from '../chat/notes.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { syntaurRoot } from '../utils/paths.js';
import { loadTemplate, resolveTemplateForTicket } from '../ticket-templates/registry.js';
import { LOG_ENTRY_TYPES, logRoleFile, type LogEntryType } from '../ticket-templates/manifest.js';
import { parseLogEntries } from '../ticket-templates/log-reader.js';
import {
  MAX_CHAT_ATTACHMENTS,
  resolveImageMime,
  writeChatAttachment,
  ChatAttachmentError,
} from '../chat/attachments.js';

export interface LogOptions {
  project?: string;
  type?: string;
  agent?: string;
  verdict?: string;
  open?: string;
  answers?: string;
  attach?: string[];
}

function parseOpenCounts(raw: string): string {
  const parts = raw.split(',').map((s) => s.trim());
  let high: number | null = null;
  let medium: number | null = null;
  for (const part of parts) {
    const hm = part.match(/^high=(\d+)$/);
    const mm = part.match(/^medium=(\d+)$/);
    if (hm) high = parseInt(hm[1], 10);
    else if (mm) medium = parseInt(mm[1], 10);
    else throw new VerbRefusedError(`Invalid --open value: ${raw}`);
  }
  if (high === null || medium === null) {
    throw new VerbRefusedError('review requires --verdict and --open');
  }
  return `high=${high} medium=${medium}`;
}

async function resolveAuthor(cwd: string, explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  try {
    const { initSessionDb } = await import('../dashboard/session-db.js');
    const { getSessionById } = await import('../dashboard/agent-sessions.js');
    initSessionDb();
    const se = await resolveSessionEngagement(cwd);
    if (se?.session.id) {
      const row = getSessionById(se.session.id);
      if (row?.agent) return row.agent;
    }
  } catch {
    /* no session db */
  }
  return 'human';
}

async function validateEntryType(
  ticketDir: string,
  type: LogEntryType,
): Promise<void> {
  const ticketMd = resolve(ticketDir, 'ticket.md');
  const content = await readFile(ticketMd, 'utf-8');
  const fm = parseTicketFrontmatter(content);
  const manifest = await loadTemplate(syntaurRoot(), resolveTemplateForTicket(fm));
  const logRole = logRoleFile(manifest);
  if (!logRole) return;
  if (!logRole.entryTypes.includes(type)) {
    throw new VerbRefusedError(
      `Entry type "${type}" is not allowed on ${logRole.path} for template ${manifest.id}`,
    );
  }
}

async function validateAnswerTarget(ticketDir: string, answersTs: string): Promise<void> {
  const { logPath } = await resolveLogRole(ticketDir);
  const path = resolve(ticketDir, logPath);
  if (!(await fileExists(path))) {
    throw new VerbRefusedError(`No question entry at ${answersTs}`);
  }
  const entries = parseLogEntries(await readFile(path, 'utf-8'));
  const question = entries.find((e) => e.type === 'question' && e.timestamp === answersTs);
  if (!question) {
    throw new VerbRefusedError(`No question entry at ${answersTs}`);
  }
}

async function processAttachments(
  ticketDir: string,
  paths: string[],
): Promise<string> {
  if (paths.length > MAX_CHAT_ATTACHMENTS) {
    throw new VerbRefusedError(`At most ${MAX_CHAT_ATTACHMENTS} attachments per entry`);
  }
  const stored: string[] = [];
  for (const filePath of paths) {
    const abs = resolve(filePath);
    let bytes: Buffer;
    try {
      bytes = await readFile(abs);
    } catch {
      throw new VerbRefusedError(`Cannot read attachment: ${filePath}`);
    }
    const mime = resolveImageMime(bytes, abs);
    if (!mime) {
      throw new VerbRefusedError(`Unsupported attachment type: ${filePath}`);
    }
    try {
      const result = await writeChatAttachment(ticketDir, {
        name: abs.split('/').pop() ?? 'file',
        mime,
        bytes,
      });
      stored.push(result.stored);
    } catch (err) {
      const msg = err instanceof ChatAttachmentError ? err.message : String(err);
      throw new VerbRefusedError(msg);
    }
  }
  return stored.join(', ');
}

export async function runLog(
  ticket: string,
  body: string,
  options: LogOptions,
  cwd: string = process.cwd(),
): Promise<string> {
  if (!body?.trim()) {
    throw new VerbRefusedError('Log body is required');
  }
  const typeRaw = options.type?.trim();
  if (!typeRaw) {
    throw new VerbRefusedError('Entry type is required (-t <type>)');
  }
  if (!(LOG_ENTRY_TYPES as readonly string[]).includes(typeRaw)) {
    throw new VerbRefusedError(`Unknown entry type: ${typeRaw}`);
  }
  const type = typeRaw as LogEntryType;

  const target = await resolveTicketTarget(ticket, {
    project: options.project,
    cwd,
    resolveEngagement: async () => {
      const { initSessionDb } = await import('../dashboard/session-db.js');
      initSessionDb();
      const se = await resolveSessionEngagement(cwd);
      return se?.open ?? null;
    },
  });

  try {
    const { initSessionDb } = await import('../dashboard/session-db.js');
    initSessionDb();
    const se = await resolveSessionEngagement(cwd);
    if (se) assertMayMutate(se.session, { hasSelector: true });
  } catch {
    /* engagement optional when ticket given */
  }

  const author = await resolveAuthor(cwd, options.agent);

  let hasLogRole = true;
  try {
    await resolveLogRole(target.ticketDir);
    await validateEntryType(target.ticketDir, type);
  } catch (err) {
    if (err instanceof VerbRefusedError) throw err;
    hasLogRole = false;
  }

  if (!hasLogRole) {
    const { timestamp } = await appendChatNote(target.ticketDir, target.id, author, body.trim());
    return `Logged note to chat (${timestamp})`;
  }

  const keys: Record<string, string> = {};

  if (type === 'review') {
    if (!options.verdict?.trim() || !options.open?.trim()) {
      throw new VerbRefusedError('review requires --verdict and --open');
    }
    const verdict = options.verdict.trim();
    if (verdict !== 'approve' && verdict !== 'changes') {
      throw new VerbRefusedError('review --verdict must be approve or changes');
    }
    const openPart = parseOpenCounts(options.open.trim());
    keys.verdict = `${verdict} · open: ${openPart}`;
  }

  if (type === 'answer') {
    if (!options.answers?.trim()) {
      throw new VerbRefusedError('answer requires --answers naming an existing question entry');
    }
    await validateAnswerTarget(target.ticketDir, options.answers.trim());
    keys.answers = options.answers.trim();
  }

  if (options.attach?.length) {
    keys.attachments = await processAttachments(target.ticketDir, options.attach);
  }

  const { path, timestamp } = await appendTypedLogEntry({
    ticketDir: target.ticketDir,
    ticketId: target.id,
    projectSlug: target.projectSlug,
    type,
    body: body.trim(),
    author,
    keys: Object.keys(keys).length > 0 ? keys : undefined,
    actor: author,
  });

  const relPath = path.startsWith(target.ticketDir)
    ? path.slice(target.ticketDir.length + 1)
    : path;
  return `Logged ${type} to ${relPath} (${timestamp})`;
}

export const logCommand = new Command('log')
  .description('Append a typed entry to the ticket log role (or a chat note when none)')
  .argument('<ticket>', 'Ticket id')
  .argument('<body>', 'Entry body')
  .option('-t, --type <type>', 'Entry type (progress, decision, handoff, note, question, answer, review)')
  .option('--project <slug>', 'Project slug when the ticket is project-nested')
  .option('--agent <id>', 'Author agent id (default: session agent or human)')
  .option('--verdict <v>', 'Review verdict: approve or changes')
  .option('--open <counts>', 'Review open counts: high=<n>,medium=<n>')
  .option('--answers <iso>', 'Question entry timestamp answered by this entry')
  .option(
    '--attach <path>',
    'Image attachment path (repeatable)',
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .action(async (ticket: string, body: string, options: LogOptions) => {
    try {
      console.log(await runLog(ticket, body, options));
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
