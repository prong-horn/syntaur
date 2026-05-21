/**
 * ccusage shell-out collector.
 *
 * Pure parser; does NOT touch the DB. Spawns `ccusage session --json
 * --breakdown` (with an optional `--since YYYYMMDD` filter) and returns
 * parsed rows in memory. The CLI in `src/commands/usage.ts` is the only
 * place that persists anything (events + `usage_last_collector_run`),
 * inside a single transaction.
 *
 * On `ENOENT` (ccusage not on `$PATH`) returns `null` after logging a
 * one-line install hint. Same on non-zero exit. Never throws.
 */

import { spawn } from 'node:child_process';
import { parseCcusageSession, type ParsedCcusageRow } from './ccusage-parse.js';

export interface CcusageCollectResult {
  rows: ParsedCcusageRow[];
  highWaterMark: string | null;
  ccusageVersion: string;
  warnings: string[];
}

export interface RunCcusageOpts {
  /** ccusage's accepted `--since` format is YYYYMMDD (date-only). */
  sinceDate?: string;
  /** Path to the ccusage binary (defaults to `ccusage` resolved on `$PATH`). */
  binary?: string;
  /** Optional env override for child process (used in tests). */
  env?: NodeJS.ProcessEnv;
  /** Optional logger sink (defaults to console.warn). */
  logger?: (msg: string) => void;
  /** Hard cap on child process duration (ms). Default 60s. */
  timeoutMs?: number;
  /** Hard cap on stdout+stderr bytes captured. Default 16 MiB. */
  maxOutputBytes?: number;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  enoent: boolean;
  timedOut: boolean;
  truncated: boolean;
}

const ENOENT_HINT =
  "ccusage not on PATH — install with 'npm i -g ccusage' or 'bunx ccusage' to enable token usage tracking";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

let enoentWarned = false;

/**
 * Run `ccusage session --json --breakdown` (with optional `--since`) and
 * return parsed rows. Returns `null` when ccusage can't be spawned or exits
 * non-zero.
 */
export async function runCcusage(
  opts: RunCcusageOpts = {},
): Promise<CcusageCollectResult | null> {
  const binary = opts.binary ?? 'ccusage';
  const logger = opts.logger ?? ((m: string) => console.warn(m));

  const args = ['session', '--json', '--breakdown'];
  if (opts.sinceDate) args.push('--since', opts.sinceDate);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const sessionResult = await runOnce(binary, args, opts.env, timeoutMs, maxOutputBytes);
  if (sessionResult.enoent) {
    if (!enoentWarned) {
      logger(ENOENT_HINT);
      enoentWarned = true;
    }
    return null;
  }
  if (sessionResult.timedOut) {
    logger(`ccusage session timed out after ${timeoutMs}ms`);
    return null;
  }
  if (sessionResult.code !== 0) {
    const truncated = sessionResult.stderr.slice(0, 1024);
    logger(`ccusage session exited ${sessionResult.code}: ${truncated}`);
    return null;
  }
  if (sessionResult.truncated) {
    logger(`ccusage stdout exceeded ${maxOutputBytes} bytes and was truncated; output likely invalid`);
    return null;
  }

  // Best-effort version capture; not fatal if it fails.
  let ccusageVersion = 'unknown';
  try {
    const ver = await runOnce(binary, ['--version'], opts.env, 5_000, 1024);
    if (!ver.enoent && !ver.timedOut && ver.code === 0) {
      ccusageVersion = ver.stdout.trim();
    }
  } catch {
    // ignore
  }

  let payload: unknown;
  try {
    payload = JSON.parse(sessionResult.stdout);
  } catch (err) {
    logger(
      `ccusage stdout was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const { rows, highWaterMark, warnings } = parseCcusageSession(payload);
  for (const w of warnings) logger(`ccusage parse warning: ${w}`);

  return {
    rows,
    highWaterMark,
    ccusageVersion,
    warnings,
  };
}

function runOnce(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const settle = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onChunk = (chunk: Buffer, sink: 'stdout' | 'stderr') => {
      if (truncated) return;
      const text = chunk.toString('utf-8');
      if (sink === 'stdout') {
        if (stdout.length + text.length > maxOutputBytes) {
          truncated = true;
          stdout += text.slice(0, maxOutputBytes - stdout.length);
          child.kill('SIGKILL');
        } else {
          stdout += text;
        }
      } else {
        if (stderr.length + text.length > maxOutputBytes) {
          truncated = true;
          stderr += text.slice(0, maxOutputBytes - stderr.length);
          child.kill('SIGKILL');
        } else {
          stderr += text;
        }
      }
    };

    child.stdout.on('data', (c: Buffer) => onChunk(c, 'stdout'));
    child.stderr.on('data', (c: Buffer) => onChunk(c, 'stderr'));

    child.on('error', (err) => {
      const isEnoent = (err as NodeJS.ErrnoException).code === 'ENOENT';
      settle({ stdout, stderr, code: null, enoent: isEnoent, timedOut, truncated });
    });

    child.on('close', (code) => {
      settle({ stdout, stderr, code, enoent: false, timedOut, truncated });
    });
  });
}

/** Convert an ISO timestamp to ccusage's `--since` format (`YYYYMMDD`). */
export function isoToCcusageDate(iso: string): string {
  // Strip the time portion, then drop the hyphens.
  return iso.slice(0, 10).replace(/-/g, '');
}

/** Test helper — reset the once-per-process ENOENT warning latch. */
export function _resetEnoentWarnedForTests(): void {
  enoentWarned = false;
}
