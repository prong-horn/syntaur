/**
 * The resolved command + args shape returned by both fresh-launch and
 * resume-launch argv builders. When `resolveFromShellAliases: true` is set on
 * the agent, `command` is rewritten to the user's shell (or /bin/sh fallback)
 * and `args` becomes `['-i', '-c', '<quoted invocation>']` — so callers must
 * consume both fields, not just args.
 */
export interface ResolvedArgv {
  command: string;
  args: string[];
}

export interface BuiltArgv {
  argv: ResolvedArgv;
  shellFallbackWarning: string | null;
}
