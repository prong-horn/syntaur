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
  '/assignments',
  '/servers',
  '/inventories',
  '/schedules',
  '/usage',
  '/agent-sessions',
  '/playbooks',
  '/memories',
  '/resources',
  '/todos',
  '/views',
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
  let normalized = normalizePathname(pathname);

  // Strip /w/:workspace prefix to match base sections
  const wsMatch = normalized.match(/^\/w\/[^/]+(\/.*)?$/);
  if (wsMatch) {
    normalized = wsMatch[1] || '/';
  }

  if (normalized === '/') {
    return '/';
  }

  if (normalized.startsWith('/archive')) {
    return '/archive';
  }

  if (normalized.startsWith('/projects')) {
    if (/^\/projects\/[^/]+\/assignments\//.test(normalized)) {
      return '/assignments';
    }
    return '/projects';
  }

  if (normalized.startsWith('/assignments')) {
    return '/assignments';
  }

  if (normalized.startsWith('/servers')) {
    return '/servers';
  }

  if (normalized.startsWith('/inventories')) {
    return '/inventories';
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

  if (normalized.startsWith('/memories')) {
    return '/memories';
  }

  if (normalized.startsWith('/resources')) {
    return '/resources';
  }

  if (normalized.startsWith('/todos')) {
    return '/todos';
  }

  if (normalized.startsWith('/views')) {
    return '/views';
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
  let parts = normalized.split('/').filter(Boolean);
  const breadcrumbs: Breadcrumb[] = [];
  let title = 'Overview';
  let projectSlug: string | null = null;

  // Extract workspace prefix if present
  let workspacePrefix = '';
  if (parts[0] === 'w' && parts[1]) {
    workspacePrefix = `/w/${parts[1]}`;
    breadcrumbs.push({ label: toTitleCase(parts[1]), path: `${workspacePrefix}/projects` });
    parts = parts.slice(2); // Remove 'w' and workspace name
  }

  if (parts.length === 0) {
    return { title, breadcrumbs, projectSlug };
  }

  if (parts[0] === 'projects') {
    breadcrumbs.push({ label: 'Projects', path: `${workspacePrefix}/projects` });
    title = 'Projects';

    if (parts[1]) {
      projectSlug = parts[1];
      breadcrumbs.push({ label: toTitleCase(parts[1]), path: `${workspacePrefix}/projects/${parts[1]}` });
      title = toTitleCase(parts[1]);
    }

    if (parts[2] === 'edit') {
      title = 'Edit Project';
    } else if (parts[2] === 'create' && parts[3] === 'assignment') {
      title = 'Create Assignment';
    } else if (parts[2] === 'assignments' && parts[3]) {
      breadcrumbs.push({
        label: toTitleCase(parts[3]),
        path: `${workspacePrefix}/projects/${parts[1]}/assignments/${parts[3]}`,
      });
      title = toTitleCase(parts[3]);

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
    } else if ((parts[2] === 'memories' || parts[2] === 'resources') && parts[3]) {
      const sectionLabel = parts[2] === 'memories' ? 'Memories' : 'Resources';
      const sectionRoot = parts[2] === 'memories' ? '/memories' : '/resources';
      breadcrumbs.push({ label: sectionLabel, path: sectionRoot });
      breadcrumbs.push({
        label: toTitleCase(parts[3]),
        path: `${workspacePrefix}/projects/${parts[1]}/${parts[2]}/${parts[3]}`,
      });
      title = toTitleCase(parts[3]);
      if (parts[4] === 'edit') {
        title = parts[2] === 'memories' ? 'Edit Memory' : 'Edit Resource';
      }
    }
  } else if (parts[0] === 'servers') {
    title = 'Servers';
    breadcrumbs.push({ label: 'Servers', path: `${workspacePrefix}/servers` });
  } else if (parts[0] === 'inventories') {
    title = 'Inventories';
    breadcrumbs.push({ label: 'Inventories', path: `${workspacePrefix}/inventories` });
  } else if (parts[0] === 'usage') {
    title = 'Usage';
    breadcrumbs.push({ label: 'Usage', path: `${workspacePrefix}/usage` });
  } else if (parts[0] === 'agent-sessions') {
    title = 'Agent Sessions';
    breadcrumbs.push({ label: 'Agent Sessions', path: `${workspacePrefix}/agent-sessions` });
  } else if (parts[0] === 'assignments') {
    title = 'Assignments';
    breadcrumbs.push({ label: 'Assignments', path: `${workspacePrefix}/assignments` });
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
  } else if (parts[0] === 'memories') {
    breadcrumbs.push({ label: 'Memories', path: '/memories' });
    title = 'Memories';
    if (parts[1] === 'new') {
      title = 'New Memory';
    }
  } else if (parts[0] === 'resources') {
    breadcrumbs.push({ label: 'Resources', path: '/resources' });
    title = 'Resources';
    if (parts[1] === 'new') {
      title = 'New Resource';
    }
  } else if (parts[0] === 'todos') {
    title = 'Todos';
    breadcrumbs.push({ label: 'Todos', path: `${workspacePrefix}/todos` });
  } else if (parts[0] === 'views') {
    title = 'Saved Views';
    breadcrumbs.push({ label: 'Saved Views', path: `${workspacePrefix}/views` });
    if (parts[1]) {
      // /views/:id — the detail page sets its own title from the view name.
      title = 'View';
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
    breadcrumbs.push({ label: 'Create Project', path: `${workspacePrefix}/create/project` });
  }

  return { title, breadcrumbs, projectSlug };
}
