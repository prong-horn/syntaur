import { Link } from 'react-router-dom';
import { ArrowUpRight, ArrowLeft, ArrowRight } from 'lucide-react';
import { StatusBadge } from './StatusBadge';
import { SectionCard } from './SectionCard';
import { useWorkspacePrefix } from '../hooks/useProjects';
import type { EnrichedLink } from '../hooks/useProjects';

interface LinksPanelProps {
  links: EnrichedLink[];
}

export function LinksPanel({ links }: LinksPanelProps) {
  const wsPrefix = useWorkspacePrefix();

  if (links.length === 0) return null;

  const forwardLinks = links.filter((l) => !l.isReverse);
  const reverseLinks = links.filter((l) => l.isReverse);

  return (
    <SectionCard
      title="Linked Assignments"
      description={`${links.length} ${links.length === 1 ? 'link' : 'links'}`}
    >
      <div className="divide-y divide-border/40">
        {forwardLinks.map((link) => (
          <Link
            key={`fwd-${link.slug}`}
            to={`${wsPrefix}/projects/${link.projectSlug}/assignments/${link.assignmentSlug}`}
            className="flex items-center gap-3 px-1 py-2.5 transition hover:bg-muted/40 first:pt-0 last:pb-0"
          >
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <StatusBadge status={link.status} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {link.title}
              </p>
              <p className="truncate text-xs text-muted-foreground">{link.slug}</p>
            </div>
            <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Link>
        ))}
        {reverseLinks.map((link) => (
          <Link
            key={`rev-${link.slug}`}
            to={`${wsPrefix}/projects/${link.projectSlug}/assignments/${link.assignmentSlug}`}
            className="flex items-center gap-3 px-1 py-2.5 transition hover:bg-muted/40 first:pt-0 last:pb-0"
          >
            <ArrowLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <StatusBadge status={link.status} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {link.title}
              </p>
              <p className="truncate text-xs text-muted-foreground">{link.slug}</p>
            </div>
            <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </SectionCard>
  );
}
