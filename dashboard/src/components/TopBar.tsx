import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MoonStar, Plus, SunMedium, Menu, Search } from 'lucide-react';
import { useTheme } from '../theme';
import { ConnectionStatusIndicator } from './ConnectionStatusIndicator';
import { SearchDialog } from './search/SearchDialog';

interface Breadcrumb {
  label: string;
  path: string;
}

interface TopBarProps {
  title: string;
  breadcrumbs: Breadcrumb[];
  projectSlug: string | null;
  onOpenMobileNav: () => void;
}

export function TopBar({
  title,
  breadcrumbs,
  projectSlug,
  onOpenMobileNav,
}: TopBarProps) {
  const { resolvedTheme, toggleTheme } = useTheme();
  const [searchOpen, setSearchOpen] = useState(false);

  const newTicketHref = projectSlug
    ? `/board?project=${encodeURIComponent(projectSlug)}&dialog=new-ticket`
    : '/board?dialog=new-ticket';

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/70 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 lg:px-6">
          <button
            type="button"
            onClick={onOpenMobileNav}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-card/80 text-foreground lg:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-4 w-4" />
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {breadcrumbs.length > 1 ? (
                <nav className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  {breadcrumbs.slice(0, -1).map((breadcrumb, index) => (
                    <span key={breadcrumb.path} className="flex items-center gap-1.5">
                      {index > 0 ? <span>/</span> : null}
                      <Link to={breadcrumb.path} className="hover:text-foreground">
                        {breadcrumb.label}
                      </Link>
                    </span>
                  ))}
                  <span>/</span>
                </nav>
              ) : null}
              <h1 className="min-w-0 truncate text-base font-semibold text-foreground">{title}</h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ConnectionStatusIndicator />
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="shell-action"
              aria-label="Open search"
            >
              <Search className="h-4 w-4" />
              <span className="hidden sm:inline">Search</span>
            </button>
            <Link className="shell-action" to="/board?dialog=new-project" aria-label="New Project">
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New Project</span>
            </Link>
            <Link className="shell-action" to={newTicketHref} aria-label="New Ticket">
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New Ticket</span>
            </Link>
            <button type="button" onClick={toggleTheme} className="shell-action" aria-label="Toggle theme">
              {resolvedTheme === 'dark' ? <SunMedium className="h-4 w-4" /> : <MoonStar className="h-4 w-4" />}
              <span className="hidden sm:inline">{resolvedTheme === 'dark' ? 'Light' : 'Dark'}</span>
            </button>
          </div>
        </div>
      </header>
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}
