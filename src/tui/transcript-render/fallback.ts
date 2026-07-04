import type { DisplayRow } from './types.js';

const MAX_RETAINED = 20;
const UNSUPPORTED_MESSAGE = '(unsupported transcript format — attach to view)';

interface JsonTextBlock {
  text?: unknown;
}
interface JsonEnvelope {
  text?: unknown;
  content?: unknown;
  message?: { content?: unknown };
}

/**
 * Best-effort text extraction for an unrecognized agent format. Never returns
 * the raw line — only a substring pulled from a recognized-ish JSON text
 * field, or null if nothing textual can be found.
 */
export function extractFallbackText(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const env = parsed as JsonEnvelope;
  const candidates: unknown[] = [env.text, env.content, env.message?.content];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
    if (Array.isArray(candidate)) {
      const parts = candidate
        .filter((b): b is JsonTextBlock => b !== null && typeof b === 'object')
        .map((b) => (typeof b.text === 'string' ? b.text : null))
        .filter((t): t is string => t !== null && t.trim().length > 0);
      if (parts.length > 0) return parts.join('\n');
    }
  }
  return null;
}

export interface FallbackRenderer {
  push(lines: string[]): DisplayRow[];
  rows(): DisplayRow[];
  lastText(): string | null;
}

/**
 * Renderer of last resort for agent transcript formats we don't parse. Shows
 * the last N extracted text-bearing lines, or a sentinel message if nothing
 * has ever been extractable — never a raw JSONL line.
 */
export function createFallbackRenderer(): FallbackRenderer {
  const retained: DisplayRow[] = [];
  let everExtracted = false;
  let sentinelEmitted = false;
  let last: string | null = null;

  return {
    push(lines: string[]): DisplayRow[] {
      const appended: DisplayRow[] = [];
      for (const line of lines) {
        const text = extractFallbackText(line);
        if (text === null) continue;
        everExtracted = true;
        last = text;
        const row: DisplayRow = { text, style: 'meta' };
        retained.push(row);
        appended.push(row);
      }
      while (retained.length > MAX_RETAINED) retained.shift();
      if (!everExtracted && !sentinelEmitted) {
        sentinelEmitted = true;
        return [{ text: UNSUPPORTED_MESSAGE, style: 'meta' }];
      }
      return appended;
    },
    rows(): DisplayRow[] {
      if (!everExtracted) return [{ text: UNSUPPORTED_MESSAGE, style: 'meta' }];
      return [...retained];
    },
    lastText(): string | null {
      return last;
    },
  };
}
