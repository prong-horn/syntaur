import { Coins, Info } from 'lucide-react';
import { buildUsageApiQuery, USAGE_WINDOWS, type UsageWidgetFilters, type UsageWindow } from '@shared/usage-filters';
import { useProjects, useUsageFacets } from '../../hooks/useProjects';
import { useResource } from '../../data/useResource';
import { workspaceUsage } from '../../data/sessionResources';
import { errorMessage } from '../../data/client';
import { ErrorState } from '../ErrorState';
import { LoadingState } from '../LoadingState';
import { formatCost, formatTokens } from '../../lib/format';
import type { UsageCostBasis, UsageSummaryRow } from '../../data/types';
import type { UsageGroupBy, UsageUrlState } from '../../lib/usageUrlState';

const WINDOW_LABEL: Record<UsageWindow, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  all: 'All time',
  custom: 'Custom',
};

const inputClass =
  'rounded-md border border-border/60 bg-background px-2 py-1 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30';

function costBasisLabel(basis: UsageCostBasis | undefined): string {
  if (basis === 'window-first') {
    return 'Costs use engagement-window pricing when available, otherwise the windowed daily sum (per-row source shown).';
  }
  return 'Costs sum usage_daily for the selected window — ticket board/header lifetime totals use engagement-window-first pricing and may differ.';
}

function rowCostHint(row: UsageSummaryRow, groupBy: UsageGroupBy): string | undefined {
  if (groupBy !== 'ticket' || !row.costSource) return undefined;
  if (row.costSource === 'engagement') {
    const partial =
      (row.uncomputableWindowCount ?? 0) > 0
      || (row.negativeDeltaCount ?? 0) > 0;
    return partial
      ? 'Engagement-window cost; some windows are unpriced or incomplete.'
      : 'Engagement-window cost for this ticket in the selected window.';
  }
  if (row.costSource === 'usage') return 'Windowed daily usage sum (no priced engagement windows in this window).';
  return 'No recorded cost in this window.';
}

export interface UsagePanelProps {
  state: UsageUrlState;
  onChange: (next: UsageUrlState) => void;
}

