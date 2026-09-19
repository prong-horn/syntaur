/**
 * Parse and serialize Board URL search parameters per SV-12 grammar.
 * Multi-select keys use repeated params; legacy comma-separated status normalizes
 * to repeats. Project filter is URL-only and never touches view-prefs.
 */
import {
  VIEW_MODES,
  type Activity,
  type SortDirection,
  type SortField,
  type ViewMode,
} from '@shared/view-prefs-schema';
import {
  DEFAULT_OLDER_THAN_DAYS,
  normalizeHistoryMode,
  normalizeOlderThanDays,
  type HistoryMode,
} from './boardHistory';

export type ProjectVisibility = 'active' | 'archived' | 'all';
export type BoardPanel = 'projects' | 'project' | 'dependencies';
export type BoardDialog = 'new-ticket' | 'new-project' | 'edit-project';

export interface BoardUrlState {
  view: ViewMode | null;
  status: string[];
  template: string[];
  priority: string[];
  assignee: string[];
  tags: string[];
  /** URL-only project slugs; empty array = all projects. */
  project: string[];
  stale: Activity | null;
  query: string | null;
  sort: SortField | null;
  dir: SortDirection | null;
  history: HistoryMode;
  olderThanDays: number;
  projectVisibility: ProjectVisibility;
  panel: BoardPanel | null;
  dialog: BoardDialog | null;
  /** Explicit empty project key (`?project=`). */
  projectCleared: boolean;
}

const PROJECT_VISIBILITY: readonly ProjectVisibility[] = ['active', 'archived', 'all'];
const BOARD_PANELS: readonly BoardPanel[] = ['projects', 'project', 'dependencies'];
const BOARD_DIALOGS: readonly BoardDialog[] = ['new-ticket', 'new-project', 'edit-project'];

const SORT_FIELDS = new Set<SortField>([
  'title',
  'status',
  'priority',
  'assignee',
  'dependencies',
  'created',
  'updated',
  'started',
  'lastActivity',
  'projectName',
  'agentName',
]);

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (!v || out.includes(v)) continue;
    out.push(v);
  }
  return out;
}

function readRepeated(params: URLSearchParams, key: string): string[] {
  const direct = params.getAll(key);
  if (direct.length > 0) {
    const expanded = direct.flatMap((value) => value.split(','));
    return dedupe(expanded);
  }
  const legacy = params.get(key);
  if (!legacy) return [];
  return dedupe(legacy.split(','));
}

function normalizeActivity(value: string | null): Activity | null {
  if (value === '1') return 'stale';
  if (value === '0') return 'fresh';
  if (value === 'stale' || value === 'fresh') return value;
  return null;
}

function normalizeView(value: string | null): ViewMode | null {
  if (!value) return null;
  return (VIEW_MODES as readonly string[]).includes(value) ? (value as ViewMode) : null;
}

function normalizeSort(value: string | null): SortField | null {
  if (!value) return null;
  return SORT_FIELDS.has(value as SortField) ? (value as SortField) : null;
}

function normalizeDir(value: string | null): SortDirection | null {
  if (value === 'asc' || value === 'desc') return value;
  return null;
}

function normalizeProjectVisibility(value: string | null): ProjectVisibility {
  if (value && (PROJECT_VISIBILITY as readonly string[]).includes(value)) {
    return value as ProjectVisibility;
  }
  return 'active';
}

function normalizePanel(value: string | null): BoardPanel | null {
  if (value && (BOARD_PANELS as readonly string[]).includes(value)) {
    return value as BoardPanel;
  }
  return null;
}

function normalizeDialog(value: string | null): BoardDialog | null {
  if (value && (BOARD_DIALOGS as readonly string[]).includes(value)) {
    return value as BoardDialog;
  }
  return null;
}

export function parseBoardUrlParams(params: URLSearchParams): BoardUrlState {
  const projectKeys = params.getAll('project');
  const projectCleared = params.has('project') && projectKeys.length === 1 && projectKeys[0] === '';

  return {
    view: normalizeView(params.get('view')),
    status: readRepeated(params, 'status'),
    template: readRepeated(params, 'template'),
    priority: readRepeated(params, 'priority'),
    assignee: readRepeated(params, 'assignee'),
    tags: readRepeated(params, 'tags'),
    project: projectCleared ? [] : readRepeated(params, 'project'),
    stale: normalizeActivity(params.get('stale')),
    query: params.has('query') ? params.get('query') ?? '' : null,
    sort: normalizeSort(params.get('sort')),
    dir: normalizeDir(params.get('dir')),
    history: normalizeHistoryMode(params.get('history')),
    olderThanDays: normalizeOlderThanDays(params.get('olderThanDays')),
    projectVisibility: normalizeProjectVisibility(params.get('projectVisibility')),
    panel: normalizePanel(params.get('panel')),
    dialog: normalizeDialog(params.get('dialog')),
    projectCleared,
  };
}

