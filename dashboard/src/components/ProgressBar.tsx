import { useMemo } from 'react';
import type { ProgressCounts } from '../hooks/useProjects';
import { cn } from '../lib/utils';
import { toTitleCase } from '../lib/format';
import { useStatusConfig } from '../hooks/useStatusConfig';

const DEFAULT_SEGMENT_COLORS: Record<string, string> = {
  completed: 'bg-status-completed-foreground',
  in_progress: 'bg-status-in-progress-foreground',
  review: 'bg-status-review-foreground',
  blocked: 'bg-status-blocked-foreground',
  failed: 'bg-status-failed-foreground',
  pending: 'bg-status-pending-foreground',
};

const FALLBACK_COLORS = [
  'bg-primary',
  'bg-secondary',
  'bg-accent-coral',
  'bg-accent-teal',
  'bg-accent-amber',
];

interface ProgressBarProps {
  progress: ProgressCounts;
  className?: string;
  showLegend?: boolean;
}

export function ProgressBar({
  progress,
  className,
  showLegend = false,
}: ProgressBarProps) {
  const config = useStatusConfig();

  const segments = useMemo(() => {
    let fallbackIdx = 0;
    // Use config order to determine segment ordering
    const keys = config.order.length > 0
      ? config.order
      : Object.keys(progress).filter((k) => k !== 'total');

    return keys.map((key) => ({
      key,
      className: DEFAULT_SEGMENT_COLORS[key] ?? FALLBACK_COLORS[fallbackIdx++ % FALLBACK_COLORS.length],
    }));
  }, [config.order, progress]);

  const visibleSegments = segments.filter((segment) => (progress[segment.key] ?? 0) > 0);

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex h-1.5 w-full overflow-hidden rounded-lg border border-border/70 bg-muted/60">
        {progress.total === 0 ? (
          <div className="h-full w-full bg-muted" />
        ) : (
          visibleSegments.map((segment) => (
            <div
              key={segment.key}
              className={segment.className}
              style={{ width: `${((progress[segment.key] ?? 0) / progress.total) * 100}%` }}
              title={`${toTitleCase(segment.key)}: ${progress[segment.key] ?? 0}`}
            />
          ))
        )}
      </div>

      {showLegend ? (
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {segments.map((segment) => (
            <span
              key={segment.key}
              className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/80 px-2 py-1"
            >
              <span className={cn('h-2 w-2 rounded-full', segment.className)} />
              <span>{toTitleCase(segment.key)}</span>
              <span className="font-medium text-foreground">{progress[segment.key] ?? 0}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
