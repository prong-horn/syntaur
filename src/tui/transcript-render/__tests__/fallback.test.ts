import { describe, it, expect } from 'vitest';
import { createFallbackRenderer, extractFallbackText } from '../fallback.js';

describe('extractFallbackText', () => {
  it('extracts a top-level string text field', () => {
    expect(extractFallbackText(JSON.stringify({ text: 'hello' }))).toBe('hello');
  });

  it('extracts a top-level string content field', () => {
    expect(extractFallbackText(JSON.stringify({ content: 'hello' }))).toBe('hello');
  });

  it('extracts nested message.content string', () => {
    expect(extractFallbackText(JSON.stringify({ message: { content: 'nested' } }))).toBe('nested');
  });

  it('extracts array-of-blocks text content', () => {
    expect(extractFallbackText(JSON.stringify({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }))).toBe('a\nb');
  });

  it('returns null for malformed JSON', () => {
    expect(extractFallbackText('not json')).toBeNull();
  });

  it('returns null when nothing textual is present', () => {
    expect(extractFallbackText(JSON.stringify({ foo: 42, bar: true }))).toBeNull();
  });
});

describe('createFallbackRenderer', () => {
  it('shows the sentinel message once when nothing is ever extractable', () => {
    const r = createFallbackRenderer();
    expect(r.push(['not json', 'still not json'])).toEqual([
      { text: '(unsupported transcript format — attach to view)', style: 'meta' },
    ]);
    expect(r.push(['more garbage'])).toEqual([]);
    expect(r.rows()).toEqual([{ text: '(unsupported transcript format — attach to view)', style: 'meta' }]);
  });

  it('emits extracted rows and tracks lastText', () => {
    const r = createFallbackRenderer();
    const rows = r.push([JSON.stringify({ text: 'first' }), 'garbage', JSON.stringify({ text: 'second' })]);
    expect(rows).toEqual([
      { text: 'first', style: 'meta' },
      { text: 'second', style: 'meta' },
    ]);
    expect(r.lastText()).toBe('second');
    expect(r.rows()).toEqual(rows);
  });

  it('never emits a raw JSONL line even when partially extractable', () => {
    const r = createFallbackRenderer();
    const raw = JSON.stringify({ weird: { deeply: { nested: 'x' } }, garbage: [1, 2, 3] });
    const rows = r.push([raw]);
    for (const row of rows) {
      expect(row.text).not.toContain('"weird"');
      expect(row.text).not.toContain('"garbage"');
    }
  });

  it('caps retained rows at 20', () => {
    const r = createFallbackRenderer();
    const lines = Array.from({ length: 30 }, (_, i) => JSON.stringify({ text: `line-${i}` }));
    r.push(lines);
    expect(r.rows().length).toBe(20);
    expect(r.rows()[0].text).toBe('line-10');
  });
});
