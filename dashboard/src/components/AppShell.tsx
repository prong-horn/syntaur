import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { Activity, AlertTriangle, BookOpen, CheckSquare, Compass, FolderKanban, LifeBuoy, ListTodo, Monitor, Plus, Settings, X, ChevronDown } from 'lucide-react';
import { SidebarNav, type SidebarNavItem } from './SidebarNav';
import { TopBar } from './TopBar';
import { useWorkspaces } from '../hooks/useMissions';
import { toTitleCase } from '../lib/format';
import { isSidebarItemActive, type SidebarSection } from '../lib/routes';

interface Breadcrumb {
  label: string;
  path: string;
}

interface AppShellProps {
  title: string;
  breadcrumbs: Breadcrumb[];
  missionSlug: string | null;
  workspace: string | null;
  children: ReactNode;
}

const GLOBAL_NAV_ITEMS: SidebarNavItem[] = [
  { to: '/', label: 'Overview', icon: Compass },
  { to: '/attention', label: 'Attention', icon: AlertTriangle },
  { to: '/playbooks', label: 'Playbooks', icon: BookOpen },
  { to: '/todos', label: 'Todos', icon: CheckSquare },
];

const WORKSPACE_SCOPED_LABELS: Array<{ suffix: string; label: string; icon: LucideIcon }> = [
  { suffix: '/missions', label: 'Missions', icon: FolderKanban },
  { suffix: '/assignments', label: 'Assignments', icon: ListTodo },
  { suffix: '/servers', label: 'Servers', icon: Monitor },
  { suffix: '/agent-sessions', label: 'Agent Sessions', icon: Activity },
  { suffix: '/todos', label: 'Todos', icon: CheckSquare },
];

