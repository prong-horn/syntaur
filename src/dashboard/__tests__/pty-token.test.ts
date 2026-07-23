import { describe, expect, it } from 'vitest';
import { createPtyTokenRegistry } from '../pty-token.js';

/** Deterministic randomBytes: distinct buffers per call so tokens never collide. */
function seqRandomBytes(): (n: number) => Buffer {
  let counter = 0;
  return (n: number) => {
    const buf = Buffer.alloc(n, 0);
    buf.writeUInt32BE(counter++, 0);
    return buf;
  };
}

describe('createPtyTokenRegistry', () => {
  it('mint → consume once succeeds and returns a token bound to short + expiry', () => {
    let t = 1000;
    const reg = createPtyTokenRegistry({ now: () => t, randomBytes: seqRandomBytes(), ttlMs: 60_000 });
    const minted = reg.mint('ab12');
    expect(minted.short).toBe('ab12');
    expect(minted.expiresAt).toBe(1000 + 60_000);
    expect(reg.consume(minted.token, 'ab12')).toBe(true);
  });

  it('is single-use — a second consume fails', () => {
    const reg = createPtyTokenRegistry({ randomBytes: seqRandomBytes() });
    const minted = reg.mint('ab12');
    expect(reg.consume(minted.token, 'ab12')).toBe(true);
    expect(reg.consume(minted.token, 'ab12')).toBe(false);
  });

  it('rejects an expired token', () => {
    let t = 0;
    const reg = createPtyTokenRegistry({ now: () => t, randomBytes: seqRandomBytes(), ttlMs: 60_000 });
    const minted = reg.mint('ab12');
    t = 60_001; // past expiry
    expect(reg.consume(minted.token, 'ab12')).toBe(false);
  });

  it('rejects a token presented for a different short', () => {
    const reg = createPtyTokenRegistry({ randomBytes: seqRandomBytes() });
    const minted = reg.mint('ab12');
    expect(reg.consume(minted.token, 'zz99')).toBe(false);
  });

  it('rejects an unknown token', () => {
    const reg = createPtyTokenRegistry({ randomBytes: seqRandomBytes() });
    expect(reg.consume('deadbeef', 'ab12')).toBe(false);
  });

  it('sweep drops expired entries (and mint sweeps first)', () => {
    let t = 0;
    const reg = createPtyTokenRegistry({ now: () => t, randomBytes: seqRandomBytes(), ttlMs: 1000 });
    reg.mint('a');
    reg.mint('b');
    expect(reg.size()).toBe(2);
    t = 1001;
    reg.sweep();
    expect(reg.size()).toBe(0);
    t = 2000;
    reg.mint('c'); // mint sweeps first, then adds
    expect(reg.size()).toBe(1);
  });
});
