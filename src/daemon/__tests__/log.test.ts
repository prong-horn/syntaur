import { describe, expect, it } from 'vitest';
import { appendLog, formatLogLine, renderLogValue, tailLog } from '../log.js';

describe('appendLog (structured NDJSON emitter)', () => {
  it('writes one JSON record per line with ts/level/event + fields', () => {
    const written: string[] = [];
    appendLog('dispatch', { short: 's1', agent: 'codex' }, 'info', {
      now: () => 0,
      append: (_p, data) => written.push(data),
    });
    expect(written).toHaveLength(1);
    expect(written[0].endsWith('\n')).toBe(true);
    const rec = JSON.parse(written[0]);
    expect(rec).toMatchObject({ event: 'dispatch', level: 'info', short: 's1', agent: 'codex' });
    expect(rec.ts).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('never throws — a failing append is swallowed', () => {
    expect(() =>
      appendLog('boom', {}, 'error', {
        append: () => {
          throw new Error('disk full');
        },
      }),
    ).not.toThrow();
  });

  it('never throws on an unserializable field (circular ref)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let called = false;
    expect(() =>
      appendLog('x', circular, 'info', { append: () => { called = true; } }),
    ).not.toThrow();
    // JSON.stringify throws before append runs → nothing written, no crash.
    expect(called).toBe(false);
  });
});

describe('formatLogLine (tolerant human renderer)', () => {
  it('renders a valid LogRecord to a human line (no raw JSON)', () => {
    const line = JSON.stringify({ ts: '2026-07-23T00:00:00.000Z', level: 'info', event: 'dispatch', short: 's1', agent: 'codex' });
    const out = formatLogLine(line);
    expect(out).toContain('2026-07-23T00:00:00.000Z');
    expect(out).toContain('[info]');
    expect(out).toContain('dispatch');
    expect(out).toContain('short=s1');
    expect(out).toContain('agent=codex');
    expect(out.startsWith('{')).toBe(false); // never surfaces raw JSON
  });

  it('passes a legacy plaintext line through unchanged', () => {
    const legacy = '2026-07-01T00:00:00.000Z started daemon abcd pid=123';
    expect(formatLogLine(legacy)).toBe(legacy);
  });

  it('emits malformed JSON and non-records raw, never throwing', () => {
    expect(formatLogLine('{not json')).toBe('{not json');
    expect(formatLogLine('{"foo":1}')).toBe('{"foo":1}'); // valid JSON but not a LogRecord
    expect(() => formatLogLine('')).not.toThrow();
    expect(() => formatLogLine('{"ts":123}')).not.toThrow();
  });

  it('renders a nested object field via renderLogValue', () => {
    const line = '{"ts":"2026-07-23T00:00:00.000Z","level":"info","event":"weird","payload":{"a":{"b":1}}}';
    const out = formatLogLine(line);
    expect(out).toContain('weird');
    expect(out).toContain('payload={"a":{"b":1}}');
  });
});

describe('renderLogValue (never-throws field renderer)', () => {
  it('renders primitives and plain objects', () => {
    expect(renderLogValue('s1')).toBe('s1');
    expect(renderLogValue(42)).toBe('42');
    expect(renderLogValue(['a', 'b'])).toBe('["a","b"]');
    expect(renderLogValue({ a: 1 })).toBe('{"a":1}');
  });

  it('returns [unrenderable] for values JSON.stringify throws on — never throws', () => {
    // These reliably make JSON.stringify throw; without the guard the call
    // (and `daemon logs`) would crash. This is the real regression test for the
    // round-1 never-throw fix.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => renderLogValue(circular)).not.toThrow();
    expect(renderLogValue(circular)).toBe('[unrenderable]');
    expect(renderLogValue(10n)).toBe('[unrenderable]'); // BigInt
  });
});

describe('daemon logs render pipeline (tailLog → formatLogLine — mirrors logsSub)', () => {
  it('renders a mixed legacy + NDJSON + malformed tail in order, human-readable', () => {
    const raw = [
      '2026-07-01T00:00:00.000Z started daemon old pid=1', // legacy
      JSON.stringify({ ts: '2026-07-02T00:00:00.000Z', level: 'info', event: 'dispatch', short: 's1' }),
      '{broken', // malformed
      JSON.stringify({ ts: '2026-07-03T00:00:00.000Z', level: 'warn', event: 'kill', short: 's1' }),
    ].join('\n') + '\n';

    const rendered = tailLog(3, { read: () => raw }).map(formatLogLine);
    expect(rendered).toHaveLength(3); // tail count honored
    // order preserved (newest last): NDJSON dispatch, malformed raw, NDJSON kill
    expect(rendered[0]).toContain('dispatch');
    expect(rendered[0].startsWith('{')).toBe(false);
    expect(rendered[1]).toBe('{broken'); // malformed passed through raw
    expect(rendered[2]).toContain('[warn]');
    expect(rendered[2]).toContain('kill');
    // no rendered line is raw structured JSON
    expect(rendered.some((l) => l.startsWith('{"'))).toBe(false);
  });
});
