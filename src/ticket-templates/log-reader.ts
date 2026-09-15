import type { LogEntryType } from './manifest.js';

export interface LogEntry {
  timestamp: string;
  type: LogEntryType;
  author: string | null;
  keys: Record<string, string>;
  body: string;
  firstLine: string;
}

const ENTRY_HEADING_RE =
  /^(\S+)\s*(?:·\s*([^\s·]+)\s*·\s*(\S+))?\s*$/;

const KEY_LINE_RE = /^(verdict|answers|attachments):\s*(.+)$/;

/** First token is an ISO-8601 UTC timestamp (second or millisecond precision). */
const ISO_ENTRY_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isEntryTimestamp(token: string): boolean {
  return ISO_ENTRY_TS_RE.test(token);
}

function firstBodyLine(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

function demoteSubHeadings(body: string): string {
  return body.replace(/^## /gm, '### ');
}

function parseEntryHeading(headingLine: string): {
  timestamp: string;
  type: LogEntryType;
  author: string | null;
} | null {
  const m = headingLine.trim().match(ENTRY_HEADING_RE);
  if (!m) return null;
  const timestamp = m[1];
  if (!isEntryTimestamp(timestamp)) return null;
  if (m[2] && m[3]) {
    return { timestamp, type: m[2] as LogEntryType, author: m[3] };
  }
  return { timestamp, type: 'progress', author: null };
}

/** Parse log-role file content into entries, newest first. */
export function parseLogEntries(content: string): LogEntry[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const fmMatch = normalized.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  const body = fmMatch ? fmMatch[1] : normalized;

  const chunks = body.split(/^##\s+/m).slice(1);
  const entries: LogEntry[] = [];

  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const headingLine = lines[0] ?? '';
    const parsed = parseEntryHeading(headingLine);

    if (!parsed) {
      if (entries.length > 0) {
        const prev = entries[entries.length - 1];
        const continuation = `## ${chunk}`.trimEnd();
        prev.body = prev.body.length > 0 ? `${prev.body}\n${continuation}` : continuation;
        prev.firstLine = firstBodyLine(prev.body);
      }
      continue;
    }

    const keys: Record<string, string> = {};
    let bodyStart = 1;
    while (bodyStart < lines.length) {
      const line = lines[bodyStart];
      const km = line.match(KEY_LINE_RE);
      if (!km) break;
      keys[km[1]] = km[2].trim();
      bodyStart++;
      if (line.trim() === '') bodyStart++;
    }

    const entryBody = lines.slice(bodyStart).join('\n').trim();
    entries.push({
      timestamp: parsed.timestamp,
      type: parsed.type,
      author: parsed.author,
      keys,
      body: entryBody,
      firstLine: firstBodyLine(entryBody),
    });
  }

  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return entries;
}

/** Question entries with no `answer` naming their timestamp. */
export function openQuestions(entries: LogEntry[]): LogEntry[] {
  const answered = new Set<string>();
  for (const e of entries) {
    if (e.type === 'answer' && e.keys.answers) {
      answered.add(e.keys.answers);
    }
  }
  return entries.filter((e) => e.type === 'question' && !answered.has(e.timestamp));
}

/** Newest entry of the given type, or null. */
export function latestEntry(entries: LogEntry[], type: LogEntryType): LogEntry | null {
  return entries.find((e) => e.type === type) ?? null;
}

/** Render one log entry (inverse of the parser; demotes body `##` to `###`). */
export function formatLogEntry(entry: {
  timestamp: string;
  type: LogEntryType;
  author: string;
  keys?: Record<string, string>;
  body: string;
}): string {
  const lines: string[] = [`## ${entry.timestamp} · ${entry.type} · ${entry.author}`];
  const keys = entry.keys ?? {};
  for (const key of ['verdict', 'answers', 'attachments'] as const) {
    const value = keys[key];
    if (value !== undefined) lines.push(`${key}: ${value}`);
  }
  const body = demoteSubHeadings(entry.body.trim());
  if (lines.length > 1 && body.length > 0) lines.push('');
  if (body.length > 0) lines.push(body);
  return `${lines.join('\n')}\n`;
}
