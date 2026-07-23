// Short-lived, single-use, per-session tokens gating the pty WebSocket upgrade
// (Phase D, locked security decision). This is the first auth machinery in the
// dashboard: `createDashboardServer` holds ONE registry; the REST mint endpoint
// issues a token bound to a daemon `short`, and the ws upgrade handler consumes
// it exactly once. Tokens are opaque random hex, expire fast (~60s), and are
// deleted on first accept so a captured URL cannot be replayed.

import { randomBytes as realRandomBytes } from 'node:crypto';

export interface MintedToken {
  token: string;
  short: string;
  expiresAt: number;
}

export interface PtyTokenRegistry {
  /** Issue a token bound to `short`. Sweeps expired entries first. */
  mint(short: string): MintedToken;
  /** Accept `token` iff it exists, is unexpired, and is bound to `short` —
   * then delete it (single-use). */
  consume(token: string, short: string): boolean;
  /** Drop expired entries. */
  sweep(): void;
  /** Live (unexpired-or-not) entry count — for tests/introspection. */
  size(): number;
}

export interface PtyTokenRegistryDeps {
  now?: () => number;
  randomBytes?: (n: number) => Buffer;
  ttlMs?: number;
}

export function createPtyTokenRegistry(deps: PtyTokenRegistryDeps = {}): PtyTokenRegistry {
  const now = deps.now ?? (() => Date.now());
  const randomBytes = deps.randomBytes ?? realRandomBytes;
  const ttlMs = deps.ttlMs ?? 60_000;
  const entries = new Map<string, { short: string; expiresAt: number }>();

  function sweep(): void {
    const t = now();
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= t) entries.delete(token);
    }
  }

  return {
    mint(short: string): MintedToken {
      sweep();
      const token = randomBytes(32).toString('hex');
      const expiresAt = now() + ttlMs;
      entries.set(token, { short, expiresAt });
      return { token, short, expiresAt };
    },
    consume(token: string, short: string): boolean {
      const entry = entries.get(token);
      if (!entry) return false;
      // Delete regardless of the outcome below — a presented token is spent even
      // if it was for the wrong short (no oracle, no retry).
      entries.delete(token);
      if (entry.expiresAt <= now()) return false;
      if (entry.short !== short) return false;
      return true;
    },
    sweep,
    size(): number {
      return entries.size;
    },
  };
}
