// AC6 snapshot-restore fixture (Phase D). The pty-host serializes a session's
// screen with @xterm/headless + SerializeAddon; the browser restores it by
// writing that ANSI stream into an @xterm/xterm terminal. This guards the
// cross-generation compatibility risk: a snapshot written back into a fresh
// terminal must re-serialize identically. We assert it here with the headless
// terminal (same engine family as the browser xterm@6 the SPA loads).

import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function makeTerm(): { term: Terminal; serialize: () => string } {
  const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
  const addon = new SerializeAddon();
  term.loadAddon(addon);
  return { term, serialize: () => addon.serialize() };
}

describe('snapshot serialize → restore', () => {
  it('round-trips a screen with color + cursor state', async () => {
    const a = makeTerm();
    await write(a.term, 'line one\r\nHello \x1b[1;31mRED\x1b[0m world\r\n\x1b[32mgreen tail\x1b[0m');
    const snapshot = a.serialize();
    expect(snapshot.length).toBeGreaterThan(0);

    // Restore the snapshot into a fresh terminal (what the browser does).
    const b = makeTerm();
    await write(b.term, snapshot);

    // The restored screen must re-serialize to the same bytes.
    expect(b.serialize()).toBe(snapshot);
  });

  it('restores plain text verbatim into the viewport', async () => {
    const a = makeTerm();
    await write(a.term, 'exact text here');
    const snapshot = a.serialize();
    const b = makeTerm();
    await write(b.term, snapshot);
    expect(b.serialize()).toContain('exact text here');
  });
});
