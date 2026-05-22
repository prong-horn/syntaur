import { useEffect, useState } from 'react';
import { Coins } from 'lucide-react';

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

function thirtyDaysAgo(): string {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

export function UsagePage() {
  const [since, setSince] = useState<string>(thirtyDaysAgo());
  const [until, setUntil] = useState<string>(today());
  const [project, setProject] = useState<string>('');
  const [groupBy, setGroupBy] = useState<'project' | 'assignment'>('project');
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // List of project slugs available in the current window (derived from
  // whichever response came back without a project filter applied).
  const [knownProjects, setKnownProjects] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ since, until, groupBy });
    if (project) params.set('project', project);
    fetch(`/api/usage?${params.toString()}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<UsageResponse>;
      })
      .then((body) => {
        setData(body);
        // Refresh the project dropdown options only when no filter is set
        // (otherwise the dropdown would shrink to the filtered selection).
        if (!project) {
          const projects = new Set<string>();
          for (const r of body.daily) {
            if (r.project_slug) projects.add(r.project_slug);
          }
          setKnownProjects([...projects].sort());
        }
        setLoading(false);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [since, until, project, groupBy]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <header className="flex items-center gap-3 mb-6">
        <Coins className="w-6 h-6 text-amber-400" />
        <h1 className="text-2xl font-semibold">Token usage</h1>
      </header>

      <div className="flex flex-wrap gap-4 items-end mb-6 p-4 rounded-lg bg-zinc-900/50 border border-zinc-800">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">Since</span>
          <input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">Until</span>
          <input
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">Project</span>
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          >
            <option value="">All</option>
            {knownProjects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">Group by</span>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as 'project' | 'assignment')}
            className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          >
            <option value="project">Project</option>
            <option value="assignment">Assignment</option>
          </select>
        </label>
      </div>

      {loading && <p className="text-zinc-400">Loading…</p>}
      {error && <p className="text-red-400">Error: {error}</p>}

      {data && !loading && !error && (
        <>
          <section className="mb-8">
            <h2 className="text-lg font-medium mb-2">Summary</h2>
            {data.summary.length === 0 ? (
              <p className="text-zinc-500 text-sm">
                No usage data in this window. Run{' '}
                <code className="bg-zinc-800 px-1 py-0.5 rounded text-amber-300">
                  syntaur usage
                </code>{' '}
                to ingest the latest ccusage data.
              </p>
            ) : (
              <table className="w-full text-sm border border-zinc-800 rounded overflow-hidden">
                <thead className="bg-zinc-900 text-zinc-400">
                  <tr>
                    <th className="text-left px-3 py-2">Project</th>
                    {groupBy === 'assignment' && (
                      <th className="text-left px-3 py-2">Assignment</th>
                    )}
                    <th className="text-right px-3 py-2">Tokens</th>
                    <th className="text-right px-3 py-2">Cost</th>
                    <th className="text-left px-3 py-2">Last event</th>
                  </tr>
                </thead>
                <tbody>
                  {data.summary.map((r, i) => (
                    <tr key={i} className="border-t border-zinc-800">
                      <td className="px-3 py-2">{r.projectSlug || '(unattributed)'}</td>
                      {groupBy === 'assignment' && (
                        <td className="px-3 py-2">
                          {r.assignmentSlug || '(unattributed)'}
                        </td>
                      )}
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatTokens(r.totalTokens)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCost(r.totalCost)}
                      </td>
                      <td className="px-3 py-2 text-zinc-400">{r.lastEventDay}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h2 className="text-lg font-medium mb-2">Daily breakdown</h2>
            {data.daily.length === 0 ? (
              <p className="text-zinc-500 text-sm">No daily rows.</p>
            ) : (
              <table className="w-full text-sm border border-zinc-800 rounded overflow-hidden">
                <thead className="bg-zinc-900 text-zinc-400">
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
                    <tr key={i} className="border-t border-zinc-800">
                      <td className="px-3 py-2 tabular-nums">{r.day}</td>
                      <td className="px-3 py-2 text-zinc-400">{r.tool}</td>
                      <td className="px-3 py-2 text-zinc-400">{r.model}</td>
                      <td className="px-3 py-2">{r.project_slug || '–'}</td>
                      <td className="px-3 py-2">{r.assignment_slug || '–'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatTokens(r.total_tokens)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCost(r.total_cost)}
                      </td>
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
