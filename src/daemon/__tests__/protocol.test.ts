import { describe, it, expect } from 'vitest';
import {
  createLineDecoder,
  encodeFrame,
  FrameOverflowError,
  isFrameObject,
  MAX_PENDING_BYTES,
} from '../protocol.js';

describe('encodeFrame', () => {
  it('serializes one object as a newline-terminated JSON line', () => {
    expect(encodeFrame({ op: 'list' })).toBe('{"op":"list"}\n');
  });
});

describe('createLineDecoder', () => {
  it('round-trips multiple frames in one chunk', () => {
    const dec = createLineDecoder();
    const chunk = encodeFrame({ a: 1 }) + encodeFrame({ b: 2 });
    expect(dec.push(chunk)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('reassembles a frame split across chunk boundaries', () => {
    const dec = createLineDecoder<{ op: string }>();
    expect(dec.push('{"op":"dis')).toEqual([]);
    expect(dec.pending).toBe('{"op":"dis');
    expect(dec.push('patch"}\n')).toEqual([{ op: 'dispatch' }]);
    expect(dec.pending).toBe('');
  });

  it('holds a partial trailing line until its newline arrives', () => {
    const dec = createLineDecoder();
    expect(dec.push(`${encodeFrame({ a: 1 })}{"b":`)).toEqual([{ a: 1 }]);
    expect(dec.pending).toBe('{"b":');
    expect(dec.push('2}\n')).toEqual([{ b: 2 }]);
  });

  it('tolerates junk and blank lines without throwing', () => {
    const dec = createLineDecoder();
    const input = `${encodeFrame({ a: 1 })}\nnot json\n${encodeFrame({ b: 2 })}`;
    expect(dec.push(input)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('strips a trailing carriage return (CRLF frames)', () => {
    const dec = createLineDecoder();
    expect(dec.push('{"a":1}\r\n')).toEqual([{ a: 1 }]);
  });

  it('preserves a multibyte UTF-8 char split across chunk boundaries', () => {
    const dec = createLineDecoder<{ s: string }>();
    // "café" — the é (0xC3 0xA9) is split across two Buffer chunks.
    const full = Buffer.from(encodeFrame({ s: 'café' }), 'utf8');
    const cut = full.indexOf(0xa9); // land between the two bytes of é
    expect(dec.push(full.subarray(0, cut))).toEqual([]);
    expect(dec.push(full.subarray(cut))).toEqual([{ s: 'café' }]);
  });

  it('throws FrameOverflowError when a pending line exceeds the cap', () => {
    const dec = createLineDecoder(64); // small cap for the test
    expect(() => dec.push('x'.repeat(65))).toThrow(FrameOverflowError);
    expect(MAX_PENDING_BYTES).toBeGreaterThan(0);
  });

  it('does not overflow on many complete small frames', () => {
    const dec = createLineDecoder(64);
    const chunk = `${encodeFrame({ a: 1 })}${encodeFrame({ b: 2 })}`;
    expect(dec.push(chunk)).toEqual([{ a: 1 }, { b: 2 }]);
    expect(dec.pending).toBe('');
  });
});

describe('isFrameObject', () => {
  it('accepts plain objects and rejects null/array/primitive frames', () => {
    expect(isFrameObject({ op: 'list' })).toBe(true);
    expect(isFrameObject(null)).toBe(false);
    expect(isFrameObject([1, 2])).toBe(false);
    expect(isFrameObject(5)).toBe(false);
    expect(isFrameObject('x')).toBe(false);
    expect(isFrameObject(true)).toBe(false);
  });
});
