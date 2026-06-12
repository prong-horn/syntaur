import { Link } from 'react-router-dom';
import { useUsage, type WorkspaceUsageResponse } from '../../../hooks/useProjects';
import { formatTokens, formatCost } from '../../../lib/format';
import { filterSummaryLabel, serializeFilters, type UsageWidgetFilters } from '@shared/usage-filters';

interface UsageWidgetProps {
  filters?: UsageWidgetFilters;
  /** Which number to feature: 'tokens' (Token Usage widget) or 'cost' (Spend widget). */
  metric: 'tokens' | 'cost';
}

function sumTotals(data: WorkspaceUsageResponse): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  // `summary` is grouped per-project, so sum `daily` for the grand total.
  for (const r of data.daily) {
    tokens += r.total_tokens;
    cost += r.total_cost;
  }
  return { tokens, cost };
}

/**
 * Compact overview card surfacing token/cost totals for the data matching this
 * widget instance's filters. Two kinds share this component: `metric="tokens"`
 * (Token Usage) and `metric="cost"` (Spend). Filters are edited via the slot's
 * "Configure…" dialog; "View all →" deep-links to `/usage` with the same filters.
 */
export function UsageWidget({ filters, metric }: UsageWidgetProps) {
  const f = filters ?? {};
  const { data, loading, error } = useUsage(f);
  const title = metric === 'cost' ? 'Spend' : 'Token Usage';
  const viewAll = `/usage?${serializeFilters(f).toString()}`;

  let body: React.ReactNode;
  if (loading && !data) {
    body = <p className="text-sm text-muted-foreground">Loading…</p>;
  } else if (error && !data) {
    body = (
      <div className="text-sm">
        <p className="font-medium text-foreground">Couldn't load usage</p>
        <p className="mt-1 text-xs text-muted-foreground">{error}</p>
      </div>
    );
  } else if (!data || data.daily.length === 0) {
    // Empty ≡ no matching rows. (A matching row summing to $0 / 0 tokens is data, handled below.)
    body = <p className="text-sm text-muted-foreground">No usage for these filters.</p>;
  } else {
    const { tokens, cost } = sumTotals(data);
    const primary =
      metric === 'cost'
        ? { label: 'Total spend', value: formatCost(cost) }
        : { label: 'Total tokens', value: formatTokens(tokens) };
    const secondary =
      metric === 'cost'
        ? { label: 'Tokens', value: formatTokens(tokens) }
        : { label: 'Spend', value: formatCost(cost) };
    body = (
      <div className="grid grid-cols-2 gap-3">
        <Stat label={primary.label} value={primary.value} emphasize />
        <Stat label={secondary.label} value={secondary.value} />
      </div>
    );
  }

  return (
    <aside className="rounded-xl border border-border/60 bg-background/60 shadow-sm">
      <header className="flex items-center justify-between gap-2 border-b border-border/40 px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="truncate text-xs text-muted-foreground" title={filterSummaryLabel(f)}>
            {filterSummaryLabel(f)}
          </p>
        </div>
        <Link to={viewAll} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
          View all →
        </Link>
      </header>
      <div className="px-4 py-4">{body}</div>
    </aside>
  );
}

function Stat({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={
          emphasize
            ? 'text-2xl font-semibold tabular-nums text-foreground'
            : 'text-lg font-semibold tabular-nums text-foreground'
        }
      >
        {value}
      </p>
    </div>
  );
}
