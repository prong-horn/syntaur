// NDJSON framing shared by the control socket and the pty/rv sockets.
//
// Encoding is one JSON object per line. Decoding buffers partial lines across
// chunk boundaries and tolerates junk lines (blank or unparseable) rather than
// throwing — a corrupt frame must not tear down a long-lived byte stream.
//
// Two safety properties: (a) a StringDecoder retains any partial multibyte
// UTF-8 sequence split across socket reads, so non-ASCII argv/paths/output are
// not corrupted with replacement characters; (b) a pending line without its
// terminating newline is capped, so a peer that floods bytes without a newline
// cannot grow the buffer unbounded (local OOM) — the decoder throws and the
// socket handler destroys the peer.

import { StringDecoder } from 'node:string_decoder';

/** Cap on an un-terminated pending line — a backstop against a peer that floods
 * bytes without a newline (local OOM). Sized well above any legitimate frame:
 * the largest is a `snapshot` (base64 of a serialized screen + scrollback),
 * which even with a large scrollback stays far under this. Bounding by
 * `buf.length` (UTF-16 units) rather than exact UTF-8 bytes is fine for a memory
 * backstop — it caps resident memory to ~2× this. Per-channel byte-accurate
 * limits are a possible refinement. */
export const MAX_PENDING_BYTES = 32 << 20; // 32 MiB

/** Serialize one frame as a single newline-terminated JSON line. */
export function encodeFrame(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

/** True for a decoded frame that is a plain object — i.e. safe to read `.op`/
 * `.t` from. `JSON.parse` can yield `null`/arrays/primitives from a malformed
 * peer; dereferencing `.op` on `null` throws, so callers must guard first. */
export function isFrameObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export class FrameOverflowError extends Error {
  constructor(limit: number) {
    super(`ndjson: pending line exceeded ${limit} bytes without a newline`);
    this.name = 'FrameOverflowError';
  }
}

export interface LineDecoder<T> {
  /** Feed a chunk; returns every complete frame it completed. Throws
   * FrameOverflowError if an un-terminated line exceeds the cap. */
  push(chunk: string | Buffer): T[];
  /** Bytes buffered but not yet terminated by a newline. */
  readonly pending: string;
}

/**
 * A streaming NDJSON decoder. Partial lines are held until their terminating
 * newline arrives; blank lines and lines that fail JSON.parse are skipped.
 */
export function createLineDecoder<T = unknown>(maxPendingBytes = MAX_PENDING_BYTES): LineDecoder<T> {
  let buf = '';
  const utf8 = new StringDecoder('utf8');
  return {
    push(chunk: string | Buffer): T[] {
      buf += typeof chunk === 'string' ? chunk : utf8.write(chunk);
      const out: T[] = [];
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.trim() !== '') {
          try {
            out.push(JSON.parse(line) as T);
          } catch {
            // tolerate junk lines — skip and keep decoding
          }
        }
        nl = buf.indexOf('\n');
      }
      if (buf.length > maxPendingBytes) {
        buf = '';
        throw new FrameOverflowError(maxPendingBytes);
      }
      return out;
    },
    get pending(): string {
      return buf;
    },
  };
}
