import { Link } from 'react-router-dom';
import { AlertTriangle, Flame, Hourglass, ShieldX } from 'lucide-react';
import { useAttention } from '../hooks/useMissions';
import { StatCard } from '../components/StatCard';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { SectionCard } from '../components/SectionCard';
import { StatusBadge } from '../components/StatusBadge';
import { formatDateTime } from '../lib/format';

export function AttentionPage() {
  const { data, loading, error } = useAttention();

  if (loading) {
    return <LoadingState label="Loading attention queue…" />;
  }

  if (error || !data) {
    return <ErrorState error={error || 'Attention queue is unavailable.'} />;
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Critical" value={data.summary.critical} icon={Flame} tone="danger" />
        <StatCard label="High" value={data.summary.high} icon={AlertTriangle} tone="warn" />
        <StatCard label="Medium" value={data.summary.medium} icon={ShieldX} tone="info" />
        <StatCard label="Low" value={data.summary.low} icon={Hourglass} />
      </div>

      <SectionCard title="Attention Queue" description="Ordered by severity, then by the latest parsed source update.">
        {data.items.length === 0 ? (
          <EmptyState
            title="Attention queue is clear"
            description="No blocked, failed, review, or stale assignments are currently surfacing from the source files."
          />
        ) : (
          <div className="space-y-3">
            {data.items.map((item) => (
              <Link
                key={item.id}
                to={item.href}
                className="block rounded-md border border-border/60 bg-background/80 p-3 transition hover:border-primary/40"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <h3 className="font-semibold text-foreground">{item.assignmentTitle}</h3>
                    <p className="text-sm text-muted-foreground">{item.missionTitle}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full border border-border/60 bg-card/90 px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                      {item.severity}
                    </span>
                    <StatusBadge status={item.status} />
                  </div>
                </div>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{item.reason}</p>
                <p className="mt-2 text-xs text-muted-foreground">Updated {formatDateTime(item.updated)}</p>
              </Link>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
