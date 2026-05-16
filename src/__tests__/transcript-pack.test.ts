import { describe, it, expect } from 'vitest';
import {
  groupIntoPhrases,
  renderMarkdown,
  formatTime,
} from '../utils/transcribers/pack.js';
import type { TranscriptWord } from '../utils/transcribers/index.js';

describe('formatTime', () => {
  it('zero-pads to 6-char width with two decimals', () => {
    expect(formatTime(0)).toBe('000.00');
    expect(formatTime(1.5)).toBe('001.50');
    expect(formatTime(123.45)).toBe('123.45');
    expect(formatTime(60)).toBe('060.00');
  });
});

describe('groupIntoPhrases', () => {
  it('breaks on silence >= threshold between consecutive kept tokens', () => {
    const words: TranscriptWord[] = [
      { type: 'word', text: 'hello', start: 0.0, end: 0.4 },
      // 0.6s gap — break
      { type: 'word', text: 'world', start: 1.0, end: 1.5 },
    ];
    const phrases = groupIntoPhrases(words, 0.5);
    expect(phrases).toHaveLength(2);
    expect(phrases[0].text).toBe('hello');
    expect(phrases[1].text).toBe('world');
  });

  it('keeps short gaps in the same phrase', () => {
    const words: TranscriptWord[] = [
      { type: 'word', text: 'hello', start: 0.0, end: 0.4 },
      // 0.2s gap — same phrase
      { type: 'word', text: 'world', start: 0.6, end: 1.0 },
    ];
    const phrases = groupIntoPhrases(words, 0.5);
    expect(phrases).toHaveLength(1);
    expect(phrases[0].text).toBe('hello world');
  });

  it('breaks on speaker change even with no gap', () => {
    const words: TranscriptWord[] = [
      { type: 'word', text: 'one', start: 0.0, end: 0.4, speaker_id: 'speaker_0' },
      { type: 'word', text: 'two', start: 0.5, end: 0.9, speaker_id: 'speaker_1' },
    ];
    const phrases = groupIntoPhrases(words, 0.5);
    expect(phrases).toHaveLength(2);
    expect(phrases[0].speakerId).toBe('speaker_0');
    expect(phrases[1].speakerId).toBe('speaker_1');
  });

  it('re-attaches trailing punctuation to preceding word', () => {
    const words: TranscriptWord[] = [
      { type: 'word', text: 'hello', start: 0.0, end: 0.4 },
      { type: 'word', text: ',', start: 0.4, end: 0.45 },
      { type: 'word', text: 'world', start: 0.5, end: 0.9 },
      { type: 'word', text: '!', start: 0.9, end: 0.95 },
    ];
    const phrases = groupIntoPhrases(words, 0.5);
    expect(phrases).toHaveLength(1);
    expect(phrases[0].text).toBe('hello, world!');
  });

  it('wraps audio events in parens', () => {
    const words: TranscriptWord[] = [
      { type: 'word', text: 'hello', start: 0.0, end: 0.4 },
      { type: 'audio_event', text: 'laughter', start: 0.5, end: 1.0 },
    ];
    const phrases = groupIntoPhrases(words, 0.5);
    expect(phrases).toHaveLength(1);
    expect(phrases[0].text).toBe('hello (laughter)');
  });

  it('flushes on long-gap spacing entries', () => {
    const words: TranscriptWord[] = [
      { type: 'word', text: 'hello', start: 0.0, end: 0.4 },
      { type: 'spacing', text: ' ', start: 0.4, end: 1.0 }, // 0.6s spacing
      { type: 'word', text: 'world', start: 1.0, end: 1.4 },
    ];
    const phrases = groupIntoPhrases(words, 0.5);
    expect(phrases).toHaveLength(2);
  });
});

describe('renderMarkdown', () => {
  it('renders without speaker tag when speakerId is undefined (matches python optional-speaker behavior)', () => {
    const md = renderMarkdown([
      { start: 0.0, end: 1.5, text: 'hello world' },
    ]);
    expect(md).toBe('  [000.00-001.50] hello world\n');
  });

  it('renders with speaker tag when speakerId is set, stripping speaker_ prefix', () => {
    const md = renderMarkdown([
      { start: 0.0, end: 1.5, text: 'hello world', speakerId: 'speaker_0' },
    ]);
    expect(md).toBe('  [000.00-001.50] S0 hello world\n');
  });

  it('preserves a non-speaker_-prefixed speaker id verbatim', () => {
    const md = renderMarkdown([
      { start: 0.0, end: 1.5, text: 'hi', speakerId: 'A' },
    ]);
    expect(md).toBe('  [000.00-001.50] SA hi\n');
  });

  it('byte-for-byte: full pack pipeline output matches expected', () => {
    const words: TranscriptWord[] = [
      { type: 'word', text: 'hello', start: 0.0, end: 0.4, speaker_id: 'speaker_0' },
      { type: 'word', text: ',', start: 0.4, end: 0.45, speaker_id: 'speaker_0' },
      { type: 'word', text: 'world', start: 0.5, end: 0.9, speaker_id: 'speaker_0' },
      // 0.7s gap → break
      { type: 'word', text: 'second', start: 1.6, end: 2.0 },
      { type: 'word', text: 'phrase', start: 2.1, end: 2.5 },
    ];
    const md = renderMarkdown(groupIntoPhrases(words, 0.5));
    expect(md).toBe(
      '  [000.00-000.90] S0 hello, world\n  [001.60-002.50] second phrase\n',
    );
  });

  it('renders empty string for zero phrases', () => {
    expect(renderMarkdown([])).toBe('');
  });
});
