/**
 * The file-append core of `syntaur comment`, factored out so non-CLI callers
 * (the WS-2 engine's dissent-note copy) can add a comment to an assignment's
 * `comments.md` without going through the command layer. `commentCommand`
 * delegates here for the write; it keeps its own resolution + audit emit.
 */

import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { generateId } from '../utils/uuid.js';
import { renderComments, formatCommentEntry, type Comment, type CommentType } from '../templates/index.js';

function setTopLevelField(content: string, key: string, value: string | number): string {
  const fieldRegex = new RegExp(`^(${key}:)\\s*.*$`, 'm');
  return fieldRegex.test(content) ? content.replace(fieldRegex, `$1 ${value}`) : content;
}

export interface AppendCommentInput {
  /** The assignment folder holding `comments.md`. */
  assignmentDir: string;
  /** Display ref used when scaffolding a fresh comments.md (slug or uuid). */
  assignmentRef: string;
  author: string;
  type: CommentType;
  body: string;
  replyTo?: string;
}

/** Append one comment to `<assignmentDir>/comments.md` (scaffolding the file if
 * absent), bumping `entryCount`/`updated`. Returns the new comment id. */
export async function appendComment(input: AppendCommentInput): Promise<string> {
  const commentsPath = resolve(input.assignmentDir, 'comments.md');
  const timestamp = nowTimestamp();

  let currentContent: string;
  let currentCount = 0;
  if (await fileExists(commentsPath)) {
    currentContent = await readFile(commentsPath, 'utf-8');
    const countMatch = currentContent.match(/^entryCount:\s*(\d+)/m);
    if (countMatch) currentCount = parseInt(countMatch[1], 10);
  } else {
    currentContent = renderComments({ assignment: input.assignmentRef, timestamp });
  }

  const comment: Comment = {
    id: generateId().split('-')[0],
    timestamp,
    author: input.author,
    type: input.type,
    body: input.body,
    replyTo: input.replyTo,
    resolved: input.type === 'question' ? false : undefined,
  };

  const entry = formatCommentEntry(comment);
  let next = setTopLevelField(currentContent, 'entryCount', currentCount + 1);
  next = setTopLevelField(next, 'updated', `"${timestamp}"`);
  if (next.includes('No comments yet.')) {
    next = next.replace('No comments yet.', entry.trimEnd());
  } else {
    next = `${next.trimEnd()}\n\n${entry}`;
  }
  await writeFileForce(commentsPath, next);
  return comment.id;
}
