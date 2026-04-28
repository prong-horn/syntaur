import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  Clock3,
  LoaderCircle,
  SearchCheck,
  StopCircle,
} from 'lucide-react';
import { cn } from '../lib/utils';

const STATUS_PENDING_CLASS = 'border-status-pending-foreground/30 bg-status-pending text-status-pending-foreground';
const STATUS_IN_PROGRESS_CLASS = 'border-status-in-progress-foreground/30 bg-status-in-progress text-status-in-progress-foreground';
const STATUS_BLOCKED_CLASS = 'border-status-blocked-foreground/30 bg-status-blocked text-status-blocked-foreground';
const STATUS_REVIEW_CLASS = 'border-status-review-foreground/30 bg-status-review text-status-review-foreground';
const STATUS_COMPLETED_CLASS = 'border-status-completed-foreground/30 bg-status-completed text-status-completed-foreground';
const STATUS_FAILED_CLASS = 'border-status-failed-foreground/30 bg-status-failed text-status-failed-foreground';
const STATUS_ARCHIVED_CLASS = 'border-status-archived-foreground/30 bg-status-archived text-status-archived-foreground';

export const STATUS_META = {
  pending: {
    label: 'Pending',
    description: 'Waiting to start or waiting on dependencies.',
    className: STATUS_PENDING_CLASS,
    icon: Clock3,
  },
  in_progress: {
    label: 'In Progress',
    description: 'Actively being worked on.',
    className: STATUS_IN_PROGRESS_CLASS,
    icon: LoaderCircle,
  },
  blocked: {
    label: 'Blocked',
    description: 'Blocked by an explicit obstacle that needs intervention.',
    className: STATUS_BLOCKED_CLASS,
    icon: AlertCircle,
  },
  review: {
    label: 'Review',
    description: 'Ready for inspection or approval.',
    className: STATUS_REVIEW_CLASS,
    icon: SearchCheck,
  },
  completed: {
    label: 'Completed',
    description: 'Finished successfully.',
    className: STATUS_COMPLETED_CLASS,
    icon: CheckCircle2,
  },
  failed: {
    label: 'Failed',
    description: 'Could not be completed as planned.',
    className: STATUS_FAILED_CLASS,
    icon: AlertCircle,
  },
  active: {
    label: 'Active',
    description: 'The project has active or review work in flight.',
    className: STATUS_IN_PROGRESS_CLASS,
    icon: CircleDot,
  },
  stopped: {
    label: 'Stopped',
    description: 'Session ended without completing.',
    className: STATUS_PENDING_CLASS,
    icon: StopCircle,
  },
  archived: {
    label: 'Archived',
    description: 'Archived by a human override.',
    className: STATUS_ARCHIVED_CLASS,
    icon: CircleDot,
  },
} as const;

interface StatusBadgeProps {
  status: string;
  className?: string;
  showIcon?: boolean;
  progress?: { checked: number; total: number };
}

export function StatusBadge({
  status,
  className,
  showIcon = true,
  progress,
}: StatusBadgeProps) {
  const meta = STATUS_META[status as keyof typeof STATUS_META] ?? {
    label: status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    description: `Status: ${status}`,
    className: STATUS_PENDING_CLASS,
    icon: CircleDot,
  };
  const Icon = meta.icon;

  const hasProgress = progress && progress.total > 0;
  const pct = hasProgress ? Math.min(1, Math.max(0, progress.checked / progress.total)) : 0;
  const description = hasProgress
    ? `${meta.description} (${progress.checked}/${progress.total} criteria)`
    : meta.description;

  const iconNode = showIcon ? (
    hasProgress ? (
      <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center">
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="absolute inset-0 h-full w-full -rotate-90"
        >
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
          <circle
            cx="8"
            cy="8"
            r="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray={2 * Math.PI * 7}
            strokeDashoffset={2 * Math.PI * 7 * (1 - pct)}
          />
        </svg>
        <Icon className="h-2.5 w-2.5" />
      </span>
    ) : (
      <Icon className="h-3.5 w-3.5" />
    )
  ) : null;

  return (
    <span
      title={description}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold tracking-wide',
        meta.className,
        className,
      )}
    >
      {iconNode}
      <span>{meta.label}</span>
    </span>
  );
}

export function getStatusDescription(status: string): string {
  return (STATUS_META[status as keyof typeof STATUS_META])?.description ?? `Status: ${status}`;
}
