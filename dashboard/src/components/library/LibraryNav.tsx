import { Link, useLocation } from 'react-router-dom';
import { BookOpen, Bot, FileText } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { LibrarySection } from '../../lib/libraryPath';

const TABS: Array<{ section: LibrarySection; label: string; icon: typeof BookOpen }> = [
  { section: 'playbooks', label: 'Playbooks', icon: BookOpen },
  { section: 'agents', label: 'Agents', icon: Bot },
  { section: 'templates', label: 'Templates', icon: FileText },
];

export interface LibraryNavProps {
  /** Base path prefix for links (`/library` or legacy `/playbooks`). */
  basePrefix?: string;
  activeSection: LibrarySection;
}

export function LibraryNav({ basePrefix = '/library', activeSection }: LibraryNavProps) {
  const location = useLocation();
  const prefix = basePrefix.replace(/\/$/, '');

  return (
    <nav aria-label="Library sections" className="mb-6 flex flex-wrap gap-2 border-b border-border/40 pb-3">
      {TABS.map(({ section, label, icon: Icon }) => {
        const href = `${prefix}/${section}`;
        const active = activeSection === section;
        return (
          <Link
            key={section}
            to={href}
            className={cn(
              'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition',
              active
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
            aria-current={active ? 'page' : undefined}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        );
      })}
      {location.pathname.startsWith('/library') ? null : (
        <span className="ml-auto text-xs text-muted-foreground">Legacy route — links use canonical /library paths</span>
      )}
    </nav>
  );
}
