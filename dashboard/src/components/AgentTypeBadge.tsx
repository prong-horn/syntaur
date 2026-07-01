import { resolveRunner, type AgentConfig, type RunnerKind } from '@shared/agents-schema';
import { cn } from '../lib/utils';

// Theme-safe chrome (semantic tokens) + a per-runner accent dot (inline color so
// it reads in any theme).
const RUNNER_DOT: Record<RunnerKind, string> = {
  claude: '#8b5cf6',
  pi: '#14b8a6',
  codex: '#f59e0b',
};

/**
 * The intrinsic runner "type badge" (claude / pi / codex) shown on every agent in
 * the unified list. Pass a resolved `runner`, or an `agent` to resolve from.
 */
export function AgentTypeBadge({
  agent,
  runner,
  className,
}: {
  agent?: AgentConfig;
  runner?: RunnerKind;
  className?: string;
}) {
  const r: RunnerKind = runner ?? (agent ? resolveRunner(agent) : 'pi');
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border border-border/60 bg-foreground/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground',
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: RUNNER_DOT[r] }} />
      {r}
    </span>
  );
}
