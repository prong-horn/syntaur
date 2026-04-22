import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LifeBuoy } from 'lucide-react';

interface HelpCalloutProps {
  title: string;
  children: ReactNode;
  href?: string;
  hrefLabel?: string;
}

export function HelpCallout({
  title,
  children,
  href = '/help',
  hrefLabel = 'Open Help',
}: HelpCalloutProps) {
  return (
    <aside className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm dark:border-primary/40 dark:bg-primary/10">
      <div className="flex items-start gap-3">
        <span className="rounded-md border border-primary/30 bg-background/70 p-2 text-primary dark:border-primary/40 dark:bg-primary/10">
          <LifeBuoy className="h-4 w-4" />
        </span>
        <div className="space-y-2">
          <h3 className="font-semibold text-foreground">{title}</h3>
          <div className="leading-6 text-muted-foreground">{children}</div>
          <Link
            to={href}
            className="inline-flex text-sm font-semibold text-primary underline-offset-4 hover:underline"
          >
            {hrefLabel}
          </Link>
        </div>
      </div>
    </aside>
  );
}
