import { Outlet, useLocation, useParams } from 'react-router-dom';
import { AppShell } from './AppShell';
import { buildShellMeta } from '../lib/routes';

export function Layout() {
  const location = useLocation();
  const { workspace } = useParams<{ workspace?: string }>();
  const { title, breadcrumbs, projectSlug } = buildShellMeta(location.pathname);

  return (
    <AppShell title={title} breadcrumbs={breadcrumbs} projectSlug={projectSlug} workspace={workspace ?? null}>
      <Outlet />
    </AppShell>
  );
}
