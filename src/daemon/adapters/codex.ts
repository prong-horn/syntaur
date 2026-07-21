// Codex adapter: notify turn-end events (payload schema unverified upstream —
// ANY spooled notify event is treated as a turn boundary, D6), rollout-log
// recency (codex streams its rollout JSONL while reasoning even when the tty
// is silent), and generic screen heuristics as the floor. Heuristics-only
// when notify was never wired.
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DeriveInput, DerivedState } from '../types.js';
import { genericAdapter } from './generic.js';
import type { AgentAdapter } from './types.js';

/** Output younger than this = actively printing → working. */
export const NOTIFY_ACTIVE_MS = 2000;
/** Rollout mtime younger than this = codex is alive (thinking) → working. */
export const ROLLOUT_FRESH_MS = 15_000;

/** ms since the matching rollout log last grew, or null when unknown. */
export type RolloutProbe = (cwd: string) => number | null;

function sessionsRoot(): string {
  return process.env.CODEX_SESSIONS_DIR && process.env.CODEX_SESSIONS_DIR !== ''
    ? process.env.CODEX_SESSIONS_DIR
    : join(homedir(), '.codex', 'sessions');
}

function firstLine(path: string): string | null {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, 4096, 0);
      const text = buf.toString('utf8', 0, n);
      const nl = text.indexOf('\n');
      return nl === -1 ? text : text.slice(0, nl);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Newest rollout-*.jsonl whose line-1 session_meta payload.cwd matches
 * (resolve-session.sh:26-43 semantics), bounded to the 20 newest files;
 * found path cached per cwd, mtime stat'd per call. */
export function defaultRolloutProbe(): RolloutProbe {
  const cache = new Map<string, string>();
  const resolve = (cwd: string): string | null => {
    const hit = cache.get(cwd);
    if (hit !== undefined) return hit;
    try {
      const root = sessionsRoot();
      const files: Array<{ path: string; mtime: number }> = [];
      for (const y of readdirSync(root)) {
        for (const m of readdirSync(join(root, y))) {
          for (const d of readdirSync(join(root, y, m))) {
            const dir = join(root, y, m, d);
            for (const f of readdirSync(dir)) {
              if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
              const path = join(dir, f);
              files.push({ path, mtime: statSync(path).mtimeMs });
            }
          }
        }
      }
      files.sort((a, b) => b.mtime - a.mtime);
      for (const { path } of files.slice(0, 20)) {
        const line = firstLine(path);
        if (line === null) continue;
        try {
          const meta = JSON.parse(line) as { type?: string; payload?: { cwd?: string } };
          if (meta.type === 'session_meta' && meta.payload?.cwd === cwd) {
            cache.set(cwd, path);
            return path;
          }
        } catch {
          /* junk first line — skip */
        }
      }
    } catch {
      /* sessions root missing/unreadable */
    }
    return null;
  };
  return (cwd) => {
    const path = resolve(cwd);
    if (path === null) return null;
    try {
      return Math.max(0, Date.now() - statSync(path).mtimeMs);
    } catch {
      cache.delete(cwd); // file vanished — re-resolve next call
      return null;
    }
  };
}

/** Trailing-paint window: output landing within this after a notify (the
 * turn-end banner) does NOT invalidate it; anything later means a NEW turn
 * started and the notify is history (review r3 F2). */
const NOTIFY_TRAILING_MS = 2000;

export function createCodexAdapter(probe: RolloutProbe = defaultRolloutProbe()): AgentAdapter {
  const rolloutIdleMs = (cwd: string): number | null => {
    try {
      return probe(cwd);
    } catch {
      return null;
    }
  };
  return {
    id: 'codex',
    deriveState: (x: DeriveInput): DerivedState => {
      // A notify is ACTIVE only while it is newer than the last PTY output
      // (modulo the trailing-paint window). A latched "has a notify ever
      // fired" would bypass screen heuristics forever after the first turn
      // and misreport 'blocked' on every later quiet stretch (review r3 F2).
      const lastOutputAtMs = x.nowMs - x.outputIdleMs;
      const newestNotifyAtMs = x.hookEvents.reduce<number | null>((acc, e) => {
        if (e.event !== 'notify') return acc;
        const t = Date.parse(e.at);
        if (!Number.isFinite(t)) return acc;
        return acc === null || t > acc ? t : acc;
      }, null);
      const notifyActive =
        newestNotifyAtMs !== null && lastOutputAtMs <= newestNotifyAtMs + NOTIFY_TRAILING_MS;
      const rollout = rolloutIdleMs(x.cwd);
      const rolloutFresh = rollout !== null && rollout < ROLLOUT_FRESH_MS;
      if (notifyActive) {
        if (x.outputIdleMs < NOTIFY_ACTIVE_MS) return { state: 'working', needs: null };
        if (rolloutFresh) return { state: 'working', needs: null };
        return { state: 'blocked', needs: 'awaiting input' };
      }
      // No ACTIVE notify (never wired, or a newer turn's output superseded
      // it): screen heuristics, with rollout freshness vetoing a false
      // 'blocked' while codex thinks silently.
      const generic = genericAdapter.deriveState(x);
      if (generic.state === 'blocked' && rolloutFresh) return { state: 'working', needs: null };
      return generic;
    },
  };
}

export const codexAdapter: AgentAdapter = createCodexAdapter();
