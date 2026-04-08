import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowUpRight, CheckCircle2, ChevronDown } from 'lucide-react';
import { StatusBadge } from './StatusBadge';
import { SectionCard } from './SectionCard';

interface DependencyInfo {
  slug: string;
  title: string;
  status: string;
  priority: string;
  assignee: string | null;
}

interface DependencyPanelProps {
  missionSlug: string;
  dependencies: DependencyInfo[];
  blockedReason: string | null;
}

export function DependencyPanel({ missionSlug, dependencies, blockedReason }: DependencyPanelProps) {
  const [expanded, setExpanded] = useState(false);

  if (dependencies.length === 0) return null;

  const unmetDeps = dependencies.filter(
    (d) => d.status !== 'completed' && d.status !== 'review',
  );
  const allResolved = unmetDeps.length === 0;

  if (allResolved && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/50 px-4 py-2.5 text-left transition hover:bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/20 dark:hover:bg-emerald-950/30"
      >
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
          All {dependencies.length} {dependencies.length === 1 ? 'dependency' : 'dependencies'} resolved
        </span>
        <ChevronDown className="ml-auto h-4 w-4 text-emerald-600 dark:text-emerald-400" />
      </button>
    );
  }

  return (
    <div className="space-y-3">
      {unmetDeps.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950/30">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="text-sm text-amber-800 dark:text-amber-300">
            <strong>
              {unmetDeps.length} {unmetDeps.length === 1 ? 'dependency is' : 'dependencies are'} not yet completed.
            </strong>
            {blockedReason && (
              <p className="mt-1 text-amber-700 dark:text-amber-400">
                Blocked reason: {blockedReason}
              </p>
            )}
          </div>
        </div>
      )}

      <SectionCard
        title="Dependencies"
        description={`${dependencies.length - unmetDeps.length} of ${dependencies.length} resolved`}
        actions={
          allResolved ? (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Collapse
            </button>
          ) : undefined
        }
      >
        <div className="divide-y divide-border/40">
          {dependencies.map((dep) => (
            <Link
              key={dep.slug}
              to={`/missions/${missionSlug}/assignments/${dep.slug}`}
              className="flex items-center gap-3 px-1 py-2.5 transition hover:bg-muted/40 first:pt-0 last:pb-0"
            >
              <StatusBadge status={dep.status} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {dep.title}
                </p>
                <p className="truncate text-xs text-muted-foreground">{dep.slug}</p>
              </div>
              {dep.assignee && (
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {dep.assignee}
                </span>
              )}
              <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
