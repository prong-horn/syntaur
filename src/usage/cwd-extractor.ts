/**
 * Session metadata extractor.
 *
 * Reads Claude Code and Codex JSONL session files to produce
 * `(sessionId, cwd, startTs, endTs)` tuples for use in the attribution
 * join. Mutates nothing; touches no DB.
 *
 * - Claude Code: `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`. The
 *   directory name is treated as opaque (slug decoding is unsafe because
 *   legitimate directory names can contain `-`). `cwd` is read from inside
 *   the transcript via the existing `derivePathFromTranscript` utility.
 *   `sessionId` is the basename without `.jsonl`.
 *
 * - Codex: `<sessions-root>/YYYY/MM/DD/rollout-*.jsonl` (or flat at the
 *   sessions-root for older Codex versions). Line 1 is a `session_meta`
 *   envelope with `{type, timestamp, payload:{id, cwd, ...}}` — `timestamp`
 *   is at the TOP LEVEL (verified against
 *   `src/__tests__/codex-resolve-session.test.ts:30-34`), NOT inside
 *   `payload`. Sessions root resolves via:
 *     CODEX_SESSIONS_DIR
 *     ?? path.join(CODEX_HOME, 'sessions')
 *     ?? ~/.codex/sessions
 */

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { expandHome } from '../utils/paths.js';
import { derivePathFromTranscript } from '../utils/transcript.js';

const SCAN_LINE_CAP = 50;
const TAIL_READ_BYTES = 8 * 1024;
const TAIL_READ_BYTES_MAX = 64 * 1024;

export interface ClaudeSessionMeta {
  tool: 'claude';
  sessionId: string;
  cwd: string;
  startTs: string | null;
  endTs: string | null;
  /** Absolute path to the transcript file (for mtime-based ordering). */
  path: string;
}

export interface CodexSessionMeta {
  tool: 'codex';
  sessionId: string;
  cwd: string;
  startTs: string;
  endTs: string;
  /** Absolute path to the rollout file (for mtime-based ordering). */
  path: string;
}

export type SessionMeta = ClaudeSessionMeta | CodexSessionMeta;

// --- Claude Code ----------------------------------------------------------

/**
 * Extract session metadata from a Claude Code transcript file. Returns
 * `null` when the file is unreadable, has no `cwd`, or fails to parse.
 */
export async function extractClaudeSessionMeta(
  jsonlPath: string,
): Promise<ClaudeSessionMeta | null> {
  const cwd = await derivePathFromTranscript(jsonlPath);
  if (!cwd) return null;

  const basename = jsonlPath.split('/').pop() ?? '';
  const sessionId = basename.replace(/\.jsonl$/, '');
  if (!sessionId) return null;

  const startTs = await readFirstTimestamp(jsonlPath);
  const endTs = await readLastTimestamp(jsonlPath);

  return {
    tool: 'claude',
    sessionId,
    cwd,
    startTs,
    endTs,
    path: jsonlPath,
  };
}

// --- Codex ----------------------------------------------------------------

/**
 * Extract session metadata from a Codex rollout file. Returns `null` if line
 * 1 isn't a valid `session_meta` envelope.
 */
