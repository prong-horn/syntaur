import type { ProjectSummary, AssignmentBoardItem, ExternalIdInfo } from '../hooks/useProjects';
import type { PlaybookSummary, TrackedSession, TodoItem } from '../types';

export type PaletteEntryType = 'project' | 'assignment' | 'playbook' | 'server' | 'todo' | 'page';

export interface PaletteEntry {
  type: PaletteEntryType;
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
  route: string;
  // AQL filter facts read by PALETTE_FIELDS (the entry IS the QueryItem the gate
  // evaluates). Optional: entities lacking a field are correctly excluded by an
  // atom referencing it. `assignmentType` is the assignment's frontmatter `type`,
  // kept distinct from `type` (the entity kind, target of the `a:`/`p:`/… aliases).
  status?: string;
  tags?: string[];
  assignee?: string | null;
  assignmentType?: string | null;
  project?: string | null;
  externalIds?: ExternalIdInfo[];
}

// R2: only these routes have workspace-prefixed variants in App.tsx.
export const WORKSPACE_CAPABLE_ROUTES = new Set<string>([
  '/projects',
  '/assignments',
  '/servers',
  '/todos',
]);

export function resolveRoute(basePath: string, wsPrefix: string): string {
  return WORKSPACE_CAPABLE_ROUTES.has(basePath) ? `${wsPrefix}${basePath}` : basePath;
}

export const STATIC_PAGES = [
  { id: 'page-overview',    title: 'Overview',    basePath: '/',            keywords: ['home', 'dashboard'] },
  { id: 'page-projects',    title: 'Projects',    basePath: '/projects',    keywords: [] },
  { id: 'page-assignments', title: 'Assignments', basePath: '/assignments', keywords: [] },
  { id: 'page-todos',       title: 'Todos',       basePath: '/todos',       keywords: ['tasks'] },
  { id: 'page-servers',     title: 'Servers',     basePath: '/servers',     keywords: ['sessions'] },
  { id: 'page-playbooks',   title: 'Playbooks',   basePath: '/playbooks',   keywords: [] },
  { id: 'page-memories',    title: 'Memories',    basePath: '/memories',    keywords: ['knowledge', 'learnings'] },
  { id: 'page-resources',   title: 'Resources',   basePath: '/resources',   keywords: ['knowledge', 'reference'] },
  { id: 'page-workflow',    title: 'Workflow',    basePath: '/workflow',    keywords: ['statuses', 'transitions', 'derive', 'facts'] },
  { id: 'page-settings',    title: 'Settings',    basePath: '/settings',    keywords: [] },
  { id: 'page-help',        title: 'Help',        basePath: '/help',        keywords: ['shortcuts'] },
] as const;

interface BuildInput {
  projects?: ProjectSummary[];
  assignments?: AssignmentBoardItem[];
  playbooks?: PlaybookSummary[];
  servers?: TrackedSession[];
  todos?: Array<TodoItem & { workspace?: string }>;
  wsPrefix: string;
  /**
   * Fold external IDs into the index + carry the `externalIds` fact on entries.
   * When false, both are dropped — which makes the `externalid:`/`jira:` haystack
   * accessors (in paletteQuery.ts) return '' so those atoms (and bare-ID fuzzy
   * hits) match nothing. Defaults to true (omitted === enabled).
   */
  externalIds?: boolean;
}

/**
 * Flatten external IDs into fuzzy-searchable keywords: each id appears both bare
 * (`PROJ-123`) and system-qualified (`jira:PROJ-123`), so a prefixless query finds
 * the item via the ranker without an AQL atom.
 */
function externalIdKeywords(ids?: ExternalIdInfo[]): string[] {
  if (!ids?.length) return [];
  const out: string[] = [];
  for (const e of ids) {
    if (!e.id) continue;
    out.push(e.id);
    if (e.system) out.push(`${e.system}:${e.id}`);
  }
  return out;
}

