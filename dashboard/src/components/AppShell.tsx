import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Inbox, KanbanSquare, Library, Settings, X } from 'lucide-react';
import { SidebarNav, type SidebarNavItem } from './SidebarNav';
import { SidebarProjects } from './SidebarProjects';
import { TopBar } from './TopBar';
import { useInbox } from '../hooks/useInbox';
import { useInboxWindow } from '../hooks/useInboxWindow';
import { useChatAgents } from '../hooks/useChatAgents';
import { useInboxNotifications } from '../hooks/useInboxNotifications';

interface Breadcrumb {
  label: string;
  path: string;
}

interface AppShellProps {
  title: string;
  breadcrumbs: Breadcrumb[];
  projectSlug: string | null;
  children: ReactNode;
}

const NAV_ITEMS: SidebarNavItem[] = [
  { to: '/inbox', label: 'Needs me', icon: Inbox },
  { to: '/board', label: 'Board', icon: KanbanSquare },
  { to: '/sessions', label: 'Sessions', icon: BookOpen },
  { to: '/library/playbooks', label: 'Library', icon: Library },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function AppShell({
  title,
  breadcrumbs,
  projectSlug,
  children,
}: AppShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { maxAgeDays } = useInboxWindow();
  const {
    total: inboxTotal,
    items: inboxItems,
    loading: inboxLoading,
    error: inboxError,
  } = useInbox({ maxAgeDays });
  const { data: chatAgents } = useChatAgents();
  useInboxNotifications({
    items: inboxItems,
    loading: inboxLoading,
    error: inboxError,
    agents: chatAgents?.agents ?? [],
  });

  useEffect(() => {
    if (!mobileNavOpen) return;
    function onKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileNavOpen(false);
    }
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  }, [mobileNavOpen]);

  const navItems = NAV_ITEMS.map((item) =>
    item.to === '/inbox' ? { ...item, badge: inboxTotal } : item,
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="relative grid min-h-screen lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="hidden max-h-screen sticky top-0 overflow-y-auto border-r border-border/70 bg-sidebar px-4 py-4 lg:flex lg:flex-col">
          <ShellSidebar items={navItems} />
        </aside>

        {mobileNavOpen ? (
          <div role="dialog" aria-modal="true" aria-label="Navigation" data-state="open" className="fixed inset-0 z-40 bg-overlay/40 lg:hidden">
            <div className="flex h-full max-w-xs flex-col border-r border-border/70 bg-sidebar p-4 shadow-2xl">
              <div className="mb-4 flex shrink-0 items-center justify-between">
                <Link to="/inbox" className="text-lg font-semibold text-foreground" onClick={() => setMobileNavOpen(false)}>
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
              <div className="min-h-0 flex-1">
                <ShellSidebar items={navItems} onNavigate={() => setMobileNavOpen(false)} />
              </div>
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
  items,
  onNavigate,
}: {
  items: SidebarNavItem[];
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="shrink-0">
        <Link to="/inbox" className="inline-flex items-center gap-3" onClick={onNavigate}>
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

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <SidebarNav items={items} onNavigate={onNavigate} />
        <SidebarProjects onNavigate={onNavigate} />
      </div>
    </div>
  );
}
