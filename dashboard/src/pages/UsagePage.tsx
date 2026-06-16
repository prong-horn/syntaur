import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Coins } from 'lucide-react';
import { formatTokens, formatCost } from '../lib/format';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import {
  USAGE_WINDOWS,
  buildUsageApiQuery,
  parseFilters,
  serializeFilters,
  type UsageWidgetFilters,
  type UsageWindow,
} from '@shared/usage-filters';
import { useProjects, useWorkspaces, useUsageFacets } from '../hooks/useProjects';

interface UsageDailyRow {
  day: string;
  tool: string;
  model: string;
  project_slug: string;
  assignment_slug: string;
  total_tokens: number;
  total_cost: number;
}

interface UsageSummaryRow {
  projectSlug: string;
  assignmentSlug: string;
  totalTokens: number;
  totalCost: number;
  lastEventDay: string;
}

interface UsageResponse {
  daily: UsageDailyRow[];
  summary: UsageSummaryRow[];
}

type GroupBy = 'project' | 'assignment';

const WINDOW_LABEL: Record<UsageWindow, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  all: 'All time',
  custom: 'Custom',
};

const inputClass =
  'rounded-md border border-border/60 bg-background px-2 py-1 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30';

/**
 * Usage report page. The URL query string is the source of truth: filters are
 * parsed from it on every render (so back/forward navigates filter history) and
 * control edits push a new query via setSearchParams. The shared usage-filters
 * helpers are the same ones the overview widgets use, so a widget's
 * "View all →" link reproduces identical filters and totals here.
 */
export function UsagePage() {
  const [sp, setSp] = useSearchParams();
  const filters = parseFilters(sp);
  const window: UsageWindow = filters.window ?? '30d';
  const groupBy: GroupBy = sp.get('groupBy') === 'assignment' ? 'assignment' : 'project';

  const { data: projects } = useProjects();
  const { data: workspacesData } = useWorkspaces();
  const { data: facets } = useUsageFacets();

  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the error-state Retry button to re-run the fetch effect.
  const [reloadKey, setReloadKey] = useState(0);

  // Seed the URL with the default window once, so the address bar always
  // reflects the active filters (and back/forward has a baseline entry).
  useEffect(() => {
    if (!sp.get('window')) {
      const next = serializeFilters({ window: '30d', ...filters });
      if (groupBy === 'assignment') next.set('groupBy', 'assignment');
      setSp(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apiQuery = buildUsageApiQuery({ window, ...filters }).toString();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const url = apiQuery ? `/api/usage?${apiQuery}&groupBy=${groupBy}` : `/api/usage?groupBy=${groupBy}`;
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<UsageResponse>;
      })
      .then((body) => {
        setData(body);
        setLoading(false);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, [apiQuery, groupBy, reloadKey]);

  /** Push a new filter set (and groupBy) into the URL. */
  function update(next: UsageWidgetFilters, nextGroupBy: GroupBy = groupBy) {
    const params = serializeFilters(next);
    if (nextGroupBy === 'assignment') params.set('groupBy', 'assignment');
    setSp(params);
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <header className="flex items-center gap-3 mb-6">
        <Coins className="w-6 h-6 text-primary" />
        <h1 className="text-2xl font-semibold text-foreground">Token usage</h1>
      </header>

      <div className="flex flex-wrap gap-4 items-end mb-6 p-4 rounded-lg bg-card border border-border/60">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Window</span>
          <select
            value={window}
            onChange={(e) => update({ ...filters, window: e.target.value as UsageWindow })}
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
                onChange={(e) => update({ ...filters, window: 'custom', since: e.target.value || undefined })}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Until</span>
              <input
                type="date"
                value={filters.until ?? ''}
                onChange={(e) => update({ ...filters, window: 'custom', until: e.target.value || undefined })}
                className={inputClass}
              />
            </label>
          </>
        ) : null}

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Workspace</span>
          <select
            value={filters.workspace ?? ''}
            onChange={(e) =>
              update({ ...filters, workspace: e.target.value || undefined, project: undefined })
            }
            className={inputClass}
          >
            <option value="">All</option>
            {workspacesData?.hasUngrouped ? <option value="_ungrouped">(ungrouped)</option> : null}
            {(workspacesData?.workspaces ?? []).map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Project</span>
          <select
            value={filters.project ?? ''}
            onChange={(e) =>
              update({ ...filters, project: e.target.value || undefined, workspace: undefined })
            }
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
            onChange={(e) => update({ ...filters, model: e.target.value || undefined })}
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
            onChange={(e) => update({ ...filters, tool: e.target.value || undefined })}
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
            onChange={(e) => update(filters, e.target.value as GroupBy)}
            className={inputClass}
          >
            <option value="project">Project</option>
            <option value="assignment">Assignment</option>
          </select>
        </label>
      </div>

      {loading && <LoadingState label="Loading usage…" />}
      {error && (
        <ErrorState
          error={error}
          action={
            <button type="button" className="shell-action" onClick={() => setReloadKey((k) => k + 1)}>
              Retry
            </button>
          }
        />
      )}

      {data && !loading && !error && (
        <>
          <section className="mb-8">
            <h2 className="text-lg font-medium mb-2">Summary</h2>
            {data.summary.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No usage data for these filters. Run{' '}
                <code className="bg-muted px-1 py-0.5 rounded text-primary">syntaur usage</code>{' '}
                to ingest the latest ccusage data.
              </p>
            ) : (
              <table className="w-full text-sm border border-border/60 rounded overflow-hidden">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2">Project</th>
                    {groupBy === 'assignment' && <th className="text-left px-3 py-2">Assignment</th>}
                    <th className="text-right px-3 py-2">Tokens</th>
                    <th className="text-right px-3 py-2">Cost</th>
                    <th className="text-left px-3 py-2">Last event</th>
                  </tr>
                </thead>
                <tbody>
                  {data.summary.map((r, i) => (
                    <tr key={i} className="border-t border-border/60">
                      <td className="px-3 py-2">{r.projectSlug || '(unattributed)'}</td>
                      {groupBy === 'assignment' && (
                        <td className="px-3 py-2">{r.assignmentSlug || '(unattributed)'}</td>
                      )}
                      <td className="px-3 py-2 text-right tabular-nums">{formatTokens(r.totalTokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCost(r.totalCost)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{r.lastEventDay}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h2 className="text-lg font-medium mb-2">Daily breakdown</h2>
            {data.daily.length === 0 ? (
              <p className="text-muted-foreground text-sm">No daily rows.</p>
            ) : (
              <table className="w-full text-sm border border-border/60 rounded overflow-hidden">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2">Day</th>
                    <th className="text-left px-3 py-2">Tool</th>
                    <th className="text-left px-3 py-2">Model</th>
                    <th className="text-left px-3 py-2">Project</th>
                    <th className="text-left px-3 py-2">Assignment</th>
                    <th className="text-right px-3 py-2">Tokens</th>
                    <th className="text-right px-3 py-2">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.daily.map((r, i) => (
                    <tr key={i} className="border-t border-border/60">
                      <td className="px-3 py-2 tabular-nums">{r.day}</td>
                      <td className="px-3 py-2 text-muted-foreground">{r.tool}</td>
                      <td className="px-3 py-2 text-muted-foreground">{r.model}</td>
                      <td className="px-3 py-2">{r.project_slug || '–'}</td>
                      <td className="px-3 py-2">{r.assignment_slug || '–'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatTokens(r.total_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCost(r.total_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
