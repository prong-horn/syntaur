import { Coins } from 'lucide-react';
import { SectionCard } from './SectionCard';
import { EmptyState } from './EmptyState';
import { formatTokens, formatCost, formatDay } from '../lib/format';
import type { AssignmentUsageSummary } from '../hooks/useProjects';

interface AssignmentUsageSectionProps {
  summary: AssignmentUsageSummary | undefined;
  loading: boolean;
  error: string | null;
}

const TITLE = 'Cost / Usage';

/**
 * Per-assignment cost + token usage, rendered on the assignment detail pages.
 * Data is pulled live from the usage DB via the usage API — never persisted to
 * `assignment.md`.
 *
 * State handling mirrors `AgentSessionsSection`, with two refinements:
 *  - Because the usage endpoint always returns a `summary` object on success,
 *    an undefined `summary` reliably means "request hasn't completed". We
 *    therefore return `null` while `!summary` (covers both the spinner phase
 *    and the brief window after a slug-gated hook resolves but before its fetch
 *    fires) instead of consulting `loading` — which `useFetch` reports as
 *    `false` while the URL is null.
 *  - The empty state is keyed on the server's explicit no-rows sentinel
 *    (`lastEventDay === null`), NOT on `totalTokens === 0`: a recorded row can
 *    legitimately carry cost with zero tokens, and a real (even zero-valued)
 *    row should show "$0.00 / 0 tokens", not "No usage recorded yet".
 */
export function AssignmentUsageSection({ summary, error }: AssignmentUsageSectionProps) {
  // `loading` is intentionally not consulted: gating on it would flash the empty
  // state, since `useFetch` reports `loading === false` while its URL is null.
  if (error && !summary) {
    return (
      <SectionCard title={TITLE}>
        <EmptyState title="Couldn't load usage" description={error} />
      </SectionCard>
    );
  }

  if (!summary) return null;

  if (summary.lastEventDay === null) {
    return (
      <SectionCard title={TITLE}>
        <EmptyState
          title="No usage recorded yet"
          description="Cost and token totals appear here once the usage collector records activity for this assignment."
        />
      </SectionCard>
    );
  }

  return (
    <SectionCard title={TITLE}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Total cost" value={formatCost(summary.totalCost)} />
          <Stat label="Total tokens" value={formatTokens(summary.totalTokens)} />
        </div>

        {summary.byModel.length > 1 ? (
          <div className="space-y-1.5 border-t border-border pt-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              By model
            </p>
            <div className="space-y-1">
              {summary.byModel.map((m) => (
                <div key={m.model} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Coins className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-xs text-foreground" title={m.model}>
                      {m.model}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatTokens(m.totalTokens)} · {formatCost(m.totalCost)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* lastEventDay is non-null here (the null case returned above). */}
        <p className="text-xs text-muted-foreground">
          Last usage recorded {formatDay(summary.lastEventDay)}
        </p>
      </div>
    </SectionCard>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  );
}
