import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTranscriptRenderer } from '../index.js';

function loadFixture(name: string): string[] {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
}

describe('createTranscriptRenderer — real Claude fixture', () => {
  it('never emits a raw JSONL line and renders readable turns', () => {
    const renderer = createTranscriptRenderer({ width: 80 });
    const rows = renderer.push(loadFixture('claude-real.jsonl'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.text.startsWith('{')).toBe(false);
      expect(row.text).not.toContain('"type"');
      expect(row.text).not.toContain('sidechain content that must never render');
      expect(row.text).not.toContain('signature');
    }
    const joined = rows.map((r) => r.text).join('\n');
    expect(joined).toContain('❯ Add a widget');
    expect(joined).toContain("I'll look at the dashboard layout first.");
    expect(joined).toContain('⏺ Bash: ls dashboard/src/components');
    expect(joined).toContain('Header.tsx');
    expect(joined).toContain('⏺ Edit: dashboard/src/components/Board.tsx');
  });

  it('derives a plausible lastActivity phrase', () => {
    const renderer = createTranscriptRenderer({ width: 80 });
    renderer.push(loadFixture('claude-real.jsonl'));
    expect(renderer.lastActivity()).toBe('responding…');
  });

  it('resize re-derives all rows from retained events without re-reading the file', () => {
    const renderer = createTranscriptRenderer({ width: 80 });
    renderer.push(loadFixture('claude-real.jsonl'));
    const wide = renderer.resize(80);
    const narrow = renderer.resize(20);
    expect(narrow.length).toBeGreaterThanOrEqual(wide.length);
    for (const row of narrow) {
      if (row.style === 'assistant') expect(row.text.length).toBeLessThanOrEqual(20);
    }
  });
});

describe('createTranscriptRenderer — fallback ratio denominator', () => {
  it('a stray unparseable line among many recognized-but-dropped lines does not flip a valid transcript', () => {
    // Regression: `attempts` used to exclude `drop`-kind lines (system,
    // attachment, mode, etc.) from the denominator — a real session's early
    // lines are often mostly this metadata, so a single unrelated bad line
    // before any real conversation content would compute unparseable/attempts
    // as 1/1 and permanently flip a perfectly valid Claude transcript.
    const dropLines = [
      { type: 'mode', mode: 'normal' },
      { type: 'permission-mode', permissionMode: 'bypassPermissions' },
      { type: 'file-history-snapshot', messageId: 'm0', snapshot: {}, isSnapshotUpdate: false },
      { type: 'ai-title', aiTitle: 'x' },
      { type: 'last-prompt', leafUuid: 'x' },
      { type: 'bridge-session', bridgeSessionId: 'b', lastSequenceNum: 0 },
      { type: 'queue-operation', operation: 'enqueue', content: 'x' },
    ];
    const lines = [...dropLines.map((l) => JSON.stringify(l)), 'not json at all'];
    const renderer = createTranscriptRenderer({ width: 80 });
    renderer.push(lines);

    // Push a genuine, well-formed Claude line next — if the renderer had
    // wrongly flipped to fallback, this would come back as extracted/sentinel
    // fallback text instead of the parsed "❯ " prompt row.
    const rows = renderer.push([JSON.stringify({ type: 'user', message: { content: 'hello' } })]);
    expect(rows).toEqual([{ text: '❯ hello', style: 'user' }]);
  });

  it('still flips when unparseable lines genuinely dominate the recognized ones', () => {
    const lines = [
      JSON.stringify({ type: 'mode', mode: 'normal' }),
      'not json 1',
      'not json 2',
      'not json 3',
    ];
    const renderer = createTranscriptRenderer({ width: 80 });
    renderer.push(lines);
    const rows = renderer.push([JSON.stringify({ type: 'user', message: { content: 'hello' } })]);
    // Flipped to fallback: a well-formed Claude line no longer parses as one —
    // fallback's extractor finds no known text field on this shape, so it
    // renders nothing new (not the "❯ hello" it would have shown unflipped).
    expect(rows).not.toContainEqual({ text: '❯ hello', style: 'user' });
  });
});

describe('createTranscriptRenderer — malformed / non-Claude fixture', () => {
  it('flips to fallback and never emits a raw JSONL line', () => {
    const renderer = createTranscriptRenderer({ width: 80 });
    const rows = renderer.push(loadFixture('malformed.jsonl'));
    for (const row of rows) {
      expect(row.text.startsWith('{')).toBe(false);
      expect(row.text).not.toContain('"schema"');
      expect(row.text).not.toContain('"broken"');
    }
  });

  it('shows the fallback sentinel for a one-shot, fully-malformed batch (never a silent blank pane)', () => {
    // Regression: the ratio-flip used to happen AFTER the loop that produced
    // `rows`, so the very batch that triggered the flip was returned as the
    // (empty) claude-parse result instead of being re-routed through
    // fallback — a transcript that never changes again (no second push)
    // would render nothing at all, forever.
    const renderer = createTranscriptRenderer({ width: 80 });
    const rows = renderer.push(loadFixture('malformed.jsonl'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.text.includes('unsupported transcript format'))).toBe(true);
  });

  it('surfaces extractable text from the SAME batch that triggers the flip', () => {
    const renderer = createTranscriptRenderer({ width: 80 });
    const lines = [
      'not json at all',
      JSON.stringify({ schema: 'other-agent-v1', text: 'first readable line' }),
      JSON.stringify({ schema: 'other-agent-v1', text: 'second readable line' }),
    ];
    const rows = renderer.push(lines);
    const joined = rows.map((r) => r.text).join('\n');
    expect(joined).toContain('first readable line');
    expect(joined).toContain('second readable line');
    expect(joined).not.toContain('"schema"');
  });

  it('keeps returning fallback rows on subsequent pushes once flipped', () => {
    const renderer = createTranscriptRenderer({ width: 80 });
    renderer.push(loadFixture('malformed.jsonl'));
    const more = renderer.push([JSON.stringify({ schema: 'codex-v1', delta: 'still codex' })]);
    for (const row of more) {
      expect(row.text).not.toContain('"schema"');
    }
  });
});

describe('createTranscriptRenderer — empty input', () => {
  it('returns no rows and a null activity for whitespace-only lines', () => {
    const renderer = createTranscriptRenderer({ width: 80 });
    expect(renderer.push(['', '   '])).toEqual([]);
    expect(renderer.lastActivity()).toBeNull();
  });
});
