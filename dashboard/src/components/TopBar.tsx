import { Link } from 'react-router-dom';
import { MoonStar, Plus, SunMedium, Menu } from 'lucide-react';
import { useTheme } from '../theme';

interface Breadcrumb {
  label: string;
  path: string;
}

interface TopBarProps {
  title: string;
  breadcrumbs: Breadcrumb[];
  missionSlug: string | null;
  onOpenMobileNav: () => void;
}

export function TopBar({
  title,
  breadcrumbs,
  missionSlug,
  onOpenMobileNav,
}: TopBarProps) {
  const { resolvedTheme, toggleTheme } = useTheme();

  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 lg:px-6">
        <button
          type="button"
          onClick={onOpenMobileNav}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-card/80 text-foreground lg:hidden"
          aria-label="Open navigation"
        >
          <Menu className="h-4 w-4" />
        </button>

        <div className="min-w-0 flex-1 space-y-1">
          {breadcrumbs.length > 0 ? (
            <nav className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
              {breadcrumbs.map((breadcrumb, index) => (
                <span key={breadcrumb.path} className="flex items-center gap-2">
                  {index > 0 ? <span>/</span> : null}
                  <Link to={breadcrumb.path} className="hover:text-foreground">
                    {breadcrumb.label}
                  </Link>
                </span>
              ))}
            </nav>
          ) : null}
          <h1 className="truncate text-lg font-semibold text-foreground">{title}</h1>
        </div>

        <div className="flex items-center gap-2">
          <Link className="shell-action" to="/help">
            Help
          </Link>
          <Link className="shell-action" to="/create/mission">
            <Plus className="h-4 w-4" />
            <span>New Mission</span>
          </Link>
          {missionSlug ? (
            <Link className="shell-action" to={`/missions/${missionSlug}/create/assignment`}>
              <Plus className="h-4 w-4" />
              <span>New Assignment</span>
            </Link>
          ) : null}
          <button type="button" onClick={toggleTheme} className="shell-action" aria-label="Toggle theme">
            {resolvedTheme === 'dark' ? <SunMedium className="h-4 w-4" /> : <MoonStar className="h-4 w-4" />}
            <span>{resolvedTheme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
