/**
 * Shared CLI error type + a thin wrapper so command actions print an actionable
 * remediation instead of a bare `Error: <msg>`.
 *
 * Modeled on `TerminalNotFoundError` (src/launch/execute.ts): the error carries
 * a `remediation` string that the wrapper surfaces as a `→ try: <…>` hint.
 */
export class SyntaurError extends Error {
  /** Actionable next step printed as `→ try: <remediation>` on stderr. */
  readonly remediation: string;
  /** Optional non-1 exit code (e.g. doctor's exit 2). Defaults to 1. */
  readonly code: number;

  constructor(
    message: string,
    options: { remediation: string; code?: number; cause?: unknown } = {
      remediation: '',
    },
  ) {
    super(message);
    this.name = 'SyntaurError';
    this.remediation = options.remediation;
    this.code = options.code ?? 1;
    if (options.cause !== undefined) {
      // Preserve the original error chain for debugging.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isSyntaurError(error: unknown): error is SyntaurError {
  return error instanceof SyntaurError;
}

/**
 * Format a caught error into the lines printed to stderr. Exposed for testing
 * without a process exit. Returns the `Error: <msg>` line and, when the error is
 * a `SyntaurError` carrying a remediation, a follow-up `→ try: <remediation>`.
 */
export function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [`Error: ${message}`];
  if (isSyntaurError(error) && error.remediation) {
    lines.push(`→ try: ${error.remediation}`);
  }
  return lines.join('\n');
}

/**
 * Resolve the process exit code for a caught error. `SyntaurError` may carry a
 * custom `code` (e.g. 2); everything else exits 1.
 */
export function exitCodeFor(error: unknown): number {
  if (isSyntaurError(error) && Number.isInteger(error.code) && error.code !== 0) {
    return error.code;
  }
  return 1;
}

/**
 * Wrap a command action so any thrown error is printed with an actionable hint
 * (when it is a `SyntaurError`) and the process exits non-zero, honoring a
 * `SyntaurError.code` if present. Replaces the copy-pasted
 * `} catch (error) { console.error('Error:', …); process.exit(1); }` blocks.
 *
 * Usage: `.action(runCommand(async (opts) => { … }))`.
 */
export function runCommand<Args extends unknown[]>(
  fn: (...args: Args) => unknown | Promise<unknown>,
): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      console.error(formatCliError(error));
      process.exit(exitCodeFor(error));
    }
  };
}
