import { Link } from 'react-router-dom';
import type { OverviewHeroRecommendation, AttentionItem } from '../hooks/useProjects';
import { HERO_COPY, formatCopy, DIALOG_COPY, type HeroCopyKey } from '../lib/overviewCopy';

interface OverviewHeroProps {
  hero: OverviewHeroRecommendation;
  itemsById: Record<string, AttentionItem>;
}

export function OverviewHero({ hero, itemsById }: OverviewHeroProps) {
  if (hero.kind === 'clean') {
    return (
      <section
        aria-labelledby="overview-hero-title"
        className="rounded-xl border border-border/60 bg-background/60 p-6 shadow-sm"
      >
        <p className="eyebrow">{DIALOG_COPY.emptyStateCleanTitle}</p>
        <h2 id="overview-hero-title" className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
          {HERO_COPY.clean}
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">
          When work shows up — a draft, a review, a stale row — it’ll surface here.
        </p>
        <div className="mt-4">
          <Link to="/projects" className="shell-action shell-action--cta">
            {DIALOG_COPY.emptyStateCleanCTA}
          </Link>
        </div>
      </section>
    );
  }

  const item = hero.itemId ? itemsById[hero.itemId] : undefined;
  const title = item?.ticketTitle ?? '';
  const copyTemplate = HERO_COPY[hero.copyKey as HeroCopyKey] ?? HERO_COPY[hero.kind as HeroCopyKey];
  const headline = formatCopy(copyTemplate, { total: hero.total, title });
  const href = item?.href ?? '/tickets';

  return (
    <section
      aria-labelledby="overview-hero-title"
      className="rounded-xl border border-primary/20 bg-primary/5 p-6 shadow-sm"
    >
      <p className="eyebrow">Top priority</p>
      <h2 id="overview-hero-title" className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
        {headline}
      </h2>
      {item ? (
        <p className="mt-2 text-sm text-muted-foreground">
          In <span className="font-medium text-foreground">{item.projectTitle ?? 'Standalone'}</span>
          {' '}· status <span className="font-medium text-foreground">{item.status}</span>
        </p>
      ) : null}
      <div className="mt-4">
        <Link to={href} className="shell-action shell-action--cta">
          Open {title || 'ticket'}
        </Link>
      </div>
    </section>
  );
}
