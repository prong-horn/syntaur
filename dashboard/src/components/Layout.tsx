import { Outlet, Link, useLocation } from 'react-router-dom';

export function Layout() {
  const location = useLocation();
  const breadcrumbs = buildBreadcrumbs(location.pathname);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-4">
          <Link to="/" className="text-lg font-semibold text-foreground hover:text-primary">
            Syntaur
          </Link>
          {breadcrumbs.length > 0 && (
            <nav className="flex items-center gap-1 text-sm text-muted-foreground">
              {breadcrumbs.map((crumb, i) => (
                <span key={crumb.path} className="flex items-center gap-1">
                  <span>/</span>
                  {i === breadcrumbs.length - 1 ? (
                    <span className="text-foreground">{crumb.label}</span>
                  ) : (
                    <Link to={crumb.path} className="hover:text-foreground">
                      {crumb.label}
                    </Link>
                  )}
                </span>
              ))}
            </nav>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}

interface Breadcrumb {
  label: string;
  path: string;
}

function buildBreadcrumbs(pathname: string): Breadcrumb[] {
  const parts = pathname.split('/').filter(Boolean);
  const crumbs: Breadcrumb[] = [];

  // /missions/:slug
  if (parts[0] === 'missions' && parts[1]) {
    crumbs.push({ label: parts[1], path: `/missions/${parts[1]}` });
  }

  // /missions/:slug/assignments/:aslug
  if (parts[0] === 'missions' && parts[2] === 'assignments' && parts[3]) {
    crumbs.push({
      label: parts[3],
      path: `/missions/${parts[1]}/assignments/${parts[3]}`,
    });
  }

  return crumbs;
}
