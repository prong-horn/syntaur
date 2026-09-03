import type { DisplayRow } from './types.js';
import type { ClaudeEvent } from '../../sessions/claude-transcript-line.js';

// The parser moved to `src/sessions/claude-transcript-line.ts` — the session
// summarizer reads it through `transcript-excerpt.ts` and must not depend on
// the TUI. Re-exported here so the renderer's callers keep one import site.
export {
  parseClaudeLine,
  type ClaudeEvent,
  type ParsedClaudeLine,
} from '../../sessions/claude-transcript-line.js';

const USER_PROMPT_MAX_LINES = 3;

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
