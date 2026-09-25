import { Link, useLocation } from 'react-router-dom';
import { ChevronDown, FolderKanban } from 'lucide-react';
import { useProjects, useTicket, type ProjectSummary } from '../hooks/useProjects';
import type { ProgressCounts } from '../data/types';
import { parseBoardUrlParams } from '../lib/boardUrlParams';
import { useSidebarCollapse } from '../hooks/useSidebarCollapse';
import { cn } from '../lib/utils';

const COLLAPSE_ID = 'projects';

export function activeSidebarProjectSlug(pathname: string, search: string): string | undefined {
  let normalized = pathname;
  if (!normalized || normalized === '/') {
    return undefined;
  }
  if (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  if (!normalized.startsWith('/board')) {
    return undefined;
  }
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const { project } = parseBoardUrlParams(params);
  return project.length === 1 ? project[0] : undefined;
}

function openTicketCount(progress: ProgressCounts): number {
  const total = progress.total ?? 0;
  const done = progress.done ?? 0;
  const dropped = progress.dropped ?? 0;
  return Math.max(0, total - done - dropped);
}

function sortProjects(projects: ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort((a, b) => {
    const byTitle = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    if (byTitle !== 0) return byTitle;
    return a.slug.localeCompare(b.slug, undefined, { sensitivity: 'base' });
  });
}

interface SidebarProjectsProps {
  onNavigate?: () => void;
}

export function SidebarProjects({ onNavigate }: SidebarProjectsProps) {
  const location = useLocation();
  const { data, loading, error } = useProjects();
  const { isCollapsed, toggle } = useSidebarCollapse();

  const ticketPathMatch = location.pathname.match(/^\/t\/([^/]+)/);
  const ticketId = ticketPathMatch?.[1]
    ? decodeURIComponent(ticketPathMatch[1])
    : undefined;
  const { data: ticket } = useTicket(ticketId);

  const boardActiveSlug = activeSidebarProjectSlug(location.pathname, location.search);
  const ticketActiveSlug = ticket?.projectSlug ?? undefined;
  const activeSlug = boardActiveSlug ?? ticketActiveSlug;

  const collapsed = isCollapsed(COLLAPSE_ID);
  const headerActive = collapsed && activeSlug !== undefined;

  const activeProjects = sortProjects((data ?? []).filter((p) => p.archived !== true));

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => toggle(COLLAPSE_ID)}
        aria-expanded={!collapsed}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition',
          headerActive
            ? 'text-foreground'
            : 'text-muted-foreground/70 hover:text-muted-foreground',
        )}
      >
        <ChevronDown className={cn('h-3 w-3 transition-transform', collapsed && '-rotate-90')} />
        Projects
      </button>
      {!collapsed ? (
        <nav aria-label="Projects" className="mt-1 space-y-0.5">
          {error ? (
            <p className="px-3 py-1.5 text-sm text-muted-foreground/70">Projects unavailable</p>
          ) : loading ? null : activeProjects.length === 0 ? (
            <p className="px-3 py-1.5 text-sm text-muted-foreground/70">No active projects</p>
          ) : (
            activeProjects.map((project) => {
              const isActive = activeSlug === project.slug;
              const count = openTicketCount(project.progress);
              return (
                <Link
                  key={project.slug}
                  to={`/board?project=${encodeURIComponent(project.slug)}`}
                  onClick={onNavigate}
                  aria-current={isActive ? 'page' : undefined}
                  title={project.title}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition',
                    isActive
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-background/80 hover:text-foreground',
                  )}
                >
                  <FolderKanban className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate">{project.title}</span>
                  {count > 0 ? (
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground/70">{count}</span>
                  ) : null}
                </Link>
              );
            })
          )}
        </nav>
      ) : null}
    </div>
  );
}
