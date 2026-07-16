import { describe, it, expect } from 'vitest';
import { makeSyntaurdSessionSource } from '../feed-source.js';

const wireSession = (over: Record<string, unknown> = {}) => ({
  short: 'sd12ab34', agent: 'codex', state: 'working', name: 'p/a', sessionId: 'uuid-1', ...over,
});

describe('makeSyntaurdSessionSource (production projection + failure contract)', () => {
  it('projects ListReply sessions to feed entries', async () => {
    const source = makeSyntaurdSessionSource(async () => ({ ok: true, sessions: [wireSession()] }) as never);
    expect(await source()).toEqual([
      { sessionId: 'uuid-1', short: 'sd12ab34', state: 'working', name: 'p/a', agent: 'codex' },
    ]);
  });

  it('filters sessions without a sessionId join key — live-and-empty yields [], not null', async () => {
    const source = makeSyntaurdSessionSource(async () =>
      ({ ok: true, sessions: [wireSession({ sessionId: null }), wireSession({ sessionId: '' })] }) as never);
    expect(await source()).toEqual([]);
  });

  it('returns null when queryDaemon reports no live daemon', async () => {
    const source = makeSyntaurdSessionSource(async () => null);
    expect(await source()).toBeNull();
  });

  it('returns null on an ErrorReply', async () => {
    const source = makeSyntaurdSessionSource(async () => ({ ok: false, code: 'EPROTO', error: 'bad' }) as never);
    expect(await source()).toBeNull();
  });

  it('returns null when the query throws (hung/garbled daemon)', async () => {
    const source = makeSyntaurdSessionSource(async () => { throw new Error('timeout'); });
    expect(await source()).toBeNull();
  });
});
