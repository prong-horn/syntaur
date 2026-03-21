import { cn } from '../lib/utils';
import type { ProgressCounts } from '../hooks/useMissions';

const SEGMENT_COLORS: Record<string, string> = {
  completed: 'bg-green-500',
  in_progress: 'bg-blue-500',
  review: 'bg-amber-500',
  blocked: 'bg-red-500',
  failed: 'bg-red-600',
  pending: 'bg-gray-500',
};

const SEGMENT_ORDER: Array<keyof Omit<ProgressCounts, 'total'>> = [
  'completed',
  'in_progress',
  'review',
  'blocked',
  'failed',
  'pending',
];

interface ProgressBarProps {
  progress: ProgressCounts;
  className?: string;
}

export function ProgressBar({ progress, className }: ProgressBarProps) {
  if (progress.total === 0) {
    return (
      <div className={cn('h-2 w-full rounded-full bg-muted', className)} />
    );
  }

  return (
    <div className={cn('flex h-2 w-full overflow-hidden rounded-full bg-muted', className)}>
      {SEGMENT_ORDER.map((key) => {
        const count = progress[key];
        if (count === 0) return null;
        const widthPercent = (count / progress.total) * 100;
        return (
          <div
            key={key}
            className={cn(SEGMENT_COLORS[key])}
            style={{ width: `${widthPercent}%` }}
            title={`${key}: ${count}`}
          />
        );
      })}
    </div>
  );
}
