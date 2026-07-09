import { describe, it, expect } from 'vitest';
import { createLineDecoder, encodeFrame } from '../protocol.js';

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
});
