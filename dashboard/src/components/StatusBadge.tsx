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

export const STATUS_META = {
  pending: {
    label: 'Pending',
    description: 'Waiting to start or waiting on dependencies.',
    className: 'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300',
    icon: Clock3,
  },
  in_progress: {
    label: 'In Progress',
    description: 'Actively being worked on.',
    className: 'border-teal-300 bg-teal-100 text-teal-700 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-300',
    icon: LoaderCircle,
  },
  blocked: {
    label: 'Blocked',
    description: 'Blocked by an explicit obstacle that needs intervention.',
    className: 'border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300',
    icon: AlertCircle,
  },
  review: {
    label: 'Review',
    description: 'Ready for inspection or approval.',
    className: 'border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300',
    icon: SearchCheck,
  },
  completed: {
    label: 'Completed',
    description: 'Finished successfully.',
    className: 'border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    icon: CheckCircle2,
  },
  failed: {
    label: 'Failed',
    description: 'Could not be completed as planned.',
    className: 'border-rose-300 bg-rose-100 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300',
    icon: AlertCircle,
  },
  active: {
    label: 'Active',
    description: 'The mission has active or review work in flight.',
    className: 'border-teal-300 bg-teal-100 text-teal-700 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-300',
    icon: CircleDot,
  },
  stopped: {
    label: 'Stopped',
    description: 'Session ended without completing.',
    className: 'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300',
    icon: StopCircle,
  },
  archived: {
    label: 'Archived',
    description: 'Archived by a human override.',
    className: 'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300',
    icon: CircleDot,
  },
} as const;

interface StatusBadgeProps {
  status: string;
  className?: string;
  showIcon?: boolean;
}

export function StatusBadge({
  status,
  className,
  showIcon = true,
}: StatusBadgeProps) {
  const meta = STATUS_META[status as keyof typeof STATUS_META] ?? {
    label: status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    description: `Status: ${status}`,
    className: 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400',
    icon: CircleDot,
  };
  const Icon = meta.icon;

  return (
    <span
      title={meta.description}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold tracking-wide',
        meta.className,
        className,
      )}
    >
      {showIcon ? <Icon className="h-3.5 w-3.5" /> : null}
      <span>{meta.label}</span>
    </span>
  );
}

export function getStatusDescription(status: string): string {
  return (STATUS_META[status as keyof typeof STATUS_META])?.description ?? `Status: ${status}`;
}
