// Pure, React-free primitives for `/`-command autocomplete in a text box.
// Grammar parity with `detectCommand` in `src/chat/commands.ts` is load-bearing.

import type { ChatCommand } from './chat-types';

const SLUG_CHAR = /[A-Za-z0-9_-]/;
const COMMAND_NAME = /[A-Za-z0-9:_.-]+/;

export interface ActiveCommand {
  start: number;
  end: number;
  partial: string;
}

function stripLeadingAttachedMentions(text: string, attachedIds: readonly string[]): string {
  const byLower = new Map(attachedIds.map((id) => [id.toLowerCase(), id]));
  let rest = text;
  for (;;) {
    const trimmed = rest.trimStart();
    const leadingWs = rest.length - trimmed.length;
    if (leadingWs > 0 && rest.slice(0, leadingWs).trim().length > 0) break;
    rest = trimmed;
    if (!rest.startsWith('@')) break;
    let i = 1;
    while (i < rest.length && SLUG_CHAR.test(rest[i])) i++;
    const token = rest.slice(1, i);
    if (!byLower.has(token.toLowerCase())) break;
    rest = rest.slice(i).trimStart();
  }
  return rest;
}

/** `/` token the caret is inside, after optional leading attached `@mentions`. */
export function detectActiveCommand(
  text: string,
  caret: number,
  attachedIds: readonly string[] = [],
): ActiveCommand | null {
  const pos = Math.max(0, Math.min(caret, text.length));
  const prefix = text.slice(0, pos);
  const beforeSlash = prefix.length - stripLeadingAttachedMentions(prefix, attachedIds).length;
  const rest = prefix.slice(beforeSlash);
  if (!rest.startsWith('/')) return null;
  const nameMatch = rest.slice(1).match(new RegExp(`^(${COMMAND_NAME.source})`));
  const nameEnd = nameMatch ? 1 + nameMatch[1].length : 1;
  const tokenEnd = beforeSlash + nameEnd;
  const partial = nameMatch ? nameMatch[1].slice(0, Math.max(0, pos - beforeSlash - 1)) : '';
  if (pos > tokenEnd) return null;
  return { start: beforeSlash, end: Math.max(tokenEnd, pos), partial };
}

/** First leading attached mention in the draft, else the default agent. */
export function addressedAgentId(
  text: string,
  attachedIds: readonly string[],
  defaultAgentId: string | null,
): string | null {
  const byLower = new Map(attachedIds.map((id) => [id.toLowerCase(), id]));
  let rest = text.trimStart();
  while (rest.startsWith('@')) {
    let i = 1;
    while (i < rest.length && SLUG_CHAR.test(rest[i])) i++;
    const token = rest.slice(1, i);
    const id = byLower.get(token.toLowerCase());
    if (!id) break;
    return id;
  }
  return defaultAgentId;
}

export function rankCommands(partial: string, commands: readonly ChatCommand[]): ChatCommand[] {
  const needle = partial.toLowerCase();
  const prefix: ChatCommand[] = [];
  const nameSub: ChatCommand[] = [];
  const descSub: ChatCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    const desc = command.description.toLowerCase();
    if (!needle || name.startsWith(needle)) prefix.push(command);
    else if (name.includes(needle)) nameSub.push(command);
    else if (desc.includes(needle)) descSub.push(command);
  }
  prefix.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  nameSub.sort((a, b) => a.name.localeCompare(b.name));
  descSub.sort((a, b) => a.name.localeCompare(b.name));
  return [...prefix, ...nameSub, ...descSub].slice(0, 8);
}

export function applyCommand(
  text: string,
  range: { start: number; end: number },
  name: string,
): { text: string; caret: number } {
  const inserted = `/${name} `;
  return {
    text: text.slice(0, range.start) + inserted + text.slice(range.end),
    caret: range.start + inserted.length,
  };
}

/** True when the caret is at the end of a token that exactly matches a listed command. */
export function isExactCommand(
  active: ActiveCommand | null,
  caret: number,
  commands: readonly ChatCommand[],
): boolean {
  if (!active || caret !== active.end) return false;
  return commands.some((command) => command.name === active.partial);
}

export function emptyCommandsCopy(addressedId: string): string {
  return `No commands advertised by @${addressedId} yet — a /command you type is still sent as-is`;
}
