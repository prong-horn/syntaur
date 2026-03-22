import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Compass, FolderKanban, LifeBuoy, ListTodo, Monitor, X } from 'lucide-react';
import { SidebarNav, type SidebarNavItem } from './SidebarNav';
import { TopBar } from './TopBar';

interface Breadcrumb {
  label: string;
  path: string;
}

interface AppShellProps {
  title: string;
  breadcrumbs: Breadcrumb[];
  missionSlug: string | null;
  children: ReactNode;
}

const NAV_ITEMS: SidebarNavItem[] = [
  { to: '/', label: 'Overview', icon: Compass },
  { to: '/missions', label: 'Missions', icon: FolderKanban },
  { to: '/assignments', label: 'Assignments', icon: ListTodo },
  { to: '/servers', label: 'Servers', icon: Monitor },
  { to: '/attention', label: 'Attention', icon: AlertTriangle },
  { to: '/help', label: 'Help', icon: LifeBuoy },
];

export function AppShell({
  title,
  breadcrumbs,
  missionSlug,
  children,
}: AppShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <div className="relative grid min-h-screen lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="hidden border-r border-border/70 bg-sidebar/90 px-4 py-4 backdrop-blur lg:flex lg:flex-col">
          <ShellSidebar />
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
              <SidebarNav items={NAV_ITEMS} onNavigate={() => setMobileNavOpen(false)} />
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

function ShellSidebar() {
  return (
    <div className="flex h-full flex-col gap-5">
      <div className="space-y-3">
        <Link to="/" className="inline-flex items-center gap-3">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-foreground text-sm font-semibold text-background shadow-sm">
            S
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">Syntaur</p>
            <p className="text-xs text-muted-foreground/60">Local-first mission control</p>
          </div>
        </Link>
      </div>

      <SidebarNav items={NAV_ITEMS} />

      <div className="mt-auto rounded-lg border border-border/60 bg-background/80 p-3">
        <p className="text-sm font-semibold text-foreground">Source-first dashboard</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Mission and assignment markdown files stay authoritative. Derived files are read-only projections.
        </p>
      </div>
    </div>
  );
}
