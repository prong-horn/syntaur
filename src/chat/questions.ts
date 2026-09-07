/**
 * Pure helpers for chat-sourced Inbox questions: marker format, parsing, and the
 * reply-question heuristic (Decision 2).
 */

import { clipExcerpt } from './records.js';
import type { ChatQuestionKind, ChatQuestionRef } from './types.js';

export const CHAT_QUESTION_MARKER_RE =
  /<!--\s*syntaur-chat\b[^>]*-->/;

/** Case-insensitive whole-phrase patterns that signal a decision request. */
export const DECISION_REQUEST_PHRASES: readonly RegExp[] = [
  /\blet me know\b/i,
  /\btell me\b/i,
  /\bsay if\b/i,
  /\bshould i\b/i,
  /\bshall i\b/i,
  /\bdo you want\b/i,
  /\bwould you like\b/i,
  /\bwant me to\b/i,
  /\bwhich (?:one|option|approach|do you prefer)\b/i,
  /\byour call\b/i,
  /\bconfirm\b/i,
  /\bprefer\b/i,
];

/** Case-insensitive whole-phrase patterns that are polite closers, not real questions. */
export const BOILERPLATE_PHRASES: readonly RegExp[] = [
  /\bif you need anything\b/i,
  /\bif you have any(?: other)? questions\b/i,
  /\bhappy to help\b/i,
  /\bfeel free to\b/i,
];

function parseMarkerAttributes(attrs: string): ChatQuestionRef | null {
  const kind = attrs.match(/\bkind="(reply|permission|ask)"/)?.[1];
  const itemId = attrs.match(/\bitem="([^"]+)"/)?.[1];
  if (!kind || !itemId) return null;
  const turnId = attrs.match(/\bturn="([^"]+)"/)?.[1];
  return { kind: kind as ChatQuestionKind, itemId, turnId: turnId || undefined };
}

export function formatChatQuestionMarker(ref: ChatQuestionRef): string {
  const turnAttr = ref.turnId ? ` turn="${ref.turnId}"` : '';
  return `<!-- syntaur-chat kind="${ref.kind}" item="${ref.itemId}"${turnAttr} -->`;
}

export function parseChatQuestionMarker(body: string): { ref: ChatQuestionRef | null; text: string } {
  const match = body.match(CHAT_QUESTION_MARKER_RE);
  if (!match) {
    return { ref: null, text: body.trim() };
  }

  const inner = match[0].replace(/^<!--\s*syntaur-chat\b/, '').replace(/-->$/, '');
  const ref = parseMarkerAttributes(inner);
  if (!ref) {
    return { ref: null, text: body.trim() };
  }

  const text = body
    .replace(CHAT_QUESTION_MARKER_RE, '')
    .replace(/^\s*\n+|\n+\s*$/g, '')
    .trim();

  return { ref, text };
}

function stripTrailingEmphasis(paragraph: string): string {
  return paragraph.replace(/(\*{1,3}|_{1,3})+$/, '').trim();
}

function matchesAnyPhrase(text: string, phrases: readonly RegExp[]): boolean {
  return phrases.some((re) => re.test(text));
}

/** Return the last paragraph when it looks like an open question, else null. */
export function detectOpenQuestion(replyText: string): string | null {
  const paragraphs = replyText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return null;

  const last = stripTrailingEmphasis(paragraphs[paragraphs.length - 1]);
  if (last.length === 0) return null;
  if (matchesAnyPhrase(last, BOILERPLATE_PHRASES)) return null;

  const endsWithQuestion = last.endsWith('?');
  const asksForDecision = matchesAnyPhrase(last, DECISION_REQUEST_PHRASES);
  if (!endsWithQuestion && !asksForDecision) return null;

  return clipExcerpt(last, 600);
}

export function questionBodyForCard(kind: 'permission' | 'ask', titleOrPrompt: string): string {
  if (kind === 'permission') {
    return `Waiting for your permission to run **${titleOrPrompt}** in the chat.`;
  }
  return titleOrPrompt;
}