export async function extractCodexSessionMeta(
  jsonlPath: string,
): Promise<CodexSessionMeta | null> {
  let handle;
  try {
    handle = await open(jsonlPath, 'r');
  } catch {
    return null;
  }
  try {
    const stream = handle.createReadStream({ encoding: 'utf-8' });
    let buffer = '';
    let firstLine: string | null = null;
    for await (const chunk of stream) {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        firstLine = buffer.slice(0, nl);
        stream.destroy();
        break;
      }
    }
    if (!firstLine && buffer.length > 0) firstLine = buffer;
    if (!firstLine) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(firstLine);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const obj = parsed as Record<string, unknown>;
    if (obj.type !== 'session_meta') return null;

    const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : null;
    const payload = obj.payload as Record<string, unknown> | undefined;
    const id = payload && typeof payload.id === 'string' ? payload.id : null;
    const cwd = payload && typeof payload.cwd === 'string' ? payload.cwd : null;

    if (!timestamp || !id || !cwd) return null;

    const endTs = (await readLastTimestamp(jsonlPath)) ?? timestamp;

    return {
      tool: 'codex',
      sessionId: id,
      cwd,
      startTs: timestamp,
      endTs,
      path: jsonlPath,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

// --- Walkers --------------------------------------------------------------

/**
 * Yield session metadata for every Claude Code transcript under `root`
 * (default `~/.claude/projects`). One `cwd` is cached per directory after
 * the first session in it produces a hit — every Claude session under a
 * `<cwd-slug>` directory launched from the same cwd.
 *
 * Optional `sinceMtimeMs` bounds the walk to files modified at or after
 * the given epoch ms (matching the CLI's first-run 30-day window).
 */
export async function* walkClaudeProjects(opts: {
  root?: string;
  sinceMtimeMs?: number;
} = {}): AsyncGenerator<ClaudeSessionMeta> {
  const root = expandHome(opts.root ?? '~/.claude/projects');
  const dirs = await listDirSafe(root);
  for (const dirent of dirs) {
    if (!dirent.isDirectory) continue;
    const dirPath = join(root, dirent.name);
    const files = await listDirSafe(dirPath);
    let cachedCwd: string | null = null;
    for (const f of files) {
      if (!f.isFile || !f.name.endsWith('.jsonl')) continue;
      const filePath = join(dirPath, f.name);
      if (opts.sinceMtimeMs !== undefined) {
        const mtime = await mtimeMs(filePath);
        if (mtime !== null && mtime < opts.sinceMtimeMs) continue;
      }
      let meta: ClaudeSessionMeta | null;
      if (cachedCwd) {
        // Still need timestamps + sessionId from this file.
        const sessionId = f.name.replace(/\.jsonl$/, '');
        const startTs = await readFirstTimestamp(filePath);
        const endTs = await readLastTimestamp(filePath);
        meta = { tool: 'claude', sessionId, cwd: cachedCwd, startTs, endTs, path: filePath };
      } else {
        meta = await extractClaudeSessionMeta(filePath);
        if (meta) cachedCwd = meta.cwd;
      }
      if (meta) yield meta;
    }
  }
}

/**
 * Yield session metadata for every Codex rollout file under the resolved
 * sessions root.
 */
export async function* walkCodexSessions(opts: {
  root?: string;
  sinceMtimeMs?: number;
} = {}): AsyncGenerator<CodexSessionMeta> {
  const root = resolveCodexSessionsRoot(opts.root);
  for await (const filePath of walkJsonlRecursive(root)) {
    const basename = filePath.split('/').pop() ?? '';
    // Codex names files like `rollout-*.jsonl`; tolerate but prefer that prefix.
    if (!basename.endsWith('.jsonl')) continue;
    if (opts.sinceMtimeMs !== undefined) {
      const mtime = await mtimeMs(filePath);
      if (mtime !== null && mtime < opts.sinceMtimeMs) continue;
    }
    const meta = await extractCodexSessionMeta(filePath);
    if (meta) yield meta;
  }
}

export function resolveCodexSessionsRoot(override?: string): string {
  if (override) return expandHome(override);
  const fromSessionsEnv = process.env.CODEX_SESSIONS_DIR;
  if (fromSessionsEnv && fromSessionsEnv.length > 0) return expandHome(fromSessionsEnv);
  const fromHomeEnv = process.env.CODEX_HOME;
  if (fromHomeEnv && fromHomeEnv.length > 0) return join(expandHome(fromHomeEnv), 'sessions');
  return join(homedir(), '.codex', 'sessions');
}

// --- Internals ------------------------------------------------------------

async function listDirSafe(
  path: string,
): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
    }));
  } catch {
    return [];
  }
}

async function* walkJsonlRecursive(root: string): AsyncGenerator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await listDirSafe(current);
    for (const e of entries) {
      const full = join(current, e.name);
      if (e.isDirectory) {
        stack.push(full);
      } else if (e.isFile && e.name.endsWith('.jsonl')) {
        yield full;
      }
    }
  }
}

async function mtimeMs(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Bounded forward scan for the first JSON line carrying a `timestamp` field.
 * Returns `null` if none found within `SCAN_LINE_CAP` lines.
 */
async function readFirstTimestamp(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const stream = handle.createReadStream({ encoding: 'utf-8' });
    let buffer = '';
    let scanned = 0;
    for await (const chunk of stream) {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const ts = extractTimestamp(line);
        if (ts) {
          stream.destroy();
          return ts;
        }
        scanned++;
        if (scanned >= SCAN_LINE_CAP) {
          stream.destroy();
          return null;
        }
        nl = buffer.indexOf('\n');
      }
    }
    if (buffer.length > 0) return extractTimestamp(buffer);
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Bounded reverse scan: read the last `TAIL_READ_BYTES` of the file, walk
 * lines from end to start, return the first parsed `timestamp` found. Falls
 * back to expanding the window once to `TAIL_READ_BYTES_MAX`.
 */
async function readLastTimestamp(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat();
    const size = stats.size;
    if (size === 0) return null;

    for (const windowBytes of [TAIL_READ_BYTES, TAIL_READ_BYTES_MAX]) {
      const start = Math.max(0, size - windowBytes);
      const length = size - start;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, start);
      const text = buf.toString('utf-8');
      const lines = text.split('\n');
      // If we didn't read from byte 0, the first line may be partial — drop it.
      if (start > 0) lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        const ts = extractTimestamp(lines[i]);
        if (ts) return ts;
      }
      if (start === 0) break; // already read the whole file
    }
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

function extractTimestamp(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed[0] !== '{') return null;
  try {
    const parsed = JSON.parse(trimmed) as { timestamp?: unknown };
    if (typeof parsed.timestamp === 'string' && parsed.timestamp.length > 0) {
      return parsed.timestamp;
    }
  } catch {
    // Truncated or non-JSON; ignore.
  }
  return null;
}
