import { ExternalLink } from 'lucide-react';
import type { ExternalIdInfo } from '../hooks/useProjects';
import { cn } from '../lib/utils';

interface ExternalIdBadgesProps {
  externalIds: ExternalIdInfo[];
  className?: string;
}

const BADGE_BASE =
  'inline-flex max-w-[14rem] items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide border-border/60 text-muted-foreground';

const LABEL_BASE = 'truncate';

export function ExternalIdBadges({ externalIds, className }: ExternalIdBadgesProps) {
  if (externalIds.length === 0) return null;

  return (
    <span className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {externalIds.map((entry, idx) => {
        const label = `${entry.system}:${entry.id}`;
        const key = `${entry.system}:${entry.id}:${idx}`;
        const hasUrl = entry.url != null && entry.url.length > 0;

        if (hasUrl) {
          return (
            <a
              key={key}
              href={entry.url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                BADGE_BASE,
                'transition-colors hover:text-foreground hover:border-foreground/40',
              )}
              title={`Open ${label} in ${entry.system}`}
            >
              <span className={LABEL_BASE}>{label}</span>
              <ExternalLink className="h-2.5 w-2.5 shrink-0" />
            </a>
          );
        }

        return (
          <span key={key} className={BADGE_BASE} title={label}>
            <span className={LABEL_BASE}>{label}</span>
          </span>
        );
      })}
    </span>
  );
}
