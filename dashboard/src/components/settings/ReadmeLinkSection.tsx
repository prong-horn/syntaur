import { ExternalLink } from 'lucide-react';
import { SectionCard } from '../SectionCard';

const README_URL = 'https://github.com/prong-horn/syntaur#readme';

export function ReadmeLinkSection() {
  return (
    <SectionCard
      title="Documentation"
      description="Syntaur usage, CLI commands, and protocol reference live in the project README on GitHub."
    >
      <a
        href={README_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 rounded-md border border-border/70 bg-card/80 px-3 py-2 text-sm font-medium text-foreground hover:bg-accent"
      >
        Open Syntaur README
        <ExternalLink className="h-4 w-4" aria-hidden />
      </a>
    </SectionCard>
  );
}
