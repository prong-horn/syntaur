export type LibrarySection = 'playbooks' | 'agents' | 'templates';

export type LibraryView =
  | { section: 'playbooks'; view: 'list' }
  | { section: 'playbooks'; view: 'create' }
  | { section: 'playbooks'; view: 'detail'; slug: string }
  | { section: 'playbooks'; view: 'edit'; slug: string }
  | { section: 'agents'; view: 'list' }
  | { section: 'agents'; view: 'create' }
  | { section: 'agents'; view: 'edit'; agentId: string }
  | { section: 'templates'; view: 'list' }
  | { section: 'templates'; view: 'detail'; templateId: string };

const LIBRARY_PREFIX = '/library';

/** Parse canonical `/library/...` paths (Task6 wires all nested routes here). */
export function parseLibraryPath(pathname: string): LibraryView {
  const path = pathname.replace(/\/+$/, '') || LIBRARY_PREFIX;
  if (!path.startsWith(LIBRARY_PREFIX)) {
    return { section: 'playbooks', view: 'list' };
  }
  const rest = path.slice(LIBRARY_PREFIX.length).replace(/^\//, '');
  const segments = rest ? rest.split('/') : [];

  if (segments.length === 0 || segments[0] === 'playbooks') {
    if (segments.length <= 1) return { section: 'playbooks', view: 'list' };
    if (segments[1] === 'create') return { section: 'playbooks', view: 'create' };
    if (segments.length >= 3 && segments[2] === 'edit') {
      return { section: 'playbooks', view: 'edit', slug: segments[1] };
    }
    return { section: 'playbooks', view: 'detail', slug: segments[1] };
  }

  if (segments[0] === 'agents') {
    if (segments.length === 1) return { section: 'agents', view: 'list' };
    if (segments[1] === 'new') return { section: 'agents', view: 'create' };
    if (segments.length >= 3 && segments[2] === 'edit') {
      return { section: 'agents', view: 'edit', agentId: segments[1] };
    }
    return { section: 'agents', view: 'list' };
  }

  if (segments[0] === 'templates') {
    if (segments.length === 1) return { section: 'templates', view: 'list' };
    return { section: 'templates', view: 'detail', templateId: segments[1] };
  }

  return { section: 'playbooks', view: 'list' };
}

/** Legacy `/playbooks`, `/agents`, etc. paths for compatibility wrappers. */
export function parseLegacyLibraryPath(pathname: string): LibraryView | null {
  const path = pathname.replace(/\/+$/, '');
  if (path === '/playbooks' || path === '/playbooks/') return { section: 'playbooks', view: 'list' };
  if (path === '/playbooks/create') return { section: 'playbooks', view: 'create' };
  const playbookDetail = /^\/playbooks\/([^/]+)$/.exec(path);
  if (playbookDetail) return { section: 'playbooks', view: 'detail', slug: playbookDetail[1] };
  const playbookEdit = /^\/playbooks\/([^/]+)\/edit$/.exec(path);
  if (playbookEdit) return { section: 'playbooks', view: 'edit', slug: playbookEdit[1] };
  if (path === '/agents') return { section: 'agents', view: 'list' };
  if (path === '/agents/new') return { section: 'agents', view: 'create' };
  const agentEdit = /^\/agents\/([^/]+)\/edit$/.exec(path);
  if (agentEdit) return { section: 'agents', view: 'edit', agentId: agentEdit[1] };
  return null;
}

export function libraryBasePath(section: LibrarySection): string {
  return `${LIBRARY_PREFIX}/${section}`;
}
