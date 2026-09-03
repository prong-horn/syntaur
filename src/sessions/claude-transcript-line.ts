/**
 * Parse one line of a Claude Code JSONL transcript into zero-or-more retained
 * events.
 *
 * This is the only in-repo parser that understands Claude Code's event
 * envelopes, and the session summarizer reads it through
 * `src/sessions/transcript-excerpt.ts`. It lives under `src/sessions/` rather
 * than in a renderer so the summarizer does not depend on any UI code.
 */

/** Parsed Claude Code JSONL events. */
export type ClaudeEvent =
  | { kind: 'user-text'; lines: string[] }
  | { kind: 'tool-use'; name: string; summary: string }
  | { kind: 'tool-result'; text: string; isError: boolean }
  | { kind: 'assistant-text'; text: string };

/** Lines whose top-level `type` we recognize but intentionally render nothing for. */
const DROPPED_TOP_LEVEL_TYPES = new Set([
  'system',
  'attachment',
  'mode',
  'permission-mode',
  'file-history-snapshot',
  'bridge-session',
  'queue-operation',
  'last-prompt',
  'ai-title',
  'agent-name',
  'summary',
]);

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstStringValue(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = input[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function summarizeToolInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const value = firstStringValue(input as Record<string, unknown>, [
    'command',
    'file_path',
    'path',
    'pattern',
    'description',
    'query',
    'skill',
    'prompt',
  ]);
  return value ? truncate(value, 80) : '';
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
  is_error?: unknown;
}

function extractResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && typeof (block as ContentBlock).text === 'string') {
        parts.push((block as ContentBlock).text as string);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function eventsFromAssistantContent(content: unknown): ClaudeEvent[] {
  if (!Array.isArray(content)) return [];
  const events: ClaudeEvent[] = [];
  for (const raw of content) {
    if (raw === null || typeof raw !== 'object') continue;
    const block = raw as ContentBlock;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      events.push({ kind: 'assistant-text', text: block.text });
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      events.push({ kind: 'tool-use', name: block.name, summary: summarizeToolInput(block.input) });
    }
    // thinking / redacted_thinking / anything else: dropped, not counted as unparseable —
    // the enclosing assistant message itself parsed fine.
  }
  return events;
}

function eventsFromUserContent(content: unknown): ClaudeEvent[] {
  if (typeof content === 'string') {
    const lines = content.split('\n').filter((l) => l.length > 0);
    return lines.length > 0 ? [{ kind: 'user-text', lines }] : [];
  }
  if (!Array.isArray(content)) return [];
  const events: ClaudeEvent[] = [];
  for (const raw of content) {
    if (raw === null || typeof raw !== 'object') continue;
    const block = raw as ContentBlock;
    if (block.type === 'tool_result') {
      events.push({
        kind: 'tool-result',
        text: extractResultText(block.content),
        isError: block.is_error === true,
      });
    } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      events.push({ kind: 'user-text', lines: block.text.split('\n').filter((l) => l.length > 0) });
    }
    // image / other block types: dropped.
  }
  return events;
}

interface RawLine {
  type?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown };
}

/**
 * Classify + parse one non-empty JSONL line into zero-or-more retained events.
 * A line can legitimately expand to multiple events (an assistant turn with
 * text followed by a tool call). Returns `unparseable` only when the line's
 * JSON is malformed or its shape isn't a recognized Claude Code event at all —
 * this drives the fallback-flip ratio in the renderer.
 */
export type ParsedClaudeLine =
  | { kind: 'drop' }
  | { kind: 'unparseable' }
  | { kind: 'events'; events: ClaudeEvent[] };

export function parseClaudeLine(line: string): ParsedClaudeLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'unparseable' };
  }
  if (parsed === null || typeof parsed !== 'object') return { kind: 'unparseable' };
  const raw = parsed as RawLine;
  if (raw.isSidechain === true) return { kind: 'drop' };
  const type = raw.type;
  if (typeof type !== 'string') return { kind: 'unparseable' };
  if (DROPPED_TOP_LEVEL_TYPES.has(type)) return { kind: 'drop' };
  if (type === 'assistant') {
    const events = eventsFromAssistantContent(raw.message?.content);
    return { kind: 'events', events };
  }
  if (type === 'user') {
    const events = eventsFromUserContent(raw.message?.content);
    return { kind: 'events', events };
  }
  return { kind: 'unparseable' };
}
