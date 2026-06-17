import { Link } from 'react-router-dom';
import { MoonStar, Plus, SunMedium, Menu, Search } from 'lucide-react';
import { useTheme } from '../theme';
import { useWorkspacePrefix } from '../hooks/useProjects';
import { useHotkeyContext, formatPatternForDisplay } from '../hotkeys';
import { ConnectionStatusIndicator } from './ConnectionStatusIndicator';

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
  const wsPrefix = useWorkspacePrefix();
  const { resolvedTheme, toggleTheme } = useTheme();
  const { openPalette } = useHotkeyContext();

  return (
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
            onClick={openPalette}
            className="shell-action"
            aria-label="Open command palette"
          >
            <Search className="h-4 w-4" />
            <span className="hidden sm:inline font-mono text-xs">
              {formatPatternForDisplay('Mod+k')}
            </span>
          </button>
          {/* Help is reachable from the sidebar/hamburger; hide it from the top
              bar on narrow screens so the action row doesn't overflow/clip. */}
          <Link className="shell-action hidden sm:inline-flex" to="/help">
            Help
          </Link>
          <Link className="shell-action" to={`${wsPrefix}/create/project`} aria-label="New Project">
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">New Project</span>
          </Link>
          {projectSlug ? (
            <Link
              className="shell-action"
              to={`${wsPrefix}/projects/${projectSlug}/create/assignment`}
              aria-label="New Assignment"
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New Assignment</span>
            </Link>
          ) : null}
          <button type="button" onClick={toggleTheme} className="shell-action" aria-label="Toggle theme">
            {resolvedTheme === 'dark' ? <SunMedium className="h-4 w-4" /> : <MoonStar className="h-4 w-4" />}
            <span className="hidden sm:inline">{resolvedTheme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
