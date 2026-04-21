import type { ProjectSummary, AssignmentBoardItem } from '../hooks/useProjects';
import type { PlaybookSummary, TrackedSession, TodoItem } from '../types';

export type PaletteEntryType = 'project' | 'assignment' | 'playbook' | 'server' | 'todo' | 'page';

export interface PaletteEntry {
  type: PaletteEntryType;
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
  route: string;
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
  { id: 'page-attention',   title: 'Attention',   basePath: '/attention',   keywords: ['alerts'] },
  { id: 'page-playbooks',   title: 'Playbooks',   basePath: '/playbooks',   keywords: [] },
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
}

export function buildIndex(input: BuildInput): PaletteEntry[] {
  const out: PaletteEntry[] = [];

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
      keywords: m.tags,
      route: `${projectWs}/projects/${m.slug}`,
    });
  }

  for (const a of input.assignments ?? []) {
    const assignWs = a.projectWorkspace ? `/w/${a.projectWorkspace}` : '';
    out.push({
      type: 'assignment',
      id: a.projectSlug === null ? `assignment-standalone-${a.id}` : `assignment-${a.projectSlug}-${a.slug}`,
      title: a.title,
      subtitle: `${a.projectTitle} \u00B7 ${a.status}`,
      keywords: [a.projectSlug ?? 'standalone', a.assignee ?? ''].filter((s): s is string => Boolean(s)),
      route: a.projectSlug === null
        ? `/assignments/${a.id}`
        : `${assignWs}/projects/${a.projectSlug}/assignments/${a.slug}`,
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
    });
  }

  return out;
}
