/**
 * Build a small, bounded, role-tagged excerpt of an agent transcript for the
 * summarizer to read.
 *
 * Transcripts routinely reach tens of megabytes, so this never loads a whole
 * file: it streams line-by-line, keeps a bounded head and a rolling tail, and
 * hard-caps the rendered result. The head captures what the session set out to
 * do; the tail captures where it ended up — which is what a one-line
 * description and a short summary actually need.
 *
 * Layouts (documented in `src/usage/cwd-extractor.ts`):
 *   claude — `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`, rich event
 *            envelopes; parsed with the existing `parseClaudeLine`.
 *   codex  — `<root>/YYYY/MM/DD/rollout-*.jsonl`, `session_meta` first line.
 *   pi     — `<root>/<encoded-cwd>/<ts>_<uuid>.jsonl`.
 * Only claude has a real role/text parser in-repo, so codex/pi fall back to a
 * generic JSONL field probe.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseClaudeLine } from '../tui/transcript-render/claude.js';

/** Hard cap on the rendered excerpt handed to a backend. */
const MAX_EXCERPT_BYTES = 24_000;
/** Events kept from the start of the session. */
const HEAD_EVENTS = 20;
/** Events kept from the end of the session. */
const TAIL_EVENTS = 80;
/** Per-event truncation, so one giant tool result can't crowd out everything else. */
const MAX_EVENT_CHARS = 600;

function clamp(text: string, max = MAX_EVENT_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** Render one parsed claude event as a single role-tagged line. */
function renderClaudeEvent(event: ReturnType<typeof parseClaudeLine>): string[] {
  if (event.kind !== 'events') return [];
  const out: string[] = [];
  for (const e of event.events) {
    switch (e.kind) {
      case 'user-text':
        out.push(`user: ${clamp(e.lines.join(' '))}`);
        break;
      case 'assistant-text':
        out.push(`assistant: ${clamp(e.text)}`);
        break;
      case 'tool-use':
        out.push(`tool(${e.name}): ${clamp(e.summary, 200)}`);
        break;
      case 'tool-result':
        out.push(`result${e.isError ? '(error)' : ''}: ${clamp(e.text, 200)}`);
        break;
    }
  }
  return out;
}

/**
 * Generic JSONL probe for runtimes with no in-repo parser (codex, pi).
 * Pulls the obvious role/content shape when present, else falls back to any
 * string-ish text field, else skips the line.
 */
function renderGenericLine(line: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;

  // Codex wraps the interesting bits in a `payload` envelope; pi (and codex)
  // wrap the actual message in a nested `message` object:
  //   pi:    { type: "message", message: { role, content: [{type,text}] } }
  //   codex: { payload: { role, content } }
  // Unwrap both, innermost first, so the role/content lookup below sees the real
  // message rather than treating the `message` OBJECT as content (which silently
  // dropped every pi line — its transcripts are entirely `type:"message"`).
  let body = (obj.payload && typeof obj.payload === 'object' ? obj.payload : obj) as Record<
    string,
    unknown
  >;
  if (body.message && typeof body.message === 'object') {
    body = body.message as Record<string, unknown>;
  }

  const role =
    typeof body.role === 'string'
      ? body.role
      : typeof obj.type === 'string'
        ? obj.type
        : 'event';

  const content = body.content ?? body.text ?? body.summary;
  let text: string | null = null;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts = content
      .map((c) =>
        typeof c === 'string'
          ? c
          : c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
            ? (c as { text: string }).text
            : '',
      )
      .filter(Boolean);
    text = parts.length > 0 ? parts.join(' ') : null;
  }

  if (!text) return [];
  const rendered = clamp(text);
  return rendered.length > 0 ? [`${role}: ${rendered}`] : [];
}

/**
 * Build a bounded excerpt of `transcriptPath`, or null when the file is
 * missing, unreadable, or yields no usable content. Never throws — callers
 * treat null as "nothing worth summarizing" and back off.
 */
export async function buildTranscriptExcerpt(
  transcriptPath: string | null | undefined,
  agent: string,
): Promise<string | null> {
  if (!transcriptPath) return null;

  const head: string[] = [];
  const tail: string[] = [];
  let total = 0;

  const render = agent === 'claude'
    ? (line: string) => renderClaudeEvent(parseClaudeLine(line))
    : renderGenericLine;

  try {
    const stream = createReadStream(transcriptPath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        for (const rendered of render(trimmed)) {
          total++;
          if (head.length < HEAD_EVENTS) {
            head.push(rendered);
          } else {
            // Rolling window — only the last TAIL_EVENTS are retained, so
            // memory stays flat regardless of transcript size.
            tail.push(rendered);
            if (tail.length > TAIL_EVENTS) tail.shift();
          }
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  } catch {
    return null;
  }

  if (head.length === 0 && tail.length === 0) return null;

  const omitted = total - head.length - tail.length;
  const parts = [...head];
  if (omitted > 0) parts.push(`… ${omitted} events omitted …`);
  parts.push(...tail);

  let excerpt = parts.join('\n');
  if (excerpt.length > MAX_EXCERPT_BYTES) {
    // Keep the tail: how a session ended is more informative for a summary than
    // an extra slice of its opening.
    excerpt = `…\n${excerpt.slice(excerpt.length - MAX_EXCERPT_BYTES)}`;
  }
  return excerpt.trim().length > 0 ? excerpt : null;
}