export function UsagePanel({ state, onChange }: UsagePanelProps) {
  const { filters, groupBy } = state;
  const window: UsageWindow = filters.window ?? '30d';
  const { data: projects } = useProjects();
  const { data: facets } = useUsageFacets();
  const { data, loading, error, refetch } = useResource(workspaceUsage(filters, groupBy));

  function updateFilters(next: UsageWidgetFilters, nextGroupBy: UsageGroupBy = groupBy) {
    onChange({ filters: next, groupBy: nextGroupBy });
  }

  const apiPreview = buildUsageApiQuery(filters).toString();

  return (
    <section className="mt-8 border-t border-border/40 pt-6" aria-labelledby="usage-panel-heading">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Coins className="h-5 w-5 text-primary" />
          <div>
            <h2 id="usage-panel-heading" className="text-lg font-semibold text-foreground">Token usage</h2>
            <p className="mt-0.5 text-xs text-muted-foreground" title={costBasisLabel(data?.costBasis)}>
              <Info className="mr-1 inline h-3 w-3" aria-hidden />
              {data?.costBasis === 'window-first'
                ? 'Window-first rollup (engagement windows when priced).'
                : 'Daily rollup for the selected window (may differ from ticket lifetime totals).'}
            </p>
          </div>
        </div>
        {apiPreview ? (
          <code className="hidden text-[10px] text-muted-foreground sm:block" aria-hidden>
            /api/usage?{apiPreview}&groupBy={groupBy}
          </code>
        ) : null}
      </header>

      <div className="mb-6 flex flex-wrap gap-4 items-end rounded-lg border border-border/60 bg-card p-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Window</span>
          <select
            value={window}
            onChange={(e) => updateFilters({ ...filters, window: e.target.value as UsageWindow })}
            className={inputClass}
          >
            {USAGE_WINDOWS.map((w) => (
              <option key={w} value={w}>{WINDOW_LABEL[w]}</option>
            ))}
          </select>
        </label>
        {window === 'custom' ? (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Since</span>
              <input
                type="date"
                value={filters.since ?? ''}
                onChange={(e) => updateFilters({ ...filters, window: 'custom', since: e.target.value || undefined })}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Until</span>
              <input
                type="date"
                value={filters.until ?? ''}
                onChange={(e) => updateFilters({ ...filters, window: 'custom', until: e.target.value || undefined })}
                className={inputClass}
              />
            </label>
          </>
        ) : null}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Project</span>
          <select
            value={filters.project ?? ''}
            onChange={(e) => updateFilters({ ...filters, project: e.target.value || undefined })}
            className={inputClass}
          >
            <option value="">All</option>
            {(projects ?? []).map((p) => (
              <option key={p.slug} value={p.slug}>{p.slug}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Model</span>
          <select
            value={filters.model ?? ''}
            onChange={(e) => updateFilters({ ...filters, model: e.target.value || undefined })}
            className={inputClass}
          >
            <option value="">All</option>
            {(facets?.models ?? []).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Tool</span>
          <select
            value={filters.tool ?? ''}
            onChange={(e) => updateFilters({ ...filters, tool: e.target.value || undefined })}
            className={inputClass}
          >
            <option value="">All</option>
            {(facets?.tools ?? []).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Group by</span>
          <select
            value={groupBy}
            onChange={(e) => updateFilters(filters, e.target.value as UsageGroupBy)}
            className={inputClass}
          >
            <option value="project">Project</option>
            <option value="ticket">Ticket</option>
          </select>
        </label>
      </div>

      {loading ? <LoadingState label="Loading usage…" /> : null}
      {error ? (
        <ErrorState
          error={errorMessage(error)}
          action={
            <button type="button" className="shell-action" onClick={() => void refetch()}>
              Retry
            </button>
          }
        />
      ) : null}

      {data && !loading && !error ? (
        <>
          <section className="mb-8">
            <h3 className="mb-2 text-base font-medium">Summary</h3>
            {data.summary.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No usage data for these filters. Run{' '}
                <code className="rounded bg-muted px-1 py-0.5 text-primary">syntaur usage</code> to ingest data.
              </p>
            ) : (
              <table className="w-full overflow-hidden rounded border border-border/60 text-sm">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Project</th>
                    {groupBy === 'ticket' ? <th className="px-3 py-2 text-left">Ticket</th> : null}
                    <th className="px-3 py-2 text-right">Tokens</th>
                    <th className="px-3 py-2 text-right">Cost</th>
                    <th className="px-3 py-2 text-left">Last event</th>
                  </tr>
                </thead>
                <tbody>
                  {data.summary.map((row, i) => {
                    const hint = rowCostHint(row, groupBy);
                    return (
                      <tr key={i} className="border-t border-border/60">
                        <td className="px-3 py-2">{row.projectSlug || '(unattributed)'}</td>
                        {groupBy === 'ticket' ? (
                          <td className="px-3 py-2">{row.ticketSlug || '(unattributed)'}</td>
                        ) : null}
                        <td className="px-3 py-2 text-right tabular-nums">{formatTokens(row.totalTokens)}</td>
                        <td className="px-3 py-2 text-right tabular-nums" title={hint}>
                          {formatCost(row.totalCost)}
                          {hint ? <span className="sr-only"> — {hint}</span> : null}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{row.lastEventDay}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-base font-medium">Daily breakdown</h3>
            {data.daily.length === 0 ? (
              <p className="text-sm text-muted-foreground">No daily rows.</p>
            ) : (
              <table className="w-full overflow-hidden rounded border border-border/60 text-sm">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Day</th>
                    <th className="px-3 py-2 text-left">Tool</th>
                    <th className="px-3 py-2 text-left">Model</th>
                    <th className="px-3 py-2 text-left">Project</th>
                    <th className="px-3 py-2 text-left">Ticket</th>
                    <th className="px-3 py-2 text-right">Tokens</th>
                    <th className="px-3 py-2 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.daily.map((row, i) => (
                    <tr key={i} className="border-t border-border/60">
                      <td className="px-3 py-2 tabular-nums">{row.day}</td>
                      <td className="px-3 py-2 text-muted-foreground">{row.tool}</td>
                      <td className="px-3 py-2 text-muted-foreground">{row.model}</td>
                      <td className="px-3 py-2">{row.project_slug || '–'}</td>
                      <td className="px-3 py-2">{row.ticket_id || '–'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatTokens(row.total_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCost(row.total_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      ) : null}
    </section>
  );
}
