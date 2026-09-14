import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  Clock3,
  Compass,
  LoaderCircle,
  Pencil,
  Play,
  SearchCheck,
  StopCircle,
  XCircle,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useStatusConfig } from '../hooks/useStatusConfig';
import {
  resolveStatusAppearance,
  STATUS_PENDING_CLASS,
  STATUS_IN_PROGRESS_CLASS,
  STATUS_BLOCKED_CLASS,
  STATUS_REVIEW_CLASS,
  STATUS_COMPLETED_CLASS,
  STATUS_FAILED_CLASS,
  STATUS_ARCHIVED_CLASS,
} from '../lib/statusMeta';

export const STATUS_META = {
  backlog: {
    label: 'Backlog',
    description: 'Not yet started.',
    className: STATUS_PENDING_CLASS,
    icon: Clock3,
  },
  planning: {
    label: 'Planning',
    description: 'Shaping or writing the plan.',
    className: STATUS_PENDING_CLASS,
    icon: Compass,
  },
  ready: {
    label: 'Ready',
    description: 'Plan approved; ready to implement.',
    className: STATUS_IN_PROGRESS_CLASS,
    icon: Play,
  },
  in_progress: {
    label: 'In Progress',
    description: 'Actively being worked on.',
    className: STATUS_IN_PROGRESS_CLASS,
    icon: LoaderCircle,
  },
  review: {
    label: 'Review',
    description: 'Ready for inspection or approval.',
    className: STATUS_REVIEW_CLASS,
    icon: SearchCheck,
  },
  done: {
    label: 'Done',
    description: 'Finished successfully.',
    className: STATUS_COMPLETED_CLASS,
    icon: CheckCircle2,
  },
  dropped: {
    label: 'Dropped',
    description: 'Will not be completed.',
    className: STATUS_FAILED_CLASS,
    icon: XCircle,
  },
  active: {
    label: 'Active',
    description: 'The project has active work in flight.',
    className: STATUS_IN_PROGRESS_CLASS,
    icon: CircleDot,
  },
  pending: {
    label: 'Pending',
    description: 'Waiting to start.',
    className: STATUS_PENDING_CLASS,
    icon: Clock3,
  },
  blocked: {
    label: 'Blocked',
    description: 'Blocked by an explicit obstacle.',
    className: STATUS_BLOCKED_CLASS,
    icon: AlertCircle,
  },
  completed: {
    label: 'Completed',
    description: 'All work finished.',
    className: STATUS_COMPLETED_CLASS,
    icon: CheckCircle2,
  },
  failed: {
    label: 'Failed',
    description: 'Could not be completed as planned.',
    className: STATUS_FAILED_CLASS,
    icon: AlertCircle,
  },
  archived: {
    label: 'Archived',
    description: 'Hidden from normal views.',
    className: STATUS_ARCHIVED_CLASS,
    icon: StopCircle,
  },
  draft: {
    label: 'Draft',
    description: 'Legacy draft status.',
    className: STATUS_PENDING_CLASS,
    icon: Pencil,
  },
} as const;

interface StatusBadgeProps {
  status: string;
  className?: string;
  showIcon?: boolean;
  progress?: { checked: number; total: number };
}

export interface StatusMeta {
  label: string;
  description: string;
  className: string;
  icon: typeof CircleDot;
}

export function getStatusMeta(status: string): StatusMeta {
  const known = STATUS_META[status as keyof typeof STATUS_META];
  if (known) return known;
  return {
    className: STATUS_PENDING_CLASS,
    icon: CircleDot,
    label: status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    description: `Status: ${status}`,
  };
}

export const STATUS_PILL_BASE =
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium tracking-normal shadow-[inset_0_0_0_1px_oklch(100%_0_0_/_0)] dark:shadow-[inset_0_0_0_1px_oklch(100%_0_0_/_0.04)]';

export function getStatusPillClassName(status: string, extra?: string): string {
  return cn(STATUS_PILL_BASE, getStatusMeta(status).className, extra);
}

export function getStatusIcon(status: string): typeof CircleDot {
  return STATUS_META[status as keyof typeof STATUS_META]?.icon ?? CircleDot;
}

export function StatusProgressRing({
  progress,
  Icon,
}: {
  progress?: { checked: number; total: number };
  Icon: typeof CircleDot;
}) {
  const hasProgress = progress && progress.total > 0;
  const pct = hasProgress ? Math.min(1, Math.max(0, progress.checked / progress.total)) : 0;

  if (hasProgress) {
    return (
      <span className="relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
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
    );
  }

  return <Icon className="h-3.5 w-3.5 shrink-0" />;
}

export function StatusBadge({
  status,
  className,
  showIcon = true,
  progress,
}: StatusBadgeProps) {
  const config = useStatusConfig();
  const appearance = resolveStatusAppearance(config.statuses, status);
  const Icon = getStatusIcon(status);
  const label = appearance.label;
  const baseDescription = getStatusMeta(status).description;

  const hasProgress = progress && progress.total > 0;
  const description = hasProgress
    ? `${label} — ${baseDescription} (${progress.checked}/${progress.total} criteria)`
    : `${label} — ${baseDescription}`;

  const iconNode = showIcon ? (
    <StatusProgressRing progress={progress} Icon={Icon} />
  ) : null;

  return (
    <span
      title={description}
      className={cn(STATUS_PILL_BASE, appearance.className, className)}
      style={appearance.style}
    >
      {iconNode}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

export function getStatusDescription(status: string): string {
  return getStatusMeta(status).description;
}
