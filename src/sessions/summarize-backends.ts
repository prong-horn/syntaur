/**
 * Headless CLI backends for the session summarizer.
 *
 * Both backends shell out to an agent CLI the user already has logged in, which
 * avoids managing provider API keys for the default path. Two invariants apply
 * to EVERY backend here, and both are asserted in tests:
 *
 *   1. Session persistence off. Without it, each summarize call registers as a
 *      brand-new agent session and the summarizer pollutes the very table it
 *      exists to summarize.
 *   2. Tools off. The prompt embeds transcript text, which is untrusted input
 *      that can contain instructions; a tool-enabled agent reading it is a
 *      prompt-injection surface with real side effects. Summarizing is a pure
 *      text task, so everything — tools, extensions, skills, project MCP — is
 *      disabled.
 *
 * Spawn handling mirrors `runOnce` in `src/usage/ccusage-collector.ts`: byte
 * capped, SIGKILL on timeout, ENOENT distinguished from a non-zero exit.
 */

import { spawn } from 'node:child_process';
import type { SyntaurConfig, SummarizeBackendName } from '../utils/config.js';
import { extractFirstJsonObject, type BackendDeps, type SummarizeBackend } from './summarizer.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

/** GLM-5.2 as pi exposes it (`pi --list-models`: provider synthetic). */
export const PI_MODEL_ID = 'hf:zai-org/GLM-5.2';

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  enoent: boolean;
  timedOut: boolean;
  truncated: boolean;
  /** The prompt could not be fully written to the child's stdin (e.g. EPIPE). */
  stdinError: boolean;
  /** The run was cancelled via the caller's AbortSignal (e.g. shutdown). */
  aborted: boolean;
}

/**
 * Run `binary` with the prompt piped on stdin.
 *
 * stdin is used rather than argv because a transcript excerpt can exceed
 * platform argv limits. A stdin write error (EPIPE — the child exited or closed
 * its read end before draining the prompt) is captured, NOT swallowed: a
 * backend that never received the full transcript cannot have summarized it, so
 * callers must treat it as a failure. The error listener only prevents the
 * write error from crashing the process as an unhandled event; the outcome is
 * still surfaced via `stdinError`.
 */
export function runPrompt(
  binary: string,
  args: string[],
  opts: {
    stdin: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
  },
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  return new Promise((resolve) => {
    // Already aborted before we spawned — don't start a doomed child.
    if (opts.signal?.aborted) {
      resolve({ stdout: '', stderr: '', code: null, enoent: false, timedOut: false, truncated: false, stdinError: false, aborted: true });
      return;
    }

    const child = spawn(binary, args, {
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let stdinError = false;
    let aborted = false;
    let settled = false;

    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onChunk = (chunk: Buffer, sink: 'stdout' | 'stderr') => {
      if (truncated) return;
      const text = chunk.toString('utf-8');
      const current = sink === 'stdout' ? stdout : stderr;
      if (current.length + text.length > maxOutputBytes) {
        truncated = true;
        const slice = text.slice(0, maxOutputBytes - current.length);
        if (sink === 'stdout') stdout += slice;
        else stderr += slice;
        child.kill('SIGKILL');
        return;
      }
      if (sink === 'stdout') stdout += text;
      else stderr += text;
    };

    child.stdout.on('data', (c: Buffer) => onChunk(c, 'stdout'));
    child.stderr.on('data', (c: Buffer) => onChunk(c, 'stderr'));

    child.on('error', (err) => {
      const isEnoent = (err as NodeJS.ErrnoException).code === 'ENOENT';
      settle({ stdout, stderr, code: null, enoent: isEnoent, timedOut, truncated, stdinError, aborted });
    });
    child.on('close', (code) => {
      settle({ stdout, stderr, code, enoent: false, timedOut, truncated, stdinError, aborted });
    });

    // Capture (don't swallow) a stdin write failure: the child exited or closed
    // its read end before draining the prompt, so it never saw the full
    // transcript. `close`/`error` still settles with the flag set.
    child.stdin.on('error', () => {
      stdinError = true;
    });
    child.stdin.end(opts.stdin);
  });
}

/** True when the run did not complete cleanly and must be a backend error. */
function runFailed(result: RunResult): boolean {
  return (
    result.enoent ||
    result.timedOut ||
    result.truncated ||
    result.stdinError ||
    result.aborted ||
    result.code !== 0
  );
}

/** Turn a spawn outcome into the backend contract's error shape. */
function describeFailure(binary: string, result: RunResult): string {
  if (result.aborted) return `${binary} was aborted`;
  if (result.enoent) return `${binary} not found on PATH`;
  if (result.timedOut) return `${binary} timed out`;
  if (result.truncated) return `${binary} output exceeded the size cap`;
  if (result.stdinError) return `${binary} closed stdin before the prompt was delivered`;
  const detail = result.stderr.trim() || result.stdout.trim();
  return `${binary} exited ${result.code}${detail ? `: ${detail.slice(0, 500)}` : ''}`;
}

/**
 * Claude backend (default). `--output-format json` wraps the reply in a result
 * envelope; the inner payload is our summary contract, extracted by the core
 * parser.
 *
 * NOTE: we deliberately do NOT use `--json-schema`. That flag makes claude emit
 * its answer through an internal `StructuredOutput` TOOL call, which our tool
 * lockdown (`--disallowedTools '*'`) blocks — verified end-to-end, where it
 * produced a permission-denied loop. Tool safety wins over schema enforcement:
 * the prompt asks for a bare JSON object and the balanced-JSON parser in the
 * core handles fences and surrounding prose.
 */
export function createClaudeBackend(binary = 'claude'): SummarizeBackend {
  return async (prompt: string, deps?: BackendDeps) => {
    const args = [
      '-p',
      '--model',
      'sonnet',
      '--output-format',
      'json',
      // Invariant 1: never register as a tracked session.
      '--no-session-persistence',
      // Invariant 2: no tools, and no project-level settings/MCP that could
      // reintroduce them.
      '--disallowedTools',
      '*',
      '--setting-sources',
      '',
      '--strict-mcp-config',
    ];

    const result = await runPrompt(binary, args, {
      stdin: prompt,
      timeoutMs: deps?.timeoutMs,
      signal: deps?.signal,
    });
    if (runFailed(result)) {
      return { ok: false, error: describeFailure(binary, result) };
    }

    // Unwrap the envelope; tolerate log noise around it. If the shape is
    // unexpected, hand the raw stdout back — the core parser gets one more
    // chance to find the contract object inside it.
    const envelope = extractFirstJsonObject(result.stdout);
    if (envelope) {
      try {
        const parsed = JSON.parse(envelope) as { result?: unknown; is_error?: boolean };
        if (parsed.is_error === true) {
          return { ok: false, error: `claude reported an error: ${result.stdout.slice(0, 300)}` };
        }
        if (typeof parsed.result === 'string') return { ok: true, text: parsed.result };
      } catch {
        // fall through to raw stdout
      }
    }
    return { ok: true, text: result.stdout };
  };
}

/**
 * Resolve the Synthetic API key BEFORE spawning.
 *
 * pi's own lazy resolution is unreliable in non-interactive contexts, so the
 * key is materialized here and injected into the child env. Env var first, then
 * gcloud Secret Manager. Returns null when neither yields a key — the caller
 * fails fast rather than spawning a call that cannot authenticate.
 */
export async function resolveSyntheticApiKey(
  env: NodeJS.ProcessEnv = process.env,
  gcloudBinary = 'gcloud',
): Promise<string | null> {
  const fromEnv = env.SYNTHETIC_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const result = await runPrompt(
    gcloudBinary,
    ['secrets', 'versions', 'access', 'latest', '--secret=SYNTHETIC_API_KEY'],
    { stdin: '', timeoutMs: 30_000 },
  );
  if (result.enoent || result.timedOut || result.code !== 0) return null;
  const key = result.stdout.trim();
  return key.length > 0 ? key : null;
}

/**
 * Extract the assistant's final text from pi's `--mode json` output.
 *
 * pi emits a JSONL EVENT STREAM (session header, agent_start, message_start /
 * message_end per message, …) — NOT a single JSON object. The summary lives in
 * the LAST assistant `message_end` (or `message_start`) event's text content,
 * so returning the raw stream (whose first object is the session header) would
 * always fail the core parser. This walks the stream and returns the last
 * assistant text it finds.
 */
export function extractPiAssistantText(stdout: string): string | null {
  let latest: string | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    const e = event as { type?: unknown; message?: unknown };
    if (e.type !== 'message_end' && e.type !== 'message_start') continue;
    const msg = e.message as { role?: unknown; content?: unknown } | undefined;
    if (!msg || msg.role !== 'assistant') continue;

    const parts: string[] = [];
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
          parts.push((block as { text: string }).text);
        }
      }
    }
    const text = parts.join('').trim();
    if (text.length > 0) latest = text; // keep the LAST non-empty assistant turn
  }
  return latest;
}

