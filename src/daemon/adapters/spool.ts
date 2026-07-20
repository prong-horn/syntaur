// Hook-event spool: one append-only hooks.ndjson per job under jobDir(short).
// Writers (platform hook scripts) append single NDJSON lines under O_APPEND;
// the pty-host creates the file, plants SYNTAUR_HOOK_SPOOL, and tails it via
// a chokidar single-file watch + byte-offset delta reads (the
// src/tui/sessions/transcript.ts tailFile pattern) through the junk-tolerant
// createLineDecoder. One decoder instance persists across reads, so a
// partial line split by a racing append carries to the next read.
import chokidar from 'chokidar';
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLineDecoder } from '../protocol.js';
import type { HookEvent } from '../types.js';

/** Cap on the engine's in-memory HookEvent buffer (pty-host applies it). */
export const MAX_HOOK_EVENTS = 200;

/** Create the (empty) spool + its job dir so hook writers can O_APPEND. */
export function ensureSpoolFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, '');
}

/** Max bytes read per chunk when draining a spool delta (review r1 F3). */
const READ_CHUNK_BYTES = 64 * 1024;
/** Spool lines are tiny; an unterminated line past this is hostile/corrupt. */
export const SPOOL_MAX_LINE_BYTES = 1024 * 1024;
/**
 * Grace window after chokidar's 'ready' before the tailer is considered fully
 * live. Verified empirically (macOS/fsevents, chokidar 4.0.3): a write landing
 * in the same event-loop turn as 'ready' — including the microtask
 * continuation of `await tailer.ready` itself — can be silently dropped by the
 * native watcher, not merely delayed: it goes unnoticed INDEFINITELY, until an
 * unrelated later change on the same file happens to wake the watch up. A
 * write deferred past one full timer-phase boundary (>=1ms measured) is always
 * observed reliably; this constant carries generous margin over that floor.
 * Negligible against AC2's 1.5s budget, and never blocks pty-host boot — only
 * tests await `ready`.
 */
const READY_SETTLE_MS = 50;

export interface SpoolTailer {
  /** Resolves once the watcher is armed AND the post-arm catch-up read ran
   *  (review r1 F2 — tests await this to close the startup race). */
  ready: Promise<void>;
  stop(): void;
}

function toHookEvent(v: unknown): HookEvent | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.event !== 'string' || o.event === '') return null;
  return {
    event: o.event,
    at: typeof o.at === 'string' ? o.at : new Date().toISOString(),
    payload: o.payload,
  };
}

/**
 * Tail one spool file. Ordering guarantee (review r1 F2): the chokidar
 * watcher is armed FIRST; on its 'ready' event we run a catch-up read, then
 * ONE MORE deterministic catch-up after a short settle window (READY_SETTLE_MS)
 * before resolving `ready`. An append landing while chokidar initializes is
 * therefore always seen: either by the post-ready catch-up (offset still
 * behind), by the settle catch-up (closes the narrow post-ready dead zone
 * where the native watcher can silently drop a 'change' notification — see
 * READY_SETTLE_MS), or by a normal 'change' event once the watch is fully
 * live — there is no unwatched gap. The immediate read() merely delivers
 * pre-existing lines early; every read is idempotent via the shared offset.
 * Deltas are drained in bounded chunks (review r1 F3): a giant/corrupt append
 * never becomes one allocation, and a FrameOverflowError (decoder clears its
 * pending buffer) is caught per chunk so later valid events in the same delta
 * still decode.
 */
export function tailSpool(path: string, onEvents: (events: HookEvent[]) => void): SpoolTailer {
  let offset = 0;
  let stopped = false;
  const decoder = createLineDecoder<unknown>(SPOOL_MAX_LINE_BYTES);
  const read = (): void => {
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      return; /* transient fs error — retried on the next change event */
    }
    try {
      const size = fstatSync(fd).size;
      const collected: HookEvent[] = [];
      while (offset < size) {
        const len = Math.min(READ_CHUNK_BYTES, size - offset);
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, offset);
        if (n <= 0) break;
        offset += n;
        try {
          // Buffer goes straight to push(): its internal StringDecoder
          // keeps UTF-8 split across chunk boundaries intact.
          for (const v of decoder.push(buf.subarray(0, n))) {
            const e = toHookEvent(v);
            if (e) collected.push(e);
          }
        } catch {
          /* FrameOverflowError — oversized line dropped; keep draining */
        }
      }
      if (collected.length > 0) onEvents(collected);
    } catch {
      /* transient fs error — skip this tick */
    } finally {
      closeSync(fd);
    }
  };
  const watcher = chokidar.watch(path, { ignoreInitial: true });
  watcher.on('change', read);
  watcher.on('error', () => {});
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const ready = new Promise<void>((resolve) => {
    watcher.on('ready', () => {
      read();
      // Second, deterministic catch-up (see READY_SETTLE_MS) — closes the
      // post-ready dead zone regardless of whether 'change' fires for it.
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (!stopped) read();
        resolve();
      }, READY_SETTLE_MS);
    });
  });
  read();
  return {
    ready,
    stop: () => {
      stopped = true;
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      void watcher.close();
    },
  };
}