const UTILITY_NAV_ITEMS: SidebarNavItem[] = [
  { to: '/help', label: 'Help', icon: LifeBuoy },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const SOURCE_FIRST_NOTICE_KEY = 'syntaur.dashboard.sourceFirstNoticeDismissed';

export function AppShell({
  title,
  breadcrumbs,
  missionSlug,
  workspace,
  children,
}: AppShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sourceNoticeDismissed, setSourceNoticeDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(SOURCE_FIRST_NOTICE_KEY) === '1';
    } catch {
      return false;
    }
  });

  function dismissSourceNotice() {
    setSourceNoticeDismissed(true);
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(SOURCE_FIRST_NOTICE_KEY, '1');
    } catch {
      // Keep the notice dismissed for this session even if persistence fails.
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="relative grid min-h-screen lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="hidden max-h-screen sticky top-0 overflow-y-auto border-r border-border/70 bg-sidebar/90 px-4 py-4 backdrop-blur lg:flex lg:flex-col">
          <ShellSidebar
            sourceNoticeDismissed={sourceNoticeDismissed}
            onDismissSourceNotice={dismissSourceNotice}
            activeWorkspace={workspace}
          />
        </aside>

        {mobileNavOpen ? (
          <div className="fixed inset-0 z-40 bg-slate-950/40 lg:hidden">
            <div className="h-full max-w-xs border-r border-border/70 bg-sidebar p-4 shadow-2xl">
              <div className="mb-4 flex items-center justify-between">
                <Link to="/" className="text-lg font-semibold text-foreground" onClick={() => setMobileNavOpen(false)}>
                  Syntaur
                </Link>
                <button
                  type="button"
                  onClick={() => setMobileNavOpen(false)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border/70 bg-background/80"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <ShellSidebar
                sourceNoticeDismissed={sourceNoticeDismissed}
                onDismissSourceNotice={dismissSourceNotice}
                activeWorkspace={workspace}
                onNavigate={() => setMobileNavOpen(false)}
              />
            </div>
          </div>
        ) : null}

        <div className="min-w-0">
          <TopBar
            title={title}
            breadcrumbs={breadcrumbs}
            missionSlug={missionSlug}
            onOpenMobileNav={() => setMobileNavOpen(true)}
          />
          <main className="mx-auto w-full max-w-[1480px] px-4 py-4 lg:px-6 lg:py-5">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

function ShellSidebar({
  sourceNoticeDismissed,
  onDismissSourceNotice,
  activeWorkspace,
  onNavigate,
}: {
  sourceNoticeDismissed: boolean;
  onDismissSourceNotice: () => void;
  activeWorkspace: string | null;
  onNavigate?: () => void;
}) {
  const { data: workspaceData } = useWorkspaces();
  const workspaces = workspaceData?.workspaces ?? [];
  const hasUngrouped = workspaceData?.hasUngrouped ?? false;
  const location = useLocation();
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set());
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const navigate = useNavigate();

  function toggleCollapse(ws: string) {
    setCollapsedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(ws)) {
        next.delete(ws);
      } else {
        next.add(ws);
      }
      return next;
    });
  }

  // Build workspace sections: named workspaces + ungrouped (only if missions without workspace exist)
  const allSections = [...workspaces, ...(hasUngrouped ? ['_ungrouped'] : [])];

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="space-y-3">
        <Link to="/" className="inline-flex items-center gap-3" onClick={onNavigate}>
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-foreground text-sm font-semibold text-background shadow-sm">
            S
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">Syntaur</p>
            <p className="text-xs text-muted-foreground/60">Local-first mission control</p>
          </div>
        </Link>
      </div>

      {/* Global zone */}
      <SidebarNav items={GLOBAL_NAV_ITEMS} onNavigate={onNavigate} />

      {/* Divider */}
      <div className="border-t border-border/40" />

      {/* Workspace-scoped zones */}
      <div className="flex-1 space-y-1 overflow-y-auto">
        {allSections.length === 0 && !creatingWorkspace && (
          <p className="px-3 py-2 text-xs text-muted-foreground/60">No workspaces yet</p>
        )}
        {allSections.map((ws) => {
          const isUngrouped = ws === '_ungrouped';
          const wsLabel = isUngrouped ? 'Ungrouped' : toTitleCase(ws);
          const wsPrefix = isUngrouped ? '/w/_ungrouped' : `/w/${ws}`;
          const isCollapsed = collapsedWorkspaces.has(ws);
          const isActive = activeWorkspace === ws || (activeWorkspace === null && isUngrouped && location.pathname.startsWith('/w/_ungrouped'));

          return (
            <div key={ws}>
              <button
                type="button"
                onClick={() => toggleCollapse(ws)}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition ${
                  isActive
                    ? 'text-foreground'
                    : 'text-muted-foreground/70 hover:text-muted-foreground'
                }`}
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                {wsLabel}
              </button>
              {!isCollapsed && (
                <nav className="ml-2 space-y-0.5">
                  {WORKSPACE_SCOPED_LABELS.map((item) => {
                    const path = `${wsPrefix}${item.suffix}`;
                    const isItemActive = isSidebarItemActive(location.pathname, item.suffix as SidebarSection)
                      && location.pathname.startsWith(wsPrefix);
                    const Icon = item.icon;
                    return (
                      <Link
                        key={path}
                        to={path}
                        onClick={onNavigate}
                        className={`flex items-center gap-3 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                          isItemActive
                            ? 'bg-foreground text-background shadow-sm'
                            : 'text-muted-foreground hover:bg-background/80 hover:text-foreground'
                        }`}
                      >
                        <Icon className="h-4 w-4" />
                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
                </nav>
              )}
            </div>
          );
        })}

        {creatingWorkspace ? (
          <form
            className="px-3 py-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const slug = newWorkspaceName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
              if (slug) {
                setCreatingWorkspace(false);
                setNewWorkspaceName('');
                fetch('/api/workspaces', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name: slug }),
                }).then(() => {
                  onNavigate?.();
                  navigate(`/w/${slug}/missions`);
                });
              }
            }}
          >
            <input
              autoFocus
              type="text"
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setCreatingWorkspace(false);
                  setNewWorkspaceName('');
                }
              }}
              onBlur={() => {
                if (!newWorkspaceName.trim()) {
                  setCreatingWorkspace(false);
                  setNewWorkspaceName('');
                }
              }}
              placeholder="workspace-name"
              className="w-full rounded-md border border-border/60 bg-background/80 px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-none"
            />
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setCreatingWorkspace(true)}
            className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground/60 transition hover:text-muted-foreground"
          >
            <Plus className="h-3 w-3" />
            New Workspace
          </button>
        )}
      </div>

      {/* Divider */}
      <div className="border-t border-border/40" />

      {/* Utility zone */}
      <SidebarNav items={UTILITY_NAV_ITEMS} onNavigate={onNavigate} />

      {sourceNoticeDismissed ? null : (
        <div className="rounded-lg border border-border/60 bg-background/80 p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-foreground">Source-first dashboard</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Mission and assignment markdown files stay authoritative. Derived files are read-only projections.
              </p>
            </div>
            <button
              type="button"
              onClick={onDismissSourceNotice}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/70 bg-background/80 text-muted-foreground transition hover:text-foreground"
              aria-label="Dismiss source-first dashboard notice"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
