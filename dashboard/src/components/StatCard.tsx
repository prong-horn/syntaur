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
  default: 'chrome-card',
  info: 'rounded-lg border border-primary/30 bg-primary/5 p-3 dark:border-primary/40 dark:bg-primary/10',
  warn: 'rounded-lg border border-warning-foreground/30 bg-warning p-3',
  danger: 'rounded-lg border border-error-foreground/30 bg-error p-3',
  success: 'rounded-lg border border-success-foreground/30 bg-success p-3',
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

  // A zero count is not an alarm: mute alarm tones (warn/danger) to neutral when
  // the value is 0 (or "0") so an empty "Blocked"/"Failed" card doesn't shout.
  const isZero = value === 0 || value === '0';
  const effectiveTone = isZero && (tone === 'warn' || tone === 'danger') ? 'default' : tone;

  const cardClassName = cn(
    TONE_STYLES[effectiveTone],
    to
      ? 'block transition hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
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
