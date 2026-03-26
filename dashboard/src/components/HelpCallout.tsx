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
    <aside className="rounded-lg border border-teal-200 bg-teal-50/90 p-4 text-sm dark:border-teal-900 dark:bg-teal-950/30">
      <div className="flex items-start gap-3">
        <span className="rounded-md border border-teal-200 bg-white/70 p-2 text-teal-700 dark:border-teal-900 dark:bg-teal-950 dark:text-teal-300">
          <LifeBuoy className="h-4 w-4" />
        </span>
        <div className="space-y-2">
          <h3 className="font-semibold text-teal-900 dark:text-teal-100">{title}</h3>
          <div className="leading-6 text-teal-800 dark:text-teal-200">{children}</div>
          <Link
            to={href}
            className="inline-flex text-sm font-semibold text-teal-700 underline-offset-4 hover:underline dark:text-teal-300"
          >
            {hrefLabel}
          </Link>
        </div>
      </div>
    </aside>
  );
}
