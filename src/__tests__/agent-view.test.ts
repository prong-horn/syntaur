import { describe, it, expect, afterEach } from 'vitest';
import {
  parseAgentView,
  setAgentViewSource,
  getAgentViewSource,
  productionAgentViewSource,
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
