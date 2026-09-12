import type { ProjectSummary, TicketBoardItem, ExternalIdInfo } from '../hooks/useProjects';
import type { PlaybookSummary } from '../types';
import type { ContentHit, ContentMatchRange } from '../hooks/useContentSearch';

export type PaletteEntryType =
  | 'project'
  | 'ticket'
  | 'playbook'
  | 'page'
  | 'content';

export interface PaletteEntry {
  type: PaletteEntryType;
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
  route: string;
  status?: string;
  tags?: string[];
  assignee?: string | null;
  ticketType?: string | null;
  project?: string | null;
  externalIds?: ExternalIdInfo[];
  snippet?: string;
  snippetMatches?: ContentMatchRange[];
}

export const STATIC_PAGES = [
  { id: 'page-overview',    title: 'Overview',    basePath: '/',            keywords: ['home', 'dashboard'] },
  { id: 'page-projects',    title: 'Projects',    basePath: '/projects',    keywords: [] },
  { id: 'page-tickets', title: 'Tickets', basePath: '/tickets', keywords: [] },
  { id: 'page-agent-sessions', title: 'Agent Sessions', basePath: '/agent-sessions', keywords: ['sessions', 'runs', 'claude', 'codex'] },
  { id: 'page-playbooks',   title: 'Playbooks',   basePath: '/playbooks',   keywords: [] },
  { id: 'page-workflow',    title: 'Workflow',    basePath: '/workflow',    keywords: ['statuses', 'transitions', 'derive', 'facts'] },
  { id: 'page-settings',    title: 'Settings',    basePath: '/settings',    keywords: [] },
  { id: 'page-help',        title: 'Help',        basePath: '/help',        keywords: ['shortcuts'] },
] as const;

interface BuildInput {
  projects?: ProjectSummary[];
  tickets?: TicketBoardItem[];
  playbooks?: PlaybookSummary[];
  externalIds?: boolean;
}

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
      route: p.basePath,
    });
  }

  for (const m of input.projects ?? []) {
    out.push({
      type: 'project',
      id: `project-${m.slug}`,
      title: m.title,
      subtitle: m.slug,
      keywords: [...(m.tags ?? []), ...idKeywords(m.externalIds)],
      route: `/projects/${m.slug}`,
      tags: m.tags,
      project: m.slug,
      externalIds: idField(m.externalIds),
    });
  }

  for (const a of input.tickets ?? []) {
    out.push({
      type: 'ticket',
      id: a.projectSlug === null ? `ticket-standalone-${a.id}` : `ticket-${a.projectSlug}-${a.slug}`,
      title: a.title,
      subtitle: `${a.projectTitle} \u00B7 ${a.status}`,
      keywords: [a.projectSlug ?? 'standalone', a.assignee ?? '', ...idKeywords(a.externalIds)].filter(
        (s): s is string => Boolean(s),
      ),
      route: `/t/${a.id}`,
      status: a.status,
      tags: a.tags,
      assignee: a.assignee,
      ticketType: a.type,
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

  return out;
}

export function contentHitsToEntries(hits: ContentHit[]): PaletteEntry[] {
  return hits.map((hit, idx) => ({
    type: 'content' as const,
    id: `content-${hit.path}-${idx}`,
    title: `${hit.ticketSlug ?? ''} › ${hit.section ?? hit.fileKind}`,
    subtitle: hit.projectSlug ?? (hit.standalone ? 'standalone' : undefined),
    route: hit.route,
    project: hit.projectSlug,
    snippet: hit.snippet,
    snippetMatches: hit.matches,
  }));
}
