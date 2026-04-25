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
  '/projects',
  '/assignments',
  '/servers',
  '/agent-sessions',
  '/playbooks',
  '/todos',
  '/attention',
  '/help',
  '/settings',
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

  if (normalized.startsWith('/agent-sessions')) {
    return '/agent-sessions';
  }

  if (normalized.startsWith('/playbooks')) {
    return '/playbooks';
  }

  if (normalized.startsWith('/todos')) {
    return '/todos';
  }

  if (normalized.startsWith('/attention')) {
    return '/attention';
  }

  if (normalized.startsWith('/help')) {
    return '/help';
  }

  if (normalized.startsWith('/settings')) {
    return '/settings';
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
    }
  } else if (parts[0] === 'servers') {
    title = 'Servers';
    breadcrumbs.push({ label: 'Servers', path: `${workspacePrefix}/servers` });
  } else if (parts[0] === 'agent-sessions') {
    title = 'Agent Sessions';
    breadcrumbs.push({ label: 'Agent Sessions', path: `${workspacePrefix}/agent-sessions` });
  } else if (parts[0] === 'attention') {
    title = 'Attention';
    breadcrumbs.push({ label: 'Attention', path: '/attention' });
  } else if (parts[0] === 'assignments') {
    title = 'Assignments';
    breadcrumbs.push({ label: 'Assignments', path: `${workspacePrefix}/assignments` });
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
  } else if (parts[0] === 'todos') {
    title = 'Todos';
    breadcrumbs.push({ label: 'Todos', path: `${workspacePrefix}/todos` });
  } else if (parts[0] === 'help') {
    title = 'Help';
    breadcrumbs.push({ label: 'Help', path: '/help' });
  } else if (parts[0] === 'settings') {
    title = 'Settings';
    breadcrumbs.push({ label: 'Settings', path: '/settings' });
  } else if (parts[0] === 'create' && parts[1] === 'project') {
    title = 'Create Project';
    breadcrumbs.push({ label: 'Create Project', path: `${workspacePrefix}/create/project` });
  }

  return { title, breadcrumbs, projectSlug };
}
