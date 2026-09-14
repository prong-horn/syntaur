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

function firstBodyLine(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
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
    const headingLine = lines[0]?.trim() ?? '';
    const m = headingLine.match(ENTRY_HEADING_RE);
    if (!m) continue;

    const timestamp = m[1];
    let type: LogEntryType;
    let author: string | null;
    if (m[2] && m[3]) {
      type = m[2] as LogEntryType;
      author = m[3];
    } else {
      type = 'progress';
      author = null;
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
      timestamp,
      type,
      author,
      keys,
      body: entryBody,
      firstLine: firstBodyLine(entryBody),
    });
  }

  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return entries;
}
