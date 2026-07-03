import { parseClaudeLine, renderClaudeEvent, activityFromEvent, type ClaudeEvent } from './claude.js';
import { createFallbackRenderer, type FallbackRenderer } from './fallback.js';
import type { DisplayRow, TranscriptRenderer, TranscriptRendererOptions } from './types.js';

export type { DisplayRow, DisplayRowStyle, TranscriptRenderer, TranscriptRendererOptions } from './types.js';

/** Flip to the fallback renderer once unparseable lines exceed this share of attempts. */
const FALLBACK_RATIO_THRESHOLD = 0.5;

/**
 * `createTranscriptRenderer` selects between the Claude Code JSONL parser and
 * the format-agnostic fallback, per design spec §5.1/§7. The Claude parser is
 * tried first; once the cumulative unparseable/attempts ratio crosses 50% the
 * renderer flips to fallback permanently (a transcript format never un-flips
 * mid-session — "a format change can never bring back the wall-of-JSON").
 */
export function createTranscriptRenderer(options: TranscriptRendererOptions): TranscriptRenderer {
  let width = options.width;
  const events: ClaudeEvent[] = [];
  let attempts = 0;
  let unparseable = 0;
  let usingFallback = false;
  let lastActivityText: string | null = null;
  let fallback: FallbackRenderer | null = null;

  function fallbackRenderer(): FallbackRenderer {
    if (!fallback) fallback = createFallbackRenderer();
    return fallback;
  }

  function recordClaudeEvent(event: ClaudeEvent): DisplayRow[] {
    events.push(event);
    const activity = activityFromEvent(event);
    if (activity) lastActivityText = activity;
    return renderClaudeEvent(event, width);
  }

  return {
    push(lines: string[]): DisplayRow[] {
      const nonEmpty = lines.filter((l) => l.trim().length > 0);
      if (nonEmpty.length === 0) return [];

      if (usingFallback) {
        const rows = fallbackRenderer().push(nonEmpty);
        const last = fallbackRenderer().lastText();
        if (last) lastActivityText = last;
        return rows;
      }

      const rows: DisplayRow[] = [];
      for (const line of nonEmpty) {
        const parsed = parseClaudeLine(line);
        // Every non-empty line is a parse "attempt" (plan.md's literal
        // wording) — including recognized-but-intentionally-ignored `drop`
        // lines (system/attachment/mode/sidechain/etc.), which a real Claude
        // session's early lines are often mostly made of. Excluding them from
        // the denominator let a single stray unparseable line, arriving
        // before any real conversation content, flip a perfectly valid
        // Claude transcript to fallback.
        attempts++;
        if (parsed.kind === 'drop') continue;
        if (parsed.kind === 'unparseable') {
          unparseable++;
          continue;
        }
        for (const event of parsed.events) rows.push(...recordClaudeEvent(event));
      }

      if (attempts > 0 && unparseable / attempts > FALLBACK_RATIO_THRESHOLD) {
        usingFallback = true;
        // The flip was detected mid-batch: route THIS SAME batch through the
        // fallback renderer too, appended after any legitimately-parsed rows
        // above. Without this, a one-shot fully-malformed transcript (no
        // further file changes to trigger another push) would render nothing
        // at all forever — not even the fallback's sentinel message.
        const fallbackRows = fallbackRenderer().push(nonEmpty);
        const last = fallbackRenderer().lastText();
        if (last) lastActivityText = last;
        return [...rows, ...fallbackRows];
      }
      return rows;
    },

    resize(newWidth: number): DisplayRow[] {
      width = newWidth;
      if (usingFallback) return fallbackRenderer().rows();
      return events.flatMap((event) => renderClaudeEvent(event, width));
    },

    lastActivity(): string | null {
      return lastActivityText;
    },
  };
}
