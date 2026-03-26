import { Link } from 'react-router-dom';
import type { HelpResponse } from '../hooks/useMissions';
import { CommandSnippet } from './CommandSnippet';
import { SectionCard } from './SectionCard';

interface GettingStartedCardProps {
  help: HelpResponse | null;
  compact?: boolean;
}

export function GettingStartedCard({
  help,
  compact = false,
}: GettingStartedCardProps) {
  const items = compact
    ? help?.firstMissionChecklist.slice(0, 3) ?? []
    : help?.firstMissionChecklist ?? [];

  return (
    <SectionCard
      title={compact ? 'Getting Started Refresher' : 'Getting Started'}
      description={
        compact
          ? 'A fast reminder of the real flow for creating and running work in Syntaur.'
          : 'A first-run checklist that maps to the current CLI and dashboard flow.'
      }
      actions={
        <Link className="text-sm font-semibold text-primary hover:underline" to="/help">
          Open full help
        </Link>
      }
    >
      <div className="space-y-3">
        {items.map((item, index) => (
          <div key={item.title} className="rounded-md border border-border/60 bg-background/80 p-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
                {index + 1}
              </span>
              <div className="space-y-1.5">
                <h3 className="font-semibold text-foreground">{item.title}</h3>
                <p className="text-sm leading-6 text-muted-foreground">{item.detail}</p>
                {item.command ? (
                  <CommandSnippet command={item.command.command} example={item.command.example} />
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
