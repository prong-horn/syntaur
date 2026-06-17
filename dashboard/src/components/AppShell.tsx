import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { Activity, Archive, BookOpen, Boxes, Brain, CalendarClock, CheckSquare, Coins, Compass, FolderKanban, Inbox, LayoutTemplate, LifeBuoy, Library, ListTodo, Monitor, Plus, Settings, Workflow, X, ChevronDown, Trash2 } from 'lucide-react';
import { SidebarNav, type SidebarNavItem } from './SidebarNav';
import { TopBar } from './TopBar';
import { useToast, Toaster } from './Toast';
import { useWorkspaces } from '../hooks/useProjects';
import { useInbox } from '../hooks/useInbox';
import {
  UNGROUPED_WORKSPACE,
  visibleWorkspaces,
} from '@shared/workspace-visibility-schema';
import { useWorkspaceVisibilityConfig } from '../hooks/useWorkspaceVisibilityConfig';
import { toTitleCase } from '../lib/format';
import { isSidebarItemActive, type SidebarSection } from '../lib/routes';
import { useHotkey } from '../hotkeys';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';

interface Breadcrumb {
  label: string;
  path: string;
}

interface AppShellProps {
  title: string;
  breadcrumbs: Breadcrumb[];
  projectSlug: string | null;
  workspace: string | null;
  children: ReactNode;
}

const GLOBAL_NAV_ITEMS: SidebarNavItem[] = [
  { to: '/', label: 'Overview', icon: Compass },
  { to: '/inbox', label: 'Needs me', icon: Inbox },
  { to: '/playbooks', label: 'Playbooks', icon: BookOpen },
  { to: '/memories', label: 'Memories', icon: Brain },
  { to: '/resources', label: 'Resources', icon: Library },
  { to: '/inventories', label: 'Inventories', icon: Boxes },
  { to: '/schedules', label: 'Schedules', icon: CalendarClock },
  { to: '/usage', label: 'Usage', icon: Coins },
  { to: '/todos', label: 'Todos', icon: CheckSquare },
  { to: '/views', label: 'Saved Views', icon: LayoutTemplate },
  { to: '/archive', label: 'Archive', icon: Archive },
];

// Only entities that live INSIDE a workspace and have no global nav entry.
// Inventories/Usage/Todos are intentionally NOT here — they live once in the
// global nav (their pages aggregate across workspaces with their own filters),
// so repeating them per-workspace was pure duplication. Routes like
// /w/:ws/usage still work; only the sidebar list is trimmed.
const WORKSPACE_SCOPED_LABELS: Array<{ suffix: string; label: string; icon: LucideIcon }> = [
  { suffix: '/projects', label: 'Projects', icon: FolderKanban },
  { suffix: '/assignments', label: 'Assignments', icon: ListTodo },
  { suffix: '/servers', label: 'Servers', icon: Monitor },
  { suffix: '/agent-sessions', label: 'Agent Sessions', icon: Activity },
];

