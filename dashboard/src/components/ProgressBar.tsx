import type { ProgressCounts } from '../hooks/useMissions';
import { cn } from '../lib/utils';
import { toTitleCase } from '../lib/format';

const SEGMENTS: Array<{
  key: keyof Omit<ProgressCounts, 'total'>;
  className: string;
}> = [
  { key: 'completed', className: 'bg-emerald-500' },
  { key: 'in_progress', className: 'bg-sky-500' },
  { key: 'review', className: 'bg-violet-500' },
  { key: 'blocked', className: 'bg-amber-500' },
  { key: 'failed', className: 'bg-rose-500' },
  { key: 'pending', className: 'bg-slate-400' },
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
  const visibleSegments = SEGMENTS.filter((segment) => progress[segment.key] > 0);

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
              style={{ width: `${(progress[segment.key] / progress.total) * 100}%` }}
              title={`${toTitleCase(segment.key)}: ${progress[segment.key]}`}
            />
          ))
        )}
      </div>

      {showLegend ? (
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {SEGMENTS.map((segment) => (
            <span
              key={segment.key}
              className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/80 px-2 py-1"
            >
              <span className={cn('h-2 w-2 rounded-full', segment.className)} />
              <span>{toTitleCase(segment.key)}</span>
              <span className="font-medium text-foreground">{progress[segment.key]}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