export function buildIndex(input: BuildInput): PaletteEntry[] {
  const out: PaletteEntry[] = [];

  // External-ID gating (default on). When off, drop both the fuzzy keywords and
  // the `externalIds` entry fact so `externalid:`/`jira:`/bare-ID all match nothing.
  const indexExternalIds = input.externalIds !== false;
  const idKeywords = (ids?: ExternalIdInfo[]): string[] =>
    indexExternalIds ? externalIdKeywords(ids) : [];
  const idField = (ids?: ExternalIdInfo[]): ExternalIdInfo[] | undefined =>
    indexExternalIds ? ids : undefined;

  for (const p of STATIC_PAGES) {
    out.push({
      type: 'page',
      id: p.id,
      title: p.title,
      keywords: [...p.keywords],
      route: resolveRoute(p.basePath, input.wsPrefix),
    });
  }

  for (const m of input.projects ?? []) {
    // Projects keep their own workspace; the route uses the project's workspace, not current prefix.
    const projectWs = m.workspace ? `/w/${m.workspace}` : '';
    out.push({
      type: 'project',
      id: `project-${m.slug}`,
      title: m.title,
      subtitle: m.slug,
      keywords: [...(m.tags ?? []), ...idKeywords(m.externalIds)],
      route: `${projectWs}/projects/${m.slug}`,
      tags: m.tags,
      project: m.slug,
      externalIds: idField(m.externalIds),
    });
    out.push({
      type: 'todo',
      id: `project-todos-${m.slug}`,
      title: `${m.title} todos`,
      subtitle: `${m.slug} · project`,
      keywords: [...(m.tags ?? []), 'project', 'todos'],
      route: `${projectWs}/projects/${m.slug}?tab=todos`,
    });
  }

  for (const a of input.assignments ?? []) {
    const assignWs = a.projectWorkspace ? `/w/${a.projectWorkspace}` : '';
    out.push({
      type: 'assignment',
      id: a.projectSlug === null ? `assignment-standalone-${a.id}` : `assignment-${a.projectSlug}-${a.slug}`,
      title: a.title,
      subtitle: `${a.projectTitle} \u00B7 ${a.status}`,
      keywords: [a.projectSlug ?? 'standalone', a.assignee ?? '', ...idKeywords(a.externalIds)].filter(
        (s): s is string => Boolean(s),
      ),
      route: a.projectSlug === null
        ? `/assignments/${a.id}`
        : `${assignWs}/projects/${a.projectSlug}/assignments/${a.slug}`,
      status: a.status,
      tags: a.tags,
      assignee: a.assignee,
      assignmentType: a.type,
      project: a.projectSlug,
      externalIds: idField(a.externalIds),
    });
  }

  for (const p of input.playbooks ?? []) {
    out.push({
      type: 'playbook',
      id: `playbook-${p.slug}`,
      title: p.name,
      subtitle: p.description,
      keywords: p.tags,
      route: `/playbooks/${p.slug}`,
      tags: p.tags,
    });
  }

  for (const s of input.servers ?? []) {
    out.push({
      type: 'server',
      id: `server-${s.name}`,
      title: s.name,
      subtitle: s.alive ? 'alive' : 'dead',
      route: `${resolveRoute('/servers', input.wsPrefix)}#server-${encodeURIComponent(s.name)}`,
    });
  }

  for (const t of input.todos ?? []) {
    // If the todo came from a specific workspace, route there; else use the current wsPrefix.
    const todoWs = t.workspace && t.workspace !== '_ungrouped' ? `/w/${t.workspace}` : input.wsPrefix;
    const base = resolveRoute('/todos', todoWs);
    out.push({
      type: 'todo',
      id: `todo-${t.id}`,
      title: t.description,
      subtitle: t.status,
      keywords: t.tags,
      route: `${base}?focus=${encodeURIComponent(t.id)}`,
      status: t.status,
      tags: t.tags,
    });
  }

  return out;
}
