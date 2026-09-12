import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expandHome, ticketsDir as ticketsDirFn } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import { resolveTicketById, resolveTicketSlugInProject } from '../utils/ticket-resolver.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { emitEvent } from '../lifecycle/event-emit.js';
import { appendComment } from '../lifecycle/comment-append.js';
import { type CommentType } from '../templates/index.js';

export interface CommentOptions {
  project?: string;
  dir?: string;
  replyTo?: string;
  type?: CommentType;
  author?: string;
}

export async function commentCommand(
  target: string,
  text: string,
  options: CommentOptions = {},
): Promise<void> {
  if (!text || !text.trim()) {
    throw new Error('Comment text cannot be empty.');
  }

  const type: CommentType = options.type ?? 'note';
  if (!['question', 'note', 'feedback'].includes(type)) {
    throw new Error(`Invalid comment type "${type}". Must be one of: question, note, feedback.`);
  }

  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;

  let ticketDir: string;
  let ticketRef: string;
  let projectSlug: string | null = null;
  if (options.project) {
    if (!isValidSlug(options.project)) {
      throw new Error(`Invalid project slug "${options.project}".`);
    }
    if (!isValidSlug(target)) {
      throw new Error(`Invalid ticket slug "${target}".`);
    }
    const resolved = await resolveTicketSlugInProject(baseDir, options.project, target);
    if (!resolved) {
      throw new Error(`Ticket "${target}" not found in project "${options.project}".`);
    }
    ticketDir = resolved.ticketDir;
    ticketRef = resolved.ticketSlug;
    projectSlug = options.project;
  } else {
    const resolved = await resolveTicketById(baseDir, ticketsDirFn(), target);
    if (!resolved) {
      throw new Error(`Ticket "${target}" not found. Provide --project <slug> or a valid standalone UUID.`);
    }
    ticketDir = resolved.ticketDir;
    ticketRef = resolved.standalone ? resolved.id : resolved.ticketSlug;
    projectSlug = resolved.projectSlug;
  }

  const commentsPath = resolve(ticketDir, 'comments.md');
  const author = options.author ?? process.env.USER ?? 'unknown';

  const commentId = await appendComment({
    ticketDir,
    ticketRef,
    author,
    type,
    body: text,
    replyTo: options.replyTo,
  });

  // Audit event (best-effort): comment-added. Details carry author + a short
  // excerpt/length ONLY — never the full body (no sensitive data in the log).
  try {
    const ticketMd = resolve(ticketDir, 'ticket.md');
    if (await fileExists(ticketMd)) {
      const fm = parseTicketFrontmatter(await readFile(ticketMd, 'utf-8'));
      emitEvent({
        ticketId: fm.id,
        projectSlug,
        type: 'comment-added',
        actor: author,
        details: {
          commentId,
          author,
          commentType: type,
          length: text.length,
          excerpt: text.slice(0, 80),
        },
      });
    }
  } catch {
    /* best-effort: a failed audit emit must never break the comment */
  }

  console.log(`Added ${type} comment ${commentId} to ${ticketRef} (${commentsPath})`);
  if (options.replyTo) {
    console.log(`  In reply to: ${options.replyTo}`);
  }
}
