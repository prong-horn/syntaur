import { toTitleCase } from './format';

/** SPA path for a ticket detail page (`/t/:id`). */
export function ticketPageHref(id: string, tab?: string): string {
  const base = `/t/${encodeURIComponent(id)}`;
  return tab ? `${base}?tab=${tab}` : base;
}

/** SPA path for a ticket editor query state under `/t/:id`. */
export function ticketEditHref(
  id: string,
  section?: 'plan' | 'scratchpad',
): string {
  const base = `/t/${encodeURIComponent(id)}`;
  if (!section) return `${base}?edit=ticket`;
  return `${base}?edit=${section}`;
}

export interface Breadcrumb {
  label: string;
  path: string;
}

export interface ShellMeta {
  title: string;
  breadcrumbs: Breadcrumb[];
  projectSlug: string | null;
}

/** Primary sidebar destinations (ticket detail is context-only, not a nav item). */
export const SIDEBAR_SECTIONS = [
  '/inbox',
  '/board',
  '/sessions',
  '/library/playbooks',
  '/settings',
] as const;

export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

export function getSidebarSection(pathname: string): SidebarSection | null {
  const normalized = normalizePathname(pathname);

  if (normalized.startsWith('/inbox')) return '/inbox';
  if (normalized.startsWith('/board') || normalized.startsWith('/tickets') || normalized.startsWith('/projects') || normalized.startsWith('/archive')) {
    return '/board';
  }
  if (normalized.startsWith('/sessions') || normalized.startsWith('/usage') || normalized.startsWith('/agent-sessions')) {
    return '/sessions';
  }
  if (normalized.startsWith('/library') || normalized.startsWith('/playbooks') || normalized.startsWith('/agents')) {
    return '/library/playbooks';
  }
  if (normalized.startsWith('/settings') || normalized.startsWith('/help')) return '/settings';
  if (normalized.startsWith('/t/')) return null;

  return null;
}

export function isSidebarItemActive(pathname: string, itemTo: SidebarSection): boolean {
  return getSidebarSection(pathname) === itemTo;
}

export function buildShellMeta(pathname: string): ShellMeta {
  const normalized = normalizePathname(pathname);
  const parts = normalized.split('/').filter(Boolean);
  const breadcrumbs: Breadcrumb[] = [];
  let title = 'Needs me';
  let projectSlug: string | null = null;

  if (parts.length === 0) {
    return { title: 'Needs me', breadcrumbs: [{ label: 'Needs me', path: '/inbox' }], projectSlug };
  }

  const [head, ...rest] = parts;

  if (head === 'inbox') {
    title = 'Needs me';
    breadcrumbs.push({ label: 'Needs me', path: '/inbox' });
  } else if (head === 'board') {
    title = 'Board';
    breadcrumbs.push({ label: 'Board', path: '/board' });
  } else if (head === 'sessions') {
    title = 'Sessions';
    breadcrumbs.push({ label: 'Sessions', path: '/sessions' });
  } else if (head === 'library') {
    breadcrumbs.push({ label: 'Library', path: '/library/playbooks' });
    title = 'Library';
    if (rest[0] === 'playbooks') {
      if (rest[1] === 'create') title = 'Create Playbook';
      else if (rest[2] === 'edit') title = 'Edit Playbook';
      else if (rest[1]) {
        breadcrumbs.push({ label: toTitleCase(rest[1]), path: `/library/playbooks/${rest[1]}` });
        title = toTitleCase(rest[1]);
      } else title = 'Playbooks';
    } else if (rest[0] === 'agents') {
      title = 'Agents';
      if (rest[1] === 'new') title = 'New agent';
      else if (rest[2] === 'edit') title = 'Edit agent';
    } else if (rest[0] === 'templates') {
      title = rest[1] ? 'Template' : 'Templates';
    }
  } else if (head === 'settings') {
    title = 'Settings';
    breadcrumbs.push({ label: 'Settings', path: '/settings' });
  } else if (head === 't' && rest[0]) {
    breadcrumbs.push({ label: 'Board', path: '/board' });
    breadcrumbs.push({ label: rest[0], path: `/t/${rest[0]}` });
    title = rest[0];
  } else if (head === 'tickets' || head === 'projects' || head === 'archive') {
    title = 'Board';
    breadcrumbs.push({ label: 'Board', path: '/board' });
    if (head === 'projects' && rest[0]) {
      projectSlug = rest[0];
      breadcrumbs.push({ label: toTitleCase(rest[0]), path: `/board?project=${encodeURIComponent(rest[0])}` });
      title = toTitleCase(rest[0]);
    }
  } else if (head === 'usage' || head === 'agent-sessions') {
    title = 'Sessions';
    breadcrumbs.push({ label: 'Sessions', path: '/sessions' });
  } else if (head === 'playbooks' || head === 'agents') {
    breadcrumbs.push({ label: 'Library', path: '/library/playbooks' });
    title = head === 'playbooks' ? 'Playbooks' : 'Agents';
  } else if (head === 'help') {
    title = 'Settings';
    breadcrumbs.push({ label: 'Settings', path: '/settings' });
  }

  return { title, breadcrumbs, projectSlug };
}
