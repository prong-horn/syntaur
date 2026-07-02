import { describe, it, expect } from 'vitest';
import { MouseParser, isMouseSequence } from '../parse.js';

describe('MouseParser (SGR 1006)', () => {
  it('parses a left press and release (M/m), 0-indexing coords', () => {
    const p = new MouseParser();
    expect(p.push('\x1b[<0;12;5M')).toEqual([{ x: 11, y: 4, button: 'left', action: 'down' }]);
    expect(p.push('\x1b[<0;12;5m')).toEqual([{ x: 11, y: 4, button: 'left', action: 'up' }]);
  });
  it('classifies wheel events by bit 6, direction by bit 0', () => {
    const p = new MouseParser();
    expect(p.push('\x1b[<64;3;3M')[0].action).toBe('scroll-up');
    expect(p.push('\x1b[<65;3;3M')[0].action).toBe('scroll-down');
  });
  it('does NOT misclassify middle-click (cb=1) as scroll', () => {
    const p = new MouseParser();
    const e = p.push('\x1b[<1;1;1M')[0];
    expect(e.action).toBe('down');
    expect(e.button).toBe('middle');
  });
  it('parses right button (cb=2) and motion (drag bit 32) as move', () => {
    const p = new MouseParser();
    expect(p.push('\x1b[<2;1;1M')[0].button).toBe('right');
    expect(p.push('\x1b[<35;9;9M')[0].action).toBe('move');
  });
  it('buffers a sequence split across two chunks', () => {
    const p = new MouseParser();
    expect(p.push('\x1b[<0;1;1')).toEqual([]); // incomplete, held
    expect(p.push('M')).toEqual([{ x: 0, y: 0, button: 'left', action: 'down' }]);
  });
  it('buffers splits INSIDE the prefix (after ESC and after ESC[)', () => {
    const a = new MouseParser();
    expect(a.push('\x1b')).toEqual([]);
    expect(a.push('[<0;1;1M')).toEqual([{ x: 0, y: 0, button: 'left', action: 'down' }]);
    const b = new MouseParser();
    expect(b.push('\x1b[')).toEqual([]);
    expect(b.push('<0;1;1M')).toEqual([{ x: 0, y: 0, button: 'left', action: 'down' }]);
  });
  it('does NOT swallow a completed non-mouse escape (arrow key ESC[A)', () => {
    const p = new MouseParser();
    expect(p.push('\x1b[A')).toEqual([]);        // no mouse event
    // carry must be empty: the next real mouse chunk parses cleanly on its own
    expect(p.push('\x1b[<0;1;1M')).toEqual([{ x: 0, y: 0, button: 'left', action: 'down' }]);
  });
  it('ignores non-mouse bytes and parses multiple events in one chunk', () => {
    const p = new MouseParser();
    const evts = p.push('x\x1b[<0;1;1M\x1b[<0;1;1my');
    expect(evts.map((e) => e.action)).toEqual(['down', 'up']);
  });
  it('isMouseSequence detects an SGR mouse prefix', () => {
    expect(isMouseSequence('\x1b[<0;1;1M')).toBe(true);
    expect(isMouseSequence('q')).toBe(false);
  });
});
