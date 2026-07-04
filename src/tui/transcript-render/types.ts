/**
 * Shared types for the transcript renderer. One row = one rendered terminal
 * line; the DetailPane always renders `wrap="truncate"` so a row never
 * wraps — pre-wrapping (assistant paragraphs) happens inside the renderer at
 * push/resize time, per design spec §5.1/§5.3.
 */

export type DisplayRowStyle = 'user' | 'assistant' | 'tool' | 'meta' | 'error';

export interface DisplayRow {
  text: string;
  style: DisplayRowStyle;
}

export interface TranscriptRendererOptions {
  width: number;
}

export interface TranscriptRenderer {
  /** Feed raw JSONL lines (from tailFile); returns display rows to append. */
  push(lines: string[]): DisplayRow[];
  /** Re-derive ALL rows at a new width from retained parsed state — never re-reads the file. */
  resize(width: number): DisplayRow[];
  /** Short "what's happening now" phrase for the session rail, or null if unknown. */
  lastActivity(): string | null;
}
