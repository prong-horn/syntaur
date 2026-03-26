import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  description: string;
  actions?: ReactNode;
}

export function EmptyState({ title, description, actions }: EmptyStateProps) {
  return (
    <div className="rounded-lg border border-dashed border-border/80 bg-muted/30 px-4 py-6 text-center">
      <div className="mx-auto max-w-xl space-y-2">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <p className="text-sm leading-6 text-muted-foreground">{description}</p>
        {actions ? <div className="flex flex-wrap justify-center gap-3 pt-2">{actions}</div> : null}
      </div>
    </div>
  );
}
