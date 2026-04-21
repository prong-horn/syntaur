import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expandHome, assignmentsDir as assignmentsDirFn } from '../utils/paths.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import { generateId } from '../utils/uuid.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';
import { renderComments, formatCommentEntry, type Comment, type CommentType } from '../templates/index.js';

export interface CommentOptions {
  project?: string;
  dir?: string;
  replyTo?: string;
  type?: CommentType;
  author?: string;
}

function shortId(): string {
  return generateId().split('-')[0];
}

function setTopLevelField(content: string, key: string, value: string | number): string {
  const fieldRegex = new RegExp(`^(${key}:)\\s*.*$`, 'm');
  if (fieldRegex.test(content)) {
    return content.replace(fieldRegex, `$1 ${value}`);
  }
  return content;
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

  let assignmentDir: string;
  let assignmentRef: string;
  if (options.project) {
    if (!isValidSlug(options.project)) {
      throw new Error(`Invalid project slug "${options.project}".`);
    }
    if (!isValidSlug(target)) {
      throw new Error(`Invalid assignment slug "${target}".`);
    }
    assignmentDir = resolve(baseDir, options.project, 'assignments', target);
    assignmentRef = target;
  } else {
    const resolved = await resolveAssignmentById(baseDir, assignmentsDirFn(), target);
    if (!resolved) {
      throw new Error(`Assignment "${target}" not found. Provide --project <slug> or a valid standalone UUID.`);
    }
    assignmentDir = resolved.assignmentDir;
    assignmentRef = resolved.standalone ? resolved.id : resolved.assignmentSlug;
  }

  const commentsPath = resolve(assignmentDir, 'comments.md');
  const timestamp = nowTimestamp();
  const author = options.author ?? process.env.USER ?? 'unknown';

  let currentContent: string;
  let currentCount = 0;
  if (await fileExists(commentsPath)) {
    currentContent = await readFile(commentsPath, 'utf-8');
    const countMatch = currentContent.match(/^entryCount:\s*(\d+)/m);
    if (countMatch) currentCount = parseInt(countMatch[1], 10);
  } else {
    currentContent = renderComments({ assignment: assignmentRef, timestamp });
  }

  const comment: Comment = {
    id: shortId(),
    timestamp,
    author,
    type,
    body: text,
    replyTo: options.replyTo,
    resolved: type === 'question' ? false : undefined,
  };

  const entry = formatCommentEntry(comment);
  const nextCount = currentCount + 1;

  let next = setTopLevelField(currentContent, 'entryCount', nextCount);
  next = setTopLevelField(next, 'updated', `"${timestamp}"`);

  if (next.includes('No comments yet.')) {
    next = next.replace('No comments yet.', entry.trimEnd());
  } else {
    next = `${next.trimEnd()}\n\n${entry}`;
  }

  await writeFileForce(commentsPath, next);

  console.log(`Added ${type} comment ${comment.id} to ${assignmentRef} (${commentsPath})`);
  if (options.replyTo) {
    console.log(`  In reply to: ${options.replyTo}`);
  }
}