const UTILITY_NAV_ITEMS: SidebarNavItem[] = [
  { to: '/help', label: 'Help', icon: LifeBuoy },
  { to: '/workflow', label: 'Workflow', icon: Workflow },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function AppShell({
  title,
  breadcrumbs,
  projectSlug,
  workspace,
  children,
}: AppShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // R6: Esc closes the non-Radix mobile nav overlay.
  useHotkey({
    keys: 'Escape',
    scope: 'global',
    description: 'Close mobile navigation',
    enabled: mobileNavOpen,
    handler: () => setMobileNavOpen(false),
  });

  return (
    <div className="min-h-screen bg-background">
      <div className="relative grid min-h-screen lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="hidden max-h-screen sticky top-0 overflow-y-auto border-r border-border/70 bg-sidebar px-4 py-4 lg:flex lg:flex-col">
          <ShellSidebar activeWorkspace={workspace} />
        </aside>

        {mobileNavOpen ? (
          <div className="fixed inset-0 z-40 bg-overlay/40 lg:hidden">
            <div className="h-full max-w-xs border-r border-border/70 bg-sidebar p-4 shadow-2xl">
              <div className="mb-4 flex items-center justify-between">
                <Link to="/" className="text-lg font-semibold text-foreground" onClick={() => setMobileNavOpen(false)}>
                  Syntaur
                </Link>
                <button
                  type="button"
                  onClick={() => setMobileNavOpen(false)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border/70 bg-background/80"
                  aria-label="Close navigation"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <ShellSidebar
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
            projectSlug={projectSlug}
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
  activeWorkspace,
  onNavigate,
}: {
  activeWorkspace: string | null;
  onNavigate?: () => void;
}) {
  // Live "needs me" count for the nav badge. This is one extra app-wide
  // `/api/inbox` fetch (WS-refreshed, shared via the single WS connection) —
  // a deliberate, cheap tradeoff for an always-visible at-a-glance count vs.
  // threading the total down from every page. Injected onto the /inbox entry.
  const { total: inboxTotal } = useInbox();
  const globalNavItems = GLOBAL_NAV_ITEMS.map((item) =>
    item.to === '/inbox' ? { ...item, badge: inboxTotal } : item,
  );
  const { data: workspaceData } = useWorkspaces();
  const workspaces = workspaceData?.workspaces ?? [];
  const hasUngrouped = workspaceData?.hasUngrouped ?? false;
  const { hidden: hiddenWorkspaces } = useWorkspaceVisibilityConfig();
  const location = useLocation();
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set());
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [hoverWs, setHoverWs] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteBlockers, setDeleteBlockers] = useState<{ projects: string[]; standalones: string[] } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const navigate = useNavigate();
  const { toast, showToast, dismissToast } = useToast();

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

  // Build workspace sections: named workspaces + ungrouped (only if projects without workspace exist),
  // then drop any the user has hidden from the left nav (absent from the blocklist = visible).
  // Hidden workspaces stay fully reachable via direct URL — only the sidebar list shrinks.
  const allSections = visibleWorkspaces(
    [...workspaces, ...(hasUngrouped ? [UNGROUPED_WORKSPACE] : [])],
    hiddenWorkspaces,
  );

  async function handleDeleteWorkspace(cascade: boolean): Promise<void> {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const url = `/api/workspaces/${encodeURIComponent(deleteTarget)}${cascade ? '?cascade=true' : ''}`;
      const res = await fetch(url, { method: 'DELETE' });
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        setDeleteBlockers(body?.blockedBy ?? { projects: [], standalones: [] });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to delete workspace');
      }
      setDeleteTarget(null);
      setDeleteBlockers(null);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Failed to delete workspace');
    } finally {
      setDeleteLoading(false);
    }
  }

  async function handleSidebarDrop(
    payload: { type: string; id: string },
    target: string | null,
  ): Promise<void> {
    try {
      if (payload.type === 'project') {
        const res = await fetch(`/api/projects/${encodeURIComponent(payload.id)}/move-workspace`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace: target }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Failed to move project');
        }
        return;
      }
      if (payload.type === 'standalone-assignment') {
        const res = await fetch(`/api/assignments/${encodeURIComponent(payload.id)}/move-workspace`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceGroup: target }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Failed to move assignment');
        }
        return;
      }
      if (payload.type === 'project-assignment') {
        alert(
          'Assignments inherit workspace from their project — drag the project (or move it) to change workspaces.',
        );
        return;
      }
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Failed to move item');
    }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <Toaster toast={toast} onDismiss={dismissToast} />
      <div className="space-y-3">
        <Link to="/" className="inline-flex items-center gap-3" onClick={onNavigate}>
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-card text-foreground shadow-sm ring-1 ring-border/60">
            <svg viewBox="0 0 43 51" aria-label="Syntaur" role="img" className="h-4 w-auto" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
              <path d="M13 2C13 0.89543 13.8954 0 15 0H41C42.1046 0 43 0.895431 43 2V12C43 13.1046 42.1046 14 41 14H13V2Z" />
              <path d="M0 15C0 13.8954 0.895431 13 2 13H14V25C14 26.1046 13.1046 27 12 27H2C0.89543 27 0 26.1046 0 25V15Z" />
              <path d="M30 49C30 50.1046 29.1046 51 28 51L2 51C0.89543 51 0 50.1046 0 49L0 39C0 37.8954 0.895431 37 2 37L30 37L30 49Z" />
              <path d="M42.9646 36C42.9646 37.1046 42.0692 38 40.9646 38H28.9646V26C28.9646 24.8954 29.86 24 30.9646 24H40.9646C42.0692 24 42.9646 24.8954 42.9646 26V36Z" />
            </svg>
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">Syntaur</p>
            <p className="text-xs text-muted-foreground/60">Local-first project control</p>
          </div>
        </Link>
      </div>

      {/* Global zone */}
      <SidebarNav items={globalNavItems} onNavigate={onNavigate} />

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
          const isHover = hoverWs === ws;

          return (
            <div
              key={ws}
              className={`rounded-md transition ${isHover ? 'bg-accent/40 ring-1 ring-ring/40' : ''}`}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes('application/json')) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setHoverWs(ws);
              }}
              onDragLeave={(event) => {
                // Descendant check prevents hover flicker as the pointer crosses child elements.
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setHoverWs((prev) => (prev === ws ? null : prev));
              }}
              onDrop={async (event) => {
                try {
                  const raw = event.dataTransfer.getData('application/json');
                  if (!raw) return;
                  event.preventDefault();
                  let payload: { type?: string; id?: string };
                  try {
                    payload = JSON.parse(raw);
                  } catch {
                    return;
                  }
                  if (!payload?.type || !payload?.id) return;
                  const target = isUngrouped ? null : ws;
                  await handleSidebarDrop(payload as { type: string; id: string }, target);
                } finally {
                  setHoverWs(null);
                }
              }}
            >
              <div className="group flex items-center">
                <button
                  type="button"
                  onClick={() => toggleCollapse(ws)}
                  className={`flex flex-1 items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition ${
                    isActive
                      ? 'text-foreground'
                      : 'text-muted-foreground/70 hover:text-muted-foreground'
                  }`}
                >
                  <ChevronDown className={`h-3 w-3 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                  {wsLabel}
                </button>
                {!isUngrouped ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeleteTarget(ws);
                      setDeleteBlockers(null);
                    }}
                    title={`Delete workspace "${ws}"`}
                    aria-label={`Delete workspace "${ws}"`}
                    className="mr-1 flex h-6 w-6 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
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
            onSubmit={async (e) => {
              e.preventDefault();
              const slug = newWorkspaceName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
              if (!slug) return;
              setCreatingWorkspace(false);
              setNewWorkspaceName('');
              try {
                const res = await fetch('/api/workspaces', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name: slug }),
                });
                if (!res.ok) {
                  const payload = await res.json().catch(() => null);
                  showToast(payload?.error || `HTTP ${res.status}`, 'error');
                  return; // do not navigate on failure
                }
                onNavigate?.();
                navigate(`/w/${slug}/projects`);
              } catch (err) {
                showToast(err instanceof Error ? err.message : 'Failed to create workspace', 'error');
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

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (deleteLoading) return;
          if (!next) {
            setDeleteTarget(null);
            setDeleteBlockers(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteBlockers ? 'Workspace has references' : 'Delete workspace?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteBlockers ? (
                <>
                  The workspace <code className="rounded bg-muted px-1 py-0.5">{deleteTarget}</code> is still referenced by:
                </>
              ) : (
                <>
                  Remove the workspace <code className="rounded bg-muted px-1 py-0.5">{deleteTarget}</code> from the registry. This does not affect projects or standalones unless you choose to cascade.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {deleteBlockers ? (
            <div className="space-y-2 text-sm">
              {deleteBlockers.projects.length > 0 ? (
                <div>
                  <p className="font-medium text-foreground">
                    Projects ({deleteBlockers.projects.length})
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                    {deleteBlockers.projects.map((slug) => (
                      <li key={slug}>
                        <Link to={`/projects/${slug}`} className="hover:underline">
                          {slug}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {deleteBlockers.standalones.length > 0 ? (
                <div>
                  <p className="font-medium text-foreground">
                    Standalones ({deleteBlockers.standalones.length})
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                    {deleteBlockers.standalones.map((id) => (
                      <li key={id}>
                        <Link to={`/assignments/${id}`} className="hover:underline">
                          {id}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Choose "Clear references and delete" to set <code>workspace:</code> / <code>workspaceGroup:</code> to <code>null</code> on each, then remove the workspace.
              </p>
            </div>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={deleteLoading}
              className="shell-action mt-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </AlertDialogCancel>
            {deleteBlockers ? (
              <AlertDialogAction
                disabled={deleteLoading}
                onClick={(event) => {
                  event.preventDefault();
                  void handleDeleteWorkspace(true);
                }}
                className="shell-action mt-0 border-destructive/80 bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleteLoading ? 'Working…' : 'Clear references and delete'}
              </AlertDialogAction>
            ) : (
              <AlertDialogAction
                disabled={deleteLoading}
                onClick={(event) => {
                  event.preventDefault();
                  void handleDeleteWorkspace(false);
                }}
                className="shell-action mt-0 border-destructive/80 bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleteLoading ? 'Working…' : 'Delete'}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
