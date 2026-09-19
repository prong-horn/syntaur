/**
 * Table-driven legacy route → canonical six-page-family redirects.
 * Preserves relevant query parameters and all hashes; path identity params win
 * over conflicting query values.
 */

export interface LegacyRedirect {
  pathname: string;
  search: string;
  hash: string;
}

export interface LegacyRouteMatch {
  /** When non-null, navigate here with replace semantics. */
  destination: string | null;
}

const USAGE_KEY_MAP: Record<string, string> = {
  window: 'usageWindow',
  since: 'usageSince',
  until: 'usageUntil',
  project: 'usageProject',
  model: 'usageModel',
  tool: 'usageTool',
  groupBy: 'usageGroupBy',
};

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

function encodeSeg(value: string): string {
  return encodeURIComponent(value);
}

/** Strip `/w/:workspace` prefix and resolve the remainder once. */
export function stripWorkspacePrefix(pathname: string): string {
  const parts = splitPath(pathname);
  if (parts[0] === 'w' && parts.length >= 2) {
    const rest = parts.slice(2).join('/');
    return rest ? `/${rest}` : '/';
  }
  return pathname || '/';
}

function translateUsageSearch(search: string): string {
  const params = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    const mapped = USAGE_KEY_MAP[key];
    if (mapped) out.set(mapped, value);
    else out.set(key, value);
  }
  out.set('panel', 'usage');
  return out.toString();
}

function preserveTicketSearch(search: string, hash: string): string {
  const params = new URLSearchParams(search);
  return `${params.toString() ? `?${params}` : ''}${hash}`;
}

function boardSearchFromTickets(search: string): string {
  const params = new URLSearchParams(search);
  return params.toString() ? `?${params}` : '';
}

function projectTabToPanel(tab: string | null): string | null {
  if (!tab || tab === 'overview' || tab === 'workflow') return 'project';
  if (tab === 'dependencies') return 'dependencies';
  if (tab === 'tickets') return null;
  return 'project';
}

/**
 * Resolve a legacy pathname (+ search/hash) to a canonical destination path,
 * or `null` when the path is already canonical / unknown.
 */
export function resolveLegacyRoute(
  pathname: string,
  search = '',
  hash = '',
): LegacyRouteMatch {
  const stripped = stripWorkspacePrefix(pathname);
  const parts = splitPath(stripped);

  if (parts.length === 0) {
    return { destination: `/inbox${preserveTicketSearch(search, hash)}` };
  }

  const [head, ...rest] = parts;

  if (head === 'tickets') {
    return { destination: `/board${boardSearchFromTickets(search)}${hash}` };
  }

  if (head === 'archive') {
    const params = new URLSearchParams(search);
    params.set('projectVisibility', 'archived');
    params.set('panel', 'projects');
    const qs = params.toString();
    return { destination: `/board${qs ? `?${qs}` : ''}${hash}` };
  }

  if (head === 'projects') {
    if (rest.length === 0) {
      const params = new URLSearchParams(search);
      params.delete('view');
      params.set('panel', 'projects');
      const qs = params.toString();
      return { destination: `/board${qs ? `?${qs}` : ''}${hash}` };
    }

    const slug = rest[0];
    if (rest[1] === 'edit') {
      const params = new URLSearchParams(search);
      params.set('project', slug);
      params.set('dialog', 'edit-project');
      const qs = params.toString();
      return { destination: `/board${qs ? `?${qs}` : ''}${hash}` };
    }

    if (rest[1] === 'new') {
      const params = new URLSearchParams(search);
      params.set('project', slug);
      params.set('dialog', 'new-ticket');
      const qs = params.toString();
      return { destination: `/board${qs ? `?${qs}` : ''}${hash}` };
    }

    const tab = new URLSearchParams(search).get('tab');
    const params = new URLSearchParams(search);
    params.delete('tab');
    params.set('project', slug);
    const panel = projectTabToPanel(tab);
    if (panel) params.set('panel', panel);
    const qs = params.toString();
    return { destination: `/board${qs ? `?${qs}` : ''}${hash}` };
  }

  if (head === 'create' && rest[0] === 'project') {
    const params = new URLSearchParams(search);
    params.set('dialog', 'new-project');
    const qs = params.toString();
    return { destination: `/board${qs ? `?${qs}` : ''}${hash}` };
  }

  if (head === 'agent-sessions') {
    const params = new URLSearchParams(search);
    if (rest[0]) params.set('session', rest[0]);
    const qs = params.toString();
    return { destination: `/sessions${qs ? `?${qs}` : ''}${hash}` };
  }

  if (head === 'usage') {
    const qs = translateUsageSearch(search);
    return { destination: `/sessions${qs ? `?${qs}` : ''}${hash}` };
  }

  if (head === 'agents') {
    if (rest.length === 0) {
      return { destination: `/library/agents${preserveTicketSearch(search, hash)}` };
    }
    if (rest[0] === 'new') {
      return { destination: `/library/agents/new${preserveTicketSearch(search, hash)}` };
    }
    if (rest[1] === 'edit') {
      return { destination: `/library/agents/${encodeSeg(rest[0])}/edit${preserveTicketSearch(search, hash)}` };
    }
    return { destination: null };
  }

  if (head === 'playbooks') {
    if (rest.length === 0) {
      return { destination: `/library/playbooks${preserveTicketSearch(search, hash)}` };
    }
    if (rest[0] === 'create') {
      return { destination: `/library/playbooks/create${preserveTicketSearch(search, hash)}` };
    }
    if (rest[1] === 'edit') {
      return { destination: `/library/playbooks/${encodeSeg(rest[0])}/edit${preserveTicketSearch(search, hash)}` };
    }
    return { destination: `/library/playbooks/${encodeSeg(rest[0])}${preserveTicketSearch(search, hash)}` };
  }

  if (head === 'help') {
    const params = new URLSearchParams(search);
    params.set('section', 'readme');
    const qs = params.toString();
    return { destination: `/settings${qs ? `?${qs}` : ''}${hash}` };
  }

  if (head === 't' && rest.length >= 2) {
    const id = rest[0];
    if (rest[1] === 'edit') {
      const params = new URLSearchParams(search);
      params.set('edit', 'ticket');
      const qs = params.toString();
      return { destination: `/t/${encodeSeg(id)}${qs ? `?${qs}` : ''}${hash}` };
    }
    if (rest[1] === 'plan' && rest[2] === 'edit') {
      const params = new URLSearchParams(search);
      params.set('edit', 'plan');
      return { destination: `/t/${encodeSeg(id)}?${params}${hash}` };
    }
    if (rest[1] === 'scratchpad' && rest[2] === 'edit') {
      const params = new URLSearchParams(search);
      params.set('edit', 'scratchpad');
      return { destination: `/t/${encodeSeg(id)}?${params}${hash}` };
    }
  }

  return { destination: null };
}

