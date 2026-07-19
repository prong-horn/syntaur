import { open } from 'node:fs/promises';

// Cap on lines we'll scan looking for `cwd`. The launch cwd is recorded in the
// first few entries of every Claude Code transcript; 50 lines is generous
// enough to absorb leading non-JSON noise (blank lines, permission-mode rows
// without a cwd) without slurping multi-MB transcripts into memory.
const MAX_LINES_SCANNED = 50;

/**
 * Read the first `cwd` field from a Claude Code transcript JSONL file.
 *
 * Claude Code derives `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
 * from the *launch* cwd of the session, and `claude --resume <id>` only finds
 * the transcript when invoked from a matching cwd. The transcript itself is
 * therefore the authoritative source of truth for "which directory does this
 * session belong to" — read it once, prefer it over whatever a registering
 * caller might have happened to be sitting in.
 *
 * Returns `null` when the path is empty, the file doesn't exist or can't be
 * read, no JSON line within the scan window contains a `cwd` field, or the
 * value is not a non-empty string. Never throws.
 */
export async function derivePathFromTranscript(
  transcriptPath: string | null | undefined,
): Promise<string | null> {
  if (!transcriptPath) return null;

  let handle;
  try {
    handle = await open(transcriptPath, 'r');
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

        const cwd = extractCwd(line);
        if (cwd) {
          stream.destroy();
          return cwd;
        }

        scanned++;
        if (scanned >= MAX_LINES_SCANNED) {
          stream.destroy();
          return null;
        }
        nl = buffer.indexOf('\n');
      }
    }

    // Trailing line without a newline (rare, but handle it).
    if (buffer.length > 0) {
      const cwd = extractCwd(buffer);
      if (cwd) return cwd;
    }
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Normalize a would-be session path, rejecting degenerate values.
 *
 * `"/"` is treated as unknown rather than as a real working directory: headless
 * ping-style sessions record `cwd:"/"` throughout their transcript, and storing
 * a literal `/` makes the dashboard claim a session ran at filesystem root. A
 * null path (rendered `—`) is honest about an unknown cwd; `/` is misleading.
 *
 * Pure and total — never throws.
 */
export function sanitizeSessionPath(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (trimmed.length === 0 || trimmed === '/') return null;
  return trimmed;
}

function extractCwd(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed[0] !== '{') return null;
  try {
    const parsed = JSON.parse(trimmed) as { cwd?: unknown };
    if (typeof parsed.cwd === 'string') {
      // Degenerate values return null so the caller's scan CONTINUES — a later
      // line carrying a real cwd can still win within the scan window.
      return sanitizeSessionPath(parsed.cwd);
    }
  } catch {
    // Non-JSON or truncated line — keep scanning.
  }
  return null;
}
