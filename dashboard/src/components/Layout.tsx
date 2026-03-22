import { Outlet, useLocation } from 'react-router-dom';
import { AppShell } from './AppShell';

interface Breadcrumb {
  label: string;
  path: string;
}

export function Layout() {
  const location = useLocation();
  const { title, breadcrumbs, missionSlug } = buildShellMeta(location.pathname);

  return (
    <AppShell title={title} breadcrumbs={breadcrumbs} missionSlug={missionSlug}>
      <Outlet />
    </AppShell>
  );
}

function buildShellMeta(pathname: string): {
  title: string;
  breadcrumbs: Breadcrumb[];
  missionSlug: string | null;
} {
  const parts = pathname.split('/').filter(Boolean);
  const breadcrumbs: Breadcrumb[] = [];
  let title = 'Overview';
  let missionSlug: string | null = null;

  if (parts.length === 0) {
    return { title, breadcrumbs, missionSlug };
  }

  if (parts[0] === 'missions') {
    breadcrumbs.push({ label: 'Missions', path: '/missions' });
    title = 'Missions';

    if (parts[1]) {
      missionSlug = parts[1];
      breadcrumbs.push({ label: parts[1], path: `/missions/${parts[1]}` });
      title = parts[1];
    }

    if (parts[2] === 'edit') {
      title = 'Edit Mission';
    } else if (parts[2] === 'create' && parts[3] === 'assignment') {
      title = 'Create Assignment';
    } else if (parts[2] === 'assignments' && parts[3]) {
      breadcrumbs.push({
        label: parts[3],
        path: `/missions/${parts[1]}/assignments/${parts[3]}`,
      });
      title = parts[3];

      if (parts[4] === 'edit') {
        title = 'Edit Assignment';
      } else if (parts[4] === 'plan' && parts[5] === 'edit') {
        title = 'Edit Plan';
      } else if (parts[4] === 'scratchpad' && parts[5] === 'edit') {
        title = 'Edit Scratchpad';
      } else if (parts[4] === 'handoff' && parts[5] === 'edit') {
        title = 'Append Handoff';
      } else if (parts[4] === 'decision-record' && parts[5] === 'edit') {
        title = 'Append Decision';
      }
    }
  } else if (parts[0] === 'servers') {
    title = 'Servers';
    breadcrumbs.push({ label: 'Servers', path: '/servers' });
  } else if (parts[0] === 'attention') {
    title = 'Attention';
    breadcrumbs.push({ label: 'Attention', path: '/attention' });
  } else if (parts[0] === 'assignments') {
    title = 'Assignments';
    breadcrumbs.push({ label: 'Assignments', path: '/assignments' });
  } else if (parts[0] === 'help') {
    title = 'Help';
    breadcrumbs.push({ label: 'Help', path: '/help' });
  } else if (parts[0] === 'create' && parts[1] === 'mission') {
    title = 'Create Mission';
    breadcrumbs.push({ label: 'Create Mission', path: '/create/mission' });
  }

  return { title, breadcrumbs, missionSlug };
}