/** Preference scope key: exactly one nonempty URL project slug → `p:<slug>`, else global. */
export function boardPreferenceScope(projectSlugs: readonly string[]): string | null {
  if (projectSlugs.length === 1 && projectSlugs[0]) return `p:${projectSlugs[0]}`;
  return null;
}

export interface SerializeBoardUrlPatch {
  view?: ViewMode | null;
  status?: string[];
  template?: string[];
  priority?: string[];
  assignee?: string[];
  tags?: string[];
  project?: string[] | 'clear';
  stale?: Activity | null;
  query?: string | null;
  sort?: SortField | null;
  dir?: SortDirection | null;
  history?: HistoryMode;
  olderThanDays?: number;
  projectVisibility?: ProjectVisibility;
  panel?: BoardPanel | null;
  dialog?: BoardDialog | null;
}

function setRepeated(out: URLSearchParams, key: string, values: string[] | undefined): void {
  out.delete(key);
  if (!values) return;
  if (values.length === 0) {
    out.append(key, '');
    return;
  }
  for (const v of values) out.append(key, v);
}

function deleteIfDefault(
  out: URLSearchParams,
  key: string,
  value: string | number | null | undefined,
  defaultValue?: string | number,
): void {
  if (value === null || value === undefined || value === '' || value === defaultValue) {
    out.delete(key);
    return;
  }
  out.set(key, String(value));
}

/** Merge a patch into existing search params (omits defaults from the URL). */
export function serializeBoardUrlParams(
  current: URLSearchParams,
  patch: SerializeBoardUrlPatch,
): URLSearchParams {
  const out = new URLSearchParams(current);

  if (patch.view !== undefined) {
    if (!patch.view || patch.view === 'kanban') out.delete('view');
    else out.set('view', patch.view);
  }

  if (patch.status !== undefined) setRepeated(out, 'status', patch.status);
  if (patch.template !== undefined) setRepeated(out, 'template', patch.template);
  if (patch.priority !== undefined) setRepeated(out, 'priority', patch.priority);
  if (patch.assignee !== undefined) setRepeated(out, 'assignee', patch.assignee);
  if (patch.tags !== undefined) setRepeated(out, 'tags', patch.tags);

  if (patch.project !== undefined) {
    if (patch.project === 'clear') setRepeated(out, 'project', []);
    else setRepeated(out, 'project', patch.project);
  }

  if (patch.stale !== undefined) {
    if (!patch.stale || patch.stale === 'all') out.delete('stale');
    else out.set('stale', patch.stale === 'stale' ? '1' : '0');
  }

  if (patch.query !== undefined) {
    if (!patch.query) out.delete('query');
    else out.set('query', patch.query);
  }

  if (patch.sort !== undefined) {
    if (!patch.sort) out.delete('sort');
    else out.set('sort', patch.sort);
  }

  if (patch.dir !== undefined) {
    if (!patch.dir) out.delete('dir');
    else out.set('dir', patch.dir);
  }

  if (patch.history !== undefined) {
    deleteIfDefault(out, 'history', patch.history, 'recent');
  }

  if (patch.olderThanDays !== undefined) {
    deleteIfDefault(out, 'olderThanDays', patch.olderThanDays, DEFAULT_OLDER_THAN_DAYS);
  }

  if (patch.projectVisibility !== undefined) {
    deleteIfDefault(out, 'projectVisibility', patch.projectVisibility, 'active');
  }

  if (patch.panel !== undefined) {
    if (!patch.panel) out.delete('panel');
    else out.set('panel', patch.panel);
  }

  if (patch.dialog !== undefined) {
    if (!patch.dialog) out.delete('dialog');
    else out.set('dialog', patch.dialog);
  }

  return out;
}

export function boardUrlParamsEqual(left: URLSearchParams, right: URLSearchParams): boolean {
  return left.toString() === right.toString();
}
