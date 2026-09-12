/**
 * Shared comment-resolution helpers for the dashboard PATCH routes and the chat
 * broker. Both read `comments.md`, rewrite `**Resolved:**` on question entries,
 * and bump `updated`.
 */

import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { parseComments, type ParsedComment } from '../dashboard/parser.js';
import { setTopLevelField } from './log-append.js';

export interface SetCommentResolvedResult {
  changed: boolean;
  previous: boolean | null;
}

function rewriteResolvedLine(content: string, commentId: string, resolved: boolean): string | null {
  const entryBlockRegex = new RegExp(
    `(^## ${commentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?)(\\*\\*Resolved:\\*\\*\\s*(?:true|false))`,
    'm',
  );
  const next = content.replace(
    entryBlockRegex,
    (_m, preamble) => `${preamble}**Resolved:** ${resolved ? 'true' : 'false'}`,
  );
  return next === content ? null : next;
}

function isUnresolvedQuestion(c: ParsedComment): boolean {
  return c.type === 'question' && c.resolved !== true;
}

/** Toggle (or set) the resolved flag on one question comment. */
export async function setCommentResolved(
  ticketDir: string,
  commentId: string,
  resolved: boolean,
): Promise<SetCommentResolvedResult> {
  const commentsPath = resolve(ticketDir, 'comments.md');
  if (!(await fileExists(commentsPath))) {
    return { changed: false, previous: null };
  }

  const content = await readFile(commentsPath, 'utf-8');
  const parsed = parseComments(content);
  const target = parsed.entries.find((e) => e.id === commentId);
  if (!target || target.type !== 'question') {
    return { changed: false, previous: null };
  }

  const previous = target.resolved === true;
  if (previous === resolved) {
    return { changed: false, previous };
  }

  const next = rewriteResolvedLine(content, commentId, resolved);
  if (!next) {
    return { changed: false, previous };
  }

  const withUpdated = setTopLevelField(next, 'updated', nowTimestamp());
  await writeFileForce(commentsPath, withUpdated);
  return { changed: true, previous };
}

/** Resolve every unresolved question matching `predicate` in one write. */
export async function resolveQuestionComments(
  ticketDir: string,
  predicate: (c: ParsedComment) => boolean,
): Promise<string[]> {
  const commentsPath = resolve(ticketDir, 'comments.md');
  if (!(await fileExists(commentsPath))) {
    return [];
  }

  const content = await readFile(commentsPath, 'utf-8');
  const parsed = parseComments(content);
  const toResolve = parsed.entries.filter((c) => isUnresolvedQuestion(c) && predicate(c));
  if (toResolve.length === 0) {
    return [];
  }

  let next = content;
  const ids: string[] = [];
  for (const c of toResolve) {
    const rewritten = rewriteResolvedLine(next, c.id, true);
    if (rewritten) {
      next = rewritten;
      ids.push(c.id);
    }
  }

  if (ids.length === 0) {
    return [];
  }

  const withUpdated = setTopLevelField(next, 'updated', nowTimestamp());
  await writeFileForce(commentsPath, withUpdated);
  return ids;
}
