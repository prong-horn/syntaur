import type { DisplayRow } from './types.js';

/**
 * Parsed Claude Code JSONL events, retained by the renderer so `resize()` can
 * re-derive rows at a new width without re-reading the transcript file.
 */
export type ClaudeEvent =
  | { kind: 'user-text'; lines: string[] }
  | { kind: 'tool-use'; name: string; summary: string }
  | { kind: 'tool-result'; text: string; isError: boolean }
  | { kind: 'assistant-text'; text: string };

/** Outcome of classifying one non-empty JSONL line. */
export type ParsedLine =
  | { kind: 'drop' }
  | { kind: 'event'; event: ClaudeEvent }
  | { kind: 'unparseable' };

const USER_PROMPT_MAX_LINES = 3;

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
 * this drives the fallback-flip ratio in index.ts.
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

function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const rows: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0) {
      rows.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;
      if (candidate.length > safeWidth && line.length > 0) {
        rows.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line.length > 0) rows.push(line);
  }
  return rows;
}

/** Render one retained event into display rows at the given pane width. */
export function renderClaudeEvent(event: ClaudeEvent, width: number): DisplayRow[] {
  switch (event.kind) {
    case 'user-text': {
      const shown = event.lines.slice(0, USER_PROMPT_MAX_LINES);
      const rows: DisplayRow[] = shown.map((text, i) => ({
        text: i === 0 ? `❯ ${text}` : `  ${text}`,
        style: 'user',
      }));
      const remaining = event.lines.length - shown.length;
      if (remaining > 0) rows.push({ text: `  … (+${remaining} more lines)`, style: 'meta' });
      return rows;
    }
    case 'tool-use': {
      const label = event.summary ? `${event.name}: ${event.summary}` : event.name;
      return [{ text: `⏺ ${label}`, style: 'tool' }];
    }
    case 'tool-result': {
      const lines = event.text.split('\n');
      const first = lines[0] ?? '';
      const rows: DisplayRow[] = [{ text: first, style: event.isError ? 'error' : 'meta' }];
      if (lines.length > 1) rows.push({ text: `  (+${lines.length - 1} lines)`, style: 'meta' });
      return rows;
    }
    case 'assistant-text':
      return wrapText(event.text, width).map((text) => ({ text, style: 'assistant' }));
    default:
      return [];
  }
}

/** Short "what's happening" phrase for the session rail, derived from one event. */
export function activityFromEvent(event: ClaudeEvent): string | null {
  switch (event.kind) {
    case 'tool-use':
      return event.summary ? `${event.name}: ${event.summary}` : `running ${event.name}`;
    case 'assistant-text':
      return 'responding…';
    case 'user-text':
      return null;
    case 'tool-result':
      return null;
    default:
      return null;
  }
}
