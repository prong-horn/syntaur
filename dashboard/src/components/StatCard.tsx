import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../lib/utils';

interface StatCardProps {
  label: string;
  value: number | string;
  description?: string;
  icon?: LucideIcon;
  tone?: 'default' | 'info' | 'warn' | 'danger' | 'success';
  to?: string;
}

const TONE_STYLES = {
  default: 'border-border/70 bg-card/90',
  info: 'border-primary/30 bg-primary/5 dark:border-primary/40 dark:bg-primary/10',
  warn: 'border-warning-foreground/30 bg-warning',
  danger: 'border-error-foreground/30 bg-error',
  success: 'border-success-foreground/30 bg-success',
} as const;

export function StatCard({
  label,
  value,
  description,
  icon: Icon,
  tone = 'default',
  to,
}: StatCardProps) {
  const content = (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {label}
          </p>
          <p className="text-2xl font-semibold text-foreground">{value}</p>
        </div>
        {Icon ? (
          <span className="rounded-md border border-border/60 bg-background/80 p-1.5 text-muted-foreground">
            <Icon className="h-5 w-5" />
          </span>
        ) : null}
      </div>
      {description ? (
        <p className="mt-2 text-sm leading-5 text-muted-foreground">{description}</p>
      ) : null}
    </>
  );

  const cardClassName = cn(
    'rounded-lg border p-3 shadow-sm',
    TONE_STYLES[tone],
    to
      ? 'block transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
      : '',
  );

  if (to) {
    return (
      <Link to={to} className={cardClassName}>
        {content}
      </Link>
    );
  }

  return <article className={cardClassName}>{content}</article>;
}