/** Ordered legacy route patterns for tests and integrator documentation. */
export const LEGACY_ROUTE_TABLE: ReadonlyArray<{
  pattern: string;
  destination: string;
  notes?: string;
}> = [
  { pattern: '/', destination: '/inbox' },
  { pattern: '/tickets', destination: '/board', notes: 'preserve query filters' },
  { pattern: '/projects', destination: '/board?panel=projects' },
  { pattern: '/projects/:slug', destination: '/board?project=:slug&panel=project' },
  { pattern: '/projects/:slug?tab=tickets', destination: '/board?project=:slug' },
  { pattern: '/projects/:slug?tab=dependencies', destination: '/board?project=:slug&panel=dependencies' },
  { pattern: '/projects/:slug/edit', destination: '/board?project=:slug&dialog=edit-project' },
  { pattern: '/projects/:slug/new', destination: '/board?project=:slug&dialog=new-ticket' },
  { pattern: '/create/project', destination: '/board?dialog=new-project' },
  { pattern: '/archive', destination: '/board?projectVisibility=archived&panel=projects' },
  { pattern: '/agent-sessions', destination: '/sessions' },
  { pattern: '/agent-sessions/:id', destination: '/sessions?session=:id' },
  { pattern: '/usage', destination: '/sessions?panel=usage', notes: 'usage query keys namespaced' },
  { pattern: '/agents', destination: '/library/agents' },
  { pattern: '/agents/new', destination: '/library/agents/new' },
  { pattern: '/agents/:id/edit', destination: '/library/agents/:id/edit' },
  { pattern: '/playbooks', destination: '/library/playbooks' },
  { pattern: '/playbooks/create', destination: '/library/playbooks/create' },
  { pattern: '/playbooks/:slug', destination: '/library/playbooks/:slug' },
  { pattern: '/playbooks/:slug/edit', destination: '/library/playbooks/:slug/edit' },
  { pattern: '/t/:id/edit', destination: '/t/:id?edit=ticket' },
  { pattern: '/t/:id/plan/edit', destination: '/t/:id?edit=plan' },
  { pattern: '/t/:id/scratchpad/edit', destination: '/t/:id?edit=scratchpad' },
  { pattern: '/help', destination: '/settings?section=readme' },
  { pattern: '/w/:workspace/*', destination: 'strip prefix then resolve once' },
];
