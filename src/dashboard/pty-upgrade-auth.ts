// Pure authorization for the pty WebSocket upgrade (Phase D, locked security
// decision: loopback-only + single-use per-session token).
//
// Extracted from the server's `upgrade` handler so the REJECT paths are unit-
// testable: a real ws client always presents 127.0.0.1, so a fake request with a
// non-loopback remoteAddress is the only way to prove the guard. Gate order is
// deliberate — loopback and path are checked BEFORE the token is consumed, so a
// malformed or off-host request never burns a valid single-use token.

import { DEFAULT_COLS, DEFAULT_ROWS, MAX_COLS, MAX_ROWS, isLoopbackAddress, validDim } from './pty-bridge.js';

const PTY_PATH = /^\/ws\/agent-sessions\/([^/]+)\/pty$/;
/** Daemon short ids are short alphanumerics (see supervisor genShort). Enforce
 * the shape before touching the token so a hostile path can't smuggle anything. */
const SHORT_RE = /^[A-Za-z0-9]{1,32}$/;

export interface UpgradeRequestLike {
  url?: string;
  socket: { remoteAddress?: string | undefined };
}

export interface PtyUpgradeAuthDeps {
  tokenRegistry: { consume(token: string, short: string): boolean };
  isLoopbackAddress?: (addr: string | undefined | null) => boolean;
}

export type AuthReason = 'not-loopback' | 'bad-path' | 'no-token' | 'bad-token';

export type AuthResult =
  | { ok: true; short: string; cols: number; rows: number }
  | { ok: false; reason: AuthReason };

/** Authorize (and consume the token for) a pty upgrade. Consumes the token only
 * when loopback + path pass, so rejects never spend a token. */
export function authorizePtyUpgrade(request: UpgradeRequestLike, deps: PtyUpgradeAuthDeps): AuthResult {
  const isLoopback = deps.isLoopbackAddress ?? isLoopbackAddress;
  if (!isLoopback(request.socket?.remoteAddress)) return { ok: false, reason: 'not-loopback' };

  let url: URL;
  try {
    url = new URL(request.url ?? '', 'http://localhost');
  } catch {
    return { ok: false, reason: 'bad-path' };
  }
  const match = PTY_PATH.exec(url.pathname);
  if (!match) return { ok: false, reason: 'bad-path' };
  let short: string;
  try {
    short = decodeURIComponent(match[1]); // throws URIError on malformed %-encoding
  } catch {
    return { ok: false, reason: 'bad-path' };
  }
  if (!SHORT_RE.test(short)) return { ok: false, reason: 'bad-path' };

  const token = url.searchParams.get('token');
  if (!token) return { ok: false, reason: 'no-token' };
  if (!deps.tokenRegistry.consume(token, short)) return { ok: false, reason: 'bad-token' };

  const cols = validDim(Number(url.searchParams.get('cols')), MAX_COLS) ?? DEFAULT_COLS;
  const rows = validDim(Number(url.searchParams.get('rows')), MAX_ROWS) ?? DEFAULT_ROWS;
  return { ok: true, short, cols, rows };
}
