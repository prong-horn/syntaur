import { Outlet, useLocation } from 'react-router-dom';
import { AppShell } from './AppShell';
import { buildShellMeta } from '../lib/routes';

export function Layout() {
  const location = useLocation();
  const { title, breadcrumbs, projectSlug } = buildShellMeta(location.pathname);

  return (
    <AppShell title={title} breadcrumbs={breadcrumbs} projectSlug={projectSlug}>
      <Outlet />
    </AppShell>
  );
}
