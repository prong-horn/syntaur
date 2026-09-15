import type { LogEntryType } from './manifest.js';

export interface LogEntry {
  timestamp: string;
  type: LogEntryType;
  author: string | null;
  keys: Record<string, string>;
  body: string;
  firstLine: string;
}

const KEY_LINE_RE = /^(verdict|answers|attachments):\s*(.+)$/;

/** First token is an ISO-8601 UTC timestamp (second or millisecond precision). */
const ISO_ENTRY_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const TYPED_HEADING_RE = /^·\s*([^\s·]+)\s*·\s*(\S+)\s*$/;

function isEntryTimestamp(token: string): boolean {
  return ISO_ENTRY_TS_RE.test(token);
}

function normalizeHeadingTimestamp(firstToken: string): string | null {
  if (isEntryTimestamp(firstToken)) return firstToken;
  if (DATE_ONLY_RE.test(firstToken)) return `${firstToken}T00:00:00Z`;
  return null;
}

function stripLegacyTitlePrefix(remainder: string): string {
  return remainder.replace(/^[—\-:]\s*/, '').trim();
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

function syntheticTimestampFromFrontmatter(content: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return '1970-01-01T00:00:00Z';
  const fm = fmMatch[1];
  const updated = fm.match(/^updated:\s*"?([^"\n]+)"?\s*$/m)?.[1];
  if (updated) return updated.replace(/\.\d{3}Z$/, 'Z');
  const created = fm.match(/^created:\s*"?([^"\n]+)"?\s*$/m)?.[1];
  if (created) return created.replace(/\.\d{3}Z$/, 'Z');
  const generated = fm.match(/^generated:\s*"?([^"\n]+)"?\s*$/m)?.[1];
  if (generated) return generated.replace(/\.\d{3}Z$/, 'Z');
  return '1970-01-01T00:00:00Z';
}

function parseEntryHeading(headingLine: string): {
  timestamp: string;
  type: LogEntryType;
  author: string | null;
  titlePrefix?: string;
} | null {
  const trimmed = headingLine.trim();
  if (!trimmed) return null;

  const firstSpace = trimmed.indexOf(' ');
  const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const remainder = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

  const timestamp = normalizeHeadingTimestamp(firstToken);
  if (!timestamp) return null;

  if (!remainder) {
    return { timestamp, type: 'progress', author: null };
  }

  const typed = remainder.match(TYPED_HEADING_RE);
  if (typed) {
    return { timestamp, type: typed[1] as LogEntryType, author: typed[2] };
  }

  const title = stripLegacyTitlePrefix(remainder);
  return { timestamp, type: 'progress', author: null, titlePrefix: title };
}

/** Parse log-role file content into entries, newest first. */
export function parseLogEntries(content: string): LogEntry[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const fmMatch = normalized.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  const body = fmMatch ? fmMatch[1] : normalized;

  const parts = body.split(/^##\s+/m);
  const preface = parts[0]?.trim() ?? '';
  const chunks = parts.slice(1);
  const entries: LogEntry[] = [];
  let preamble: string | null = preface.length > 0 ? preface : null;

  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const headingLine = lines[0] ?? '';
    const parsed = parseEntryHeading(headingLine);

    if (!parsed) {
      const continuation = `## ${chunk}`.trimEnd();
      if (entries.length > 0) {
        const prev = entries[entries.length - 1];
        prev.body = prev.body.length > 0 ? `${prev.body}\n${continuation}` : continuation;
        prev.firstLine = firstBodyLine(prev.body);
      } else {
        preamble = preamble ? `${preamble}\n${continuation}` : continuation;
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

    let entryBody = lines.slice(bodyStart).join('\n').trim();
    if (parsed.titlePrefix) {
      entryBody = entryBody.length > 0
        ? `${parsed.titlePrefix}\n${entryBody}`
        : parsed.titlePrefix;
    }

    entries.push({
      timestamp: parsed.timestamp,
      type: parsed.type,
      author: parsed.author,
      keys,
      body: entryBody,
      firstLine: firstBodyLine(entryBody),
    });
  }

  if (preamble) {
    entries.push({
      timestamp: syntheticTimestampFromFrontmatter(normalized),
      type: 'progress',
      author: null,
      keys: {},
      body: preamble.trim(),
      firstLine: firstBodyLine(preamble),
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
  if (body.length > 0) {
    lines.push('');
    lines.push(body);
  }
  return `${lines.join('\n')}\n`;
}
