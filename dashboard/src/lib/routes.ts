import { toTitleCase } from './format';

export interface Breadcrumb {
  label: string;
  path: string;
}

export interface ShellMeta {
  title: string;
  breadcrumbs: Breadcrumb[];
  projectSlug: string | null;
}

const SIDEBAR_SECTIONS = [
  '/',
  '/inbox',
  '/projects',
  '/archive',
  '/tickets',
  '/agents',
  '/usage',
  '/agent-sessions',
  '/playbooks',
  '/help',
  '/settings',
  '/workflow',
] as const;

export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '/';
  }

  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

export function getSidebarSection(pathname: string): SidebarSection | null {
  const normalized = normalizePathname(pathname);

  if (normalized === '/') {
    return '/';
  }

  if (normalized.startsWith('/archive')) {
    return '/archive';
  }

  if (normalized.startsWith('/projects')) {
    if (/^\/projects\/[^/]+\/tickets\//.test(normalized)) {
      return '/tickets';
    }
    return '/projects';
  }

  if (normalized.startsWith('/tickets')) {
    return '/tickets';
  }

  if (normalized.startsWith('/agents')) {
    return '/agents';
  }

  if (normalized.startsWith('/usage')) {
    return '/usage';
  }

  if (normalized.startsWith('/agent-sessions')) {
    return '/agent-sessions';
  }

  if (normalized.startsWith('/playbooks')) {
    return '/playbooks';
  }

  if (normalized.startsWith('/help')) {
    return '/help';
  }

  if (normalized.startsWith('/settings')) {
    return '/settings';
  }

  if (normalized.startsWith('/workflow')) {
    return '/workflow';
  }

  if (normalized.startsWith('/inbox')) {
    return '/inbox';
  }

  return null;
}

export function isSidebarItemActive(pathname: string, itemTo: SidebarSection): boolean {
  return getSidebarSection(pathname) === itemTo;
}

export function buildShellMeta(pathname: string): ShellMeta {
  const normalized = normalizePathname(pathname);
  const parts = normalized.split('/').filter(Boolean);
  const breadcrumbs: Breadcrumb[] = [];
  let title = 'Overview';
  let projectSlug: string | null = null;

  if (parts.length === 0) {
    return { title, breadcrumbs, projectSlug };
  }

  if (parts[0] === 'projects') {
    breadcrumbs.push({ label: 'Projects', path: '/projects' });
    title = 'Projects';

    if (parts[1]) {
      projectSlug = parts[1];
      breadcrumbs.push({ label: toTitleCase(parts[1]), path: `/projects/${parts[1]}` });
      title = toTitleCase(parts[1]);
    }

    if (parts[2] === 'edit') {
      title = 'Edit Project';
    } else if (parts[2] === 'create' && parts[3] === 'ticket') {
      title = 'Create Ticket';
    } else if (parts[2] === 'tickets' && parts[3]) {
      breadcrumbs.push({
        label: toTitleCase(parts[3]),
        path: `/projects/${parts[1]}/tickets/${parts[3]}`,
      });
      title = toTitleCase(parts[3]);

      if (parts[4] === 'edit') {
        title = 'Edit Ticket';
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
  } else if (parts[0] === 'agents') {
    breadcrumbs.push({ label: 'Agents', path: '/agents' });
    title = 'Agents';
    if (parts[1] === 'new') {
      title = 'New agent';
    } else if (parts[1] && parts[2] === 'edit') {
      breadcrumbs.push({ label: parts[1], path: `/agents/${parts[1]}/edit` });
      title = 'Edit agent';
    }
  } else if (parts[0] === 'usage') {
    title = 'Usage';
    breadcrumbs.push({ label: 'Usage', path: '/usage' });
  } else if (parts[0] === 'agent-sessions') {
    title = 'Agent Sessions';
    breadcrumbs.push({ label: 'Agent Sessions', path: '/agent-sessions' });
  } else if (parts[0] === 'tickets') {
    title = 'Tickets';
    breadcrumbs.push({ label: 'Tickets', path: '/tickets' });
  } else if (parts[0] === 'archive') {
    title = 'Archive';
    breadcrumbs.push({ label: 'Archive', path: '/archive' });
  } else if (parts[0] === 'playbooks') {
    breadcrumbs.push({ label: 'Playbooks', path: '/playbooks' });
    title = 'Playbooks';

    if (parts[1] === 'create') {
      title = 'Create Playbook';
    } else if (parts[1] && parts[2] === 'edit') {
      breadcrumbs.push({ label: toTitleCase(parts[1]), path: `/playbooks/${parts[1]}` });
      title = 'Edit Playbook';
    } else if (parts[1]) {
      breadcrumbs.push({ label: toTitleCase(parts[1]), path: `/playbooks/${parts[1]}` });
      title = toTitleCase(parts[1]);
    }
  } else if (parts[0] === 'help') {
    title = 'Help';
    breadcrumbs.push({ label: 'Help', path: '/help' });
  } else if (parts[0] === 'settings') {
    title = 'Settings';
    breadcrumbs.push({ label: 'Settings', path: '/settings' });
  } else if (parts[0] === 'workflow') {
    title = 'Workflow';
    breadcrumbs.push({ label: 'Workflow', path: '/workflow' });
  } else if (parts[0] === 'create' && parts[1] === 'project') {
    title = 'Create Project';
    breadcrumbs.push({ label: 'Create Project', path: '/create/project' });
  }

  return { title, breadcrumbs, projectSlug };
}
