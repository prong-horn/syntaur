import { describe, it, expect, afterEach } from 'vitest';
import {
  parseAgentView,
  setAgentViewSource,
  getAgentViewSource,
  productionAgentViewSource,
  parseAgentViewDetail,
} from '../sessions/agent-view.js';

afterEach(() => setAgentViewSource(null));

describe('parseAgentView', () => {
  it('parses a bare array, joining by session_id with canonical activity', () => {
    const map = parseAgentView(
      JSON.stringify([
        { session_id: 's1', activity: 'working' },
        { session_id: 's2', activity: 'awaiting-input' },
      ]),
    );
    expect(map.get('s1')).toBe('working');
    expect(map.get('s2')).toBe('awaiting-input');
    expect(map.size).toBe(2);
  });

  it('accepts an { agents: [...] } envelope and a sessionId alias', () => {
    const map = parseAgentView(
      JSON.stringify({ agents: [{ sessionId: 's3', status: 'idle' }] }),
    );
    expect(map.get('s3')).toBe('idle');
  });

  it('maps an unrecognized activity to idle (presence still keeps it live)', () => {
    const map = parseAgentView(JSON.stringify([{ session_id: 's4', activity: 'compacting' }]));
    expect(map.get('s4')).toBe('idle');
  });

  it('skips entries with no usable session id', () => {
    const map = parseAgentView(
      JSON.stringify([{ activity: 'working' }, { session_id: 42 }, null, 'nope']),
    );
    expect(map.size).toBe(0);
  });

  it('returns an empty map for malformed JSON (best-effort)', () => {
    expect(parseAgentView('not json').size).toBe(0);
    expect(parseAgentView('').size).toBe(0);
  });
});

describe('agent-view source seam', () => {
  it('getAgentViewSource returns the injected override, else production', async () => {
    expect(getAgentViewSource()).toBe(productionAgentViewSource);
    const fake = async () => new Map([['x', 'working' as const]]);
    setAgentViewSource(fake);
    expect(getAgentViewSource()).toBe(fake);
    expect((await getAgentViewSource()()).get('x')).toBe('working');
  });
});

describe('parseAgentViewDetail', () => {
  it('parses state/waitingFor/id/name off a bare array', () => {
    const entries = parseAgentViewDetail(
      JSON.stringify([
        { session_id: 's1', id: 'ab12cd34', name: 'proj/assignment', state: 'blocked', waitingFor: 'permission prompt' },
      ]),
    );
    expect(entries).toEqual([
      { sessionId: 's1', id: 'ab12cd34', name: 'proj/assignment', state: 'blocked', waitingFor: 'permission prompt' },
    ]);
  });

  it('accepts an { agents: [...] } envelope and sessionId/waiting_for aliases', () => {
    const entries = parseAgentViewDetail(
      JSON.stringify({ agents: [{ sessionId: 's2', state: 'working', waiting_for: null }] }),
    );
    expect(entries).toEqual([{ sessionId: 's2', id: 's2'.slice(0, 8), name: null, state: 'working', waitingFor: null }]);
  });

  it('falls back to a session-id prefix when no short id is present', () => {
    const entries = parseAgentViewDetail(JSON.stringify([{ session_id: 'abcdefghijk', state: 'working' }]));
    expect(entries?.[0].id).toBe('abcdefgh');
  });

  it('maps an unrecognized state to null rather than guessing', () => {
    const entries = parseAgentViewDetail(JSON.stringify([{ session_id: 's3', state: 'compacting' }]));
    expect(entries?.[0].state).toBeNull();
  });

  it('skips entries with no usable session id', () => {
    const entries = parseAgentViewDetail(JSON.stringify([{ state: 'working' }, { session_id: 42 }, null]));
    expect(entries).toEqual([]);
  });

  it('returns [] for a validly-shaped but genuinely empty list (not a probe failure)', () => {
    expect(parseAgentViewDetail('[]')).toEqual([]);
    expect(parseAgentViewDetail(JSON.stringify({ agents: [] }))).toEqual([]);
  });

  it('returns null for malformed JSON (probe failure)', () => {
    expect(parseAgentViewDetail('not json')).toBeNull();
    expect(parseAgentViewDetail('')).toBeNull();
  });

  it('returns null when the JSON is valid but not a recognizable agents envelope (probe failure)', () => {
    expect(parseAgentViewDetail(JSON.stringify({ unrelated: true }))).toBeNull();
    expect(parseAgentViewDetail(JSON.stringify('just a string'))).toBeNull();
  });
});
