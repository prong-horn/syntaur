// Task 6: hook-event spool transport. Real tmpdir + real fs events throughout
// (chokidar watches a real file); vi.waitFor asserts async delivery instead of
// fake timers (fake timers don't advance libuv fs-watch callbacks).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSpoolFile, tailSpool, type SpoolTailer } from '../adapters/spool.js';
import type { HookEvent } from '../types.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Serialize one NDJSON line (helper — mirrors what a hook script writes). */
function line(e: { event: string; at?: string; payload?: unknown }): string {
  return `${JSON.stringify(e)}\n`;
}

// ── (a) ensureSpoolFile ──────────────────────────────────────────────────────

describe('ensureSpoolFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'syntaur-spool-ensure-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates missing parent dirs and an empty file', () => {
    const spool = join(dir, 'nested', 'deeper', 'hooks.ndjson');
    ensureSpoolFile(spool);
    expect(readFileSync(spool, 'utf8')).toBe('');
  });

  it('is idempotent: calling it twice does not truncate existing content', () => {
    const spool = join(dir, 'hooks.ndjson');
    ensureSpoolFile(spool);
    appendFileSync(spool, line({ event: 'PreExisting', at: '2026-07-19T00:00:00.000Z' }));
    ensureSpoolFile(spool);
    expect(readFileSync(spool, 'utf8')).toContain('"event":"PreExisting"');
  });
});

// ── tailSpool ────────────────────────────────────────────────────────────────

describe('tailSpool', () => {
  let dir: string;
  let spool: string;
  let tailer: SpoolTailer | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'syntaur-spool-tail-'));
    spool = join(dir, 'hooks.ndjson');
  });
  afterEach(() => {
    tailer?.stop();
    tailer = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('(b) delivers well-formed lines in order, with event/at/payload intact', async () => {
    ensureSpoolFile(spool);
    const received: HookEvent[] = [];
    tailer = tailSpool(spool, (events) => received.push(...events));
    await tailer.ready;

    appendFileSync(
      spool,
      line({ event: 'PreToolUse', at: '2026-07-19T10:00:00.000Z', payload: { tool: 'Bash' } }) +
        line({ event: 'PostToolUse', at: '2026-07-19T10:00:01.000Z', payload: { tool: 'Bash', ok: true } }),
    );

    await vi.waitFor(() => expect(received.length).toBe(2), { timeout: 2000 });
    expect(received[0]).toEqual({
      event: 'PreToolUse',
      at: '2026-07-19T10:00:00.000Z',
      payload: { tool: 'Bash' },
    });
    expect(received[1]).toEqual({
      event: 'PostToolUse',
      at: '2026-07-19T10:00:01.000Z',
      payload: { tool: 'Bash', ok: true },
    });
  });

  it('(c) junk resilience: unparseable + eventless lines are skipped, the valid line still delivers', async () => {
    ensureSpoolFile(spool);
    const received: HookEvent[] = [];
    tailer = tailSpool(spool, (events) => received.push(...events));
    await tailer.ready;

    appendFileSync(
      spool,
      `not-json\n${line({ event: 'Notification', at: '2026-07-19T10:00:00.000Z' })}{"noEvent":1}\n`,
    );

    await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 2000 });
    expect(received[0]).toMatchObject({ event: 'Notification' });
  });

  it('(d) carries a partial line split across two appends', async () => {
    ensureSpoolFile(spool);
    const received: HookEvent[] = [];
    tailer = tailSpool(spool, (events) => received.push(...events));
    await tailer.ready;

    const full = line({ event: 'Stop', at: '2026-07-19T10:00:00.000Z', payload: { ok: true } });
    const mid = Math.floor(full.length / 2);
    const half1 = full.slice(0, mid); // no trailing newline
    const half2 = full.slice(mid); // rest, including the trailing newline

    appendFileSync(spool, half1);
    await sleep(150);
    appendFileSync(spool, half2);

    await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 2000 });
    expect(received[0]).toEqual({ event: 'Stop', at: '2026-07-19T10:00:00.000Z', payload: { ok: true } });
  });

  it('(e) catch-up: delivers a line written BEFORE tailSpool starts, from the initial read', async () => {
    ensureSpoolFile(spool);
    appendFileSync(spool, line({ event: 'SessionStart', at: '2026-07-19T09:00:00.000Z' }));

    const received: HookEvent[] = [];
    tailer = tailSpool(spool, (events) => received.push(...events));

    // The synchronous read() inside tailSpool delivers this before any fs event.
    expect(received.length).toBe(1);
    expect(received[0]).toMatchObject({ event: 'SessionStart' });
  });

  it('(f) stop() closes the watcher: no further delivery after stop (300ms settle)', async () => {
    ensureSpoolFile(spool);
    const received: HookEvent[] = [];
    const t = tailSpool(spool, (events) => received.push(...events));
    await t.ready;
    t.stop();

    appendFileSync(spool, line({ event: 'AfterStop', at: '2026-07-19T10:00:00.000Z' }));
    await sleep(300);
    expect(received.length).toBe(0);
  });

  it('(g) startup race: an append issued immediately after tailSpool is delivered by ready time', async () => {
    ensureSpoolFile(spool);
    const received: HookEvent[] = [];
    const t = tailSpool(spool, (events) => received.push(...events));
    tailer = t;
    // Append BEFORE awaiting anything — races the watcher's own initialization.
    appendFileSync(spool, line({ event: 'RaceEvent', at: '2026-07-19T10:00:00.000Z' }));

    await t.ready;
    await vi.waitFor(() => expect(received.some((e) => e.event === 'RaceEvent')).toBe(true), { timeout: 2000 });
  });

  it('(h) oversized append: an unterminated >1MiB line is dropped, the following valid line still decodes', async () => {
    ensureSpoolFile(spool);
    const received: HookEvent[] = [];
    tailer = tailSpool(spool, (events) => received.push(...events));
    await tailer.ready;

    const junk = 'x'.repeat(2 * 1024 * 1024); // 2 MiB, no newline — exceeds SPOOL_MAX_LINE_BYTES (1 MiB)
    const valid = line({ event: 'ValidAfterOverflow', at: '2026-07-19T10:00:00.000Z', payload: { n: 1 } });
    appendFileSync(spool, `${junk}\n${valid}`);

    await vi.waitFor(() => expect(received.some((e) => e.event === 'ValidAfterOverflow')).toBe(true), {
      timeout: 3000,
    });
    // Process is still alive and responsive — prove the tailer keeps working.
    const received2: HookEvent[] = [];
    tailer.stop();
    tailer = tailSpool(spool, (events) => received2.push(...events));
    appendFileSync(spool, line({ event: 'StillAlive', at: '2026-07-19T10:00:01.000Z' }));
    await vi.waitFor(() => expect(received2.some((e) => e.event === 'StillAlive')).toBe(true), { timeout: 2000 });
  });
});