/** Pi backend — GLM-5.2 via Synthetic. */
export function createPiBackend(
  binary = 'pi',
  opts: { env?: NodeJS.ProcessEnv; gcloudBinary?: string; model?: string } = {},
): SummarizeBackend {
  return async (prompt: string, deps?: BackendDeps) => {
    const baseEnv = opts.env ?? process.env;
    const apiKey = await resolveSyntheticApiKey(baseEnv, opts.gcloudBinary);
    if (!apiKey) {
      return {
        ok: false,
        error:
          'SYNTHETIC_API_KEY unavailable (not in env, and gcloud secret lookup failed) — cannot run the pi backend',
      };
    }

    const args = [
      '-p',
      '--model',
      opts.model ?? PI_MODEL_ID,
      // json mode gives a deterministic event stream we can parse for the final
      // assistant text (vs. text mode, which can interleave streaming artifacts).
      '--mode',
      'json',
      // Invariant 1: ephemeral, never written to pi's session store.
      '--no-session',
      // Invariant 2: no tools, extensions, or skills.
      '--no-tools',
      '--no-extensions',
      '--no-skills',
    ];

    const result = await runPrompt(binary, args, {
      stdin: prompt,
      env: { ...baseEnv, SYNTHETIC_API_KEY: apiKey },
      timeoutMs: deps?.timeoutMs,
      signal: deps?.signal,
    });
    if (runFailed(result)) {
      return { ok: false, error: describeFailure(binary, result) };
    }
    const text = extractPiAssistantText(result.stdout);
    if (text === null) {
      return {
        ok: false,
        error: `pi produced no assistant text (stream: ${result.stdout.slice(0, 300)})`,
      };
    }
    return { ok: true, text };
  };
}

/**
 * Single construction point for backends, shared by the CLI and the
 * autodiscovery sweep so both resolve identically.
 *
 * Precedence: explicit flag > configured default > 'claude'.
 */
export function resolveBackend(
  name: string | undefined,
  config: SyntaurConfig,
): { name: SummarizeBackendName; backend: SummarizeBackend } {
  const requested = (name ?? config.session.summarizeBackend ?? 'claude') as SummarizeBackendName;
  if (requested !== 'claude' && requested !== 'pi') {
    throw new Error(`Unknown summarize backend "${name}" (expected "claude" or "pi")`);
  }
  return requested === 'pi'
    ? { name: 'pi', backend: createPiBackend() }
    : { name: 'claude', backend: createClaudeBackend() };
}
