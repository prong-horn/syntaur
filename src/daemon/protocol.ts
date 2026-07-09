// NDJSON framing shared by the control socket and the pty/rv sockets.
//
// Encoding is one JSON object per line. Decoding buffers partial lines across
// chunk boundaries and tolerates junk lines (blank or unparseable) rather than
// throwing — a corrupt frame must not tear down a long-lived byte stream.

/** Serialize one frame as a single newline-terminated JSON line. */
export function encodeFrame(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

export interface LineDecoder<T> {
  /** Feed a chunk; returns every complete frame it completed. */
  push(chunk: string | Buffer): T[];
  /** Bytes buffered but not yet terminated by a newline. */
  readonly pending: string;
}

/**
 * A streaming NDJSON decoder. Partial lines are held until their terminating
 * newline arrives; blank lines and lines that fail JSON.parse are skipped.
 */
export function createLineDecoder<T = unknown>(): LineDecoder<T> {
  let buf = '';
  return {
    push(chunk: string | Buffer): T[] {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
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
      return out;
    },
    get pending(): string {
      return buf;
    },
  };
}
