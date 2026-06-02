import { Command } from 'commander';
import {
  readSavedViewsFile,
  writeSavedViewsFile,
  createSavedView,
  updateSavedView,
  deleteSavedView,
  type SavedView,
  type UpdateSavedViewPatch,
} from '../utils/saved-views.js';
import {
  isSavedViewConfig,
  isTableColumnId,
  TABLE_COLUMN_IDS,
  type TableColumnId,
} from '../utils/saved-views-schema.js';
import {
  VIEW_MODES,
  SORT_FIELDS,
  SORT_DIRECTIONS,
  ACTIVITIES,
  DATE_RANGE_FIELDS,
  DATE_RANGE_PRESETS,
  isDateRange,
  type Activity,
  type DateRangeFilter,
} from '../utils/view-prefs-schema.js';
import {
  DEFAULT_CREATE_VIEW_STATE,
  captureCurrentView,
  mergeUpdatedConfig,
  type CaptureInput,
} from '../utils/saved-view-builder.js';

// Mutable copy of the `state` arg captureCurrentView consumes (visibility lives here,
// NOT on CreateViewBuilderState).
type ViewState = CaptureInput['state'];

interface ViewFlagOptions {
  name?: string;
  workspace?: string;
  global?: boolean;
  viewMode?: string;
  sortField?: string;
  sortDirection?: string;
  status?: string;
  type?: string;
  priority?: string;
  assignee?: string;
  projectFilter?: string;
  tags?: string;
  activity?: string;
  dateRangeField?: string;
  dateRangePreset?: string;
  dateFrom?: string;
  dateTo?: string;
  clearDateRange?: boolean;
  search?: string;
  collapsed?: string;
  kanbanHidden?: string;
  tableHidden?: string;
  json?: boolean;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(error: unknown): never {
  console.error('Error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

// Visibility maps are set-like in the dashboard (toggles). The CLI dedupes so
// `--table-hidden status,status` matches the UI shape. (Filter fields dedupe via
// toFilterValues already; visibility bypasses that path.)
function parseSet(value?: string): string[] {
  return [...new Set(parseList(value))];
}

function validateEnum<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Invalid ${flag} "${value}". Valid: ${allowed.join(', ')}`);
  }
  return value as T;
}

// Name parity with the API's validateCreateBody/validateUpdateBody: non-empty after
// trim AND raw length <= 200; persisted trimmed.
function validateName(name: string): string {
  if (name.trim().length === 0 || name.length > 200) {
    throw new Error('name must be a non-empty string up to 200 characters');
  }
  return name.trim();
}

// `--workspace` sets a string scope; `--global` forces null. Mutually exclusive.
// `provided` distinguishes "leave as-is" (update) from "set" — for add the value
// is used directly (default null).
function resolveWorkspaceFlag(opts: ViewFlagOptions): { provided: boolean; value: string | null } {
  if (opts.workspace !== undefined && opts.global) {
    throw new Error('--workspace and --global are mutually exclusive');
  }
  if (opts.global) return { provided: true, value: null };
  if (opts.workspace !== undefined) {
    if (opts.workspace.length === 0) {
      throw new Error('--workspace must be a non-empty string (use --global for a global view)');
    }
    return { provided: true, value: opts.workspace };
  }
  return { provided: false, value: null };
}

function buildDateRange(opts: ViewFlagOptions): DateRangeFilter | undefined {
  const anyDate =
    opts.dateRangeField !== undefined ||
    opts.dateRangePreset !== undefined ||
    opts.dateFrom !== undefined ||
    opts.dateTo !== undefined;
  if (!anyDate) return undefined;
  if (opts.dateRangeField === undefined) {
    throw new Error(`--date-range-field is required with date-range flags (${DATE_RANGE_FIELDS.join('|')})`);
  }
  const field = validateEnum(opts.dateRangeField, DATE_RANGE_FIELDS, '--date-range-field');
  const hasPreset = opts.dateRangePreset !== undefined;
  const hasAbsolute = opts.dateFrom !== undefined || opts.dateTo !== undefined;
  if (hasPreset && hasAbsolute) {
    throw new Error('--date-range-preset is mutually exclusive with --date-from/--date-to');
  }
  if (!hasPreset && !hasAbsolute) {
    throw new Error('provide --date-range-preset OR --date-from/--date-to alongside --date-range-field');
  }
  const dr: DateRangeFilter = { field };
  if (hasPreset) {
    dr.preset = validateEnum(opts.dateRangePreset!, DATE_RANGE_PRESETS, '--date-range-preset');
  } else {
    if (opts.dateFrom !== undefined) {
      if (!YMD_RE.test(opts.dateFrom)) throw new Error('--date-from must be YYYY-MM-DD');
      dr.from = opts.dateFrom;
    }
    if (opts.dateTo !== undefined) {
      if (!YMD_RE.test(opts.dateTo)) throw new Error('--date-to must be YYYY-MM-DD');
      dr.to = opts.dateTo;
    }
  }
  if (!isDateRange(dr)) throw new Error('invalid date range');
  return dr;
}

// True if any config-affecting flag was supplied (drives whether `update` builds a
// config patch at all).
function hasConfigFlag(opts: ViewFlagOptions): boolean {
  return (
    opts.viewMode !== undefined ||
    opts.sortField !== undefined ||
    opts.sortDirection !== undefined ||
    opts.status !== undefined ||
    opts.type !== undefined ||
    opts.priority !== undefined ||
    opts.assignee !== undefined ||
    opts.projectFilter !== undefined ||
    opts.tags !== undefined ||
    opts.activity !== undefined ||
    opts.search !== undefined ||
    opts.dateRangeField !== undefined ||
    opts.dateRangePreset !== undefined ||
    opts.dateFrom !== undefined ||
    opts.dateTo !== undefined ||
    opts.clearDateRange === true ||
    opts.collapsed !== undefined ||
    opts.kanbanHidden !== undefined ||
    opts.tableHidden !== undefined
  );
}

function emptyVisibilityState(): Pick<
  ViewState,
  'listSectionVisibility' | 'kanbanColumnVisibility' | 'tableColumnVisibility'
> {
  return {
    listSectionVisibility: { collapsed: [] },
    kanbanColumnVisibility: { hidden: [] },
    tableColumnVisibility: { hidden: [] },
  };
}

function baseStateForAdd(): ViewState {
  return {
    viewMode: DEFAULT_CREATE_VIEW_STATE.viewMode,
    filters: { ...DEFAULT_CREATE_VIEW_STATE.filters },
    sortField: DEFAULT_CREATE_VIEW_STATE.sortField,
    sortDirection: DEFAULT_CREATE_VIEW_STATE.sortDirection,
    ...emptyVisibilityState(),
  };
}

function baseStateFromConfig(config: SavedView['config']): ViewState {
  return {
    viewMode: config.viewMode,
    filters: { ...config.filters },
    sortField: config.sortField,
    sortDirection: config.sortDirection,
    listSectionVisibility: { collapsed: [...config.listSectionVisibility.collapsed] },
    kanbanColumnVisibility: { hidden: [...config.kanbanColumnVisibility.hidden] },
    tableColumnVisibility: { hidden: [...config.tableColumnVisibility.hidden] },
  };
}

// Apply provided flags onto a mutable state. Filters set to 'all'/'' minimize away
// (clearing); --clear-date-range removes dateRange. Normalization happens later in
// captureCurrentView.
function applyFlagsToState(state: ViewState, opts: ViewFlagOptions): void {
  if (opts.viewMode !== undefined) state.viewMode = validateEnum(opts.viewMode, VIEW_MODES, '--view-mode');
  if (opts.sortField !== undefined) state.sortField = validateEnum(opts.sortField, SORT_FIELDS, '--sort-field');
  if (opts.sortDirection !== undefined) {
    state.sortDirection = validateEnum(opts.sortDirection, SORT_DIRECTIONS, '--sort-direction');
  }
  if (opts.status !== undefined) state.filters.status = parseList(opts.status);
  if (opts.type !== undefined) state.filters.type = parseList(opts.type);
  if (opts.priority !== undefined) state.filters.priority = parseList(opts.priority);
  if (opts.assignee !== undefined) state.filters.assignee = parseList(opts.assignee);
  if (opts.projectFilter !== undefined) state.filters.project = parseList(opts.projectFilter);
  if (opts.tags !== undefined) state.filters.tags = parseList(opts.tags);
  if (opts.activity !== undefined) {
    state.filters.activity = validateEnum<Activity>(opts.activity, ACTIVITIES, '--activity');
  }
  if (opts.search !== undefined) state.filters.search = opts.search;
  if (opts.clearDateRange) {
    if (
      opts.dateRangeField !== undefined ||
      opts.dateRangePreset !== undefined ||
      opts.dateFrom !== undefined ||
      opts.dateTo !== undefined
    ) {
      throw new Error('--clear-date-range cannot be combined with other date-range flags');
    }
    delete state.filters.dateRange;
  } else {
    const dr = buildDateRange(opts);
    if (dr !== undefined) state.filters.dateRange = dr;
  }
  if (opts.collapsed !== undefined) state.listSectionVisibility = { collapsed: parseSet(opts.collapsed) };
  if (opts.kanbanHidden !== undefined) state.kanbanColumnVisibility = { hidden: parseSet(opts.kanbanHidden) };
  if (opts.tableHidden !== undefined) {
    const ids = parseSet(opts.tableHidden);
    for (const id of ids) {
      if (!isTableColumnId(id)) {
        throw new Error(`Invalid --table-hidden "${id}". Valid: ${TABLE_COLUMN_IDS.join(', ')}`);
      }
    }
    state.tableColumnVisibility = { hidden: ids as TableColumnId[] };
  }
}

export async function runViewsAdd(opts: ViewFlagOptions): Promise<SavedView> {
  if (opts.name === undefined) throw new Error('--name is required');
  const name = validateName(opts.name);
  const { value: workspace } = resolveWorkspaceFlag(opts);
  const state = baseStateForAdd();
  applyFlagsToState(state, opts);
  const { config } = captureCurrentView({ name, context: { workspace, projectSlug: null }, state });
  if (!isSavedViewConfig(config)) throw new Error('assembled an invalid SavedViewConfig');
  const file = await readSavedViewsFile();
  const { file: next, view } = createSavedView(file, { name, workspace, config });
  await writeSavedViewsFile(next);
  return view;
}

export async function runViewsList(opts: { json?: boolean }): Promise<void> {
  const file = await readSavedViewsFile();
  if (opts.json) {
    console.log(JSON.stringify(file.views, null, 2));
    return;
  }
  if (file.views.length === 0) {
    console.log('No saved views.');
    return;
  }
  for (const v of file.views) {
    console.log(`${v.id}  ${v.name}  [${v.workspace ?? 'global'}]  ${v.config.viewMode}`);
  }
}

export async function runViewsShow(id: string, opts: { json?: boolean }): Promise<void> {
  const file = await readSavedViewsFile();
  const view = file.views.find((v) => v.id === id);
  if (!view) throw new Error('view-not-found');
  if (opts.json) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  console.log(`id:        ${view.id}`);
  console.log(`name:      ${view.name}`);
  console.log(`workspace: ${view.workspace ?? 'global'}`);
  console.log(`created:   ${view.createdAt}`);
  console.log(`updated:   ${view.updatedAt}`);
  console.log('config:');
  console.log(JSON.stringify(view.config, null, 2));
}

export async function runViewsUpdate(id: string, opts: ViewFlagOptions): Promise<SavedView> {
  const file = await readSavedViewsFile();
  const existing = file.views.find((v) => v.id === id);
  if (!existing) throw new Error('view-not-found');

  const patch: UpdateSavedViewPatch = {};
  if (opts.name !== undefined) patch.name = validateName(opts.name);
  const ws = resolveWorkspaceFlag(opts);
  if (ws.provided) patch.workspace = ws.value;
  if (hasConfigFlag(opts)) {
    const state = baseStateFromConfig(existing.config);
    applyFlagsToState(state, opts);
    const built = captureCurrentView({ name: '', context: { workspace: null, projectSlug: null }, state }).config;
    // mergeUpdatedConfig re-attaches forward-compat unknown top-level + filter keys
    // that minimizeFilters dropped — same path every dashboard update uses.
    const merged = mergeUpdatedConfig(existing.config, built, {
      listSectionVisibility: state.listSectionVisibility,
      kanbanColumnVisibility: state.kanbanColumnVisibility,
      tableColumnVisibility: state.tableColumnVisibility,
    });
    if (!isSavedViewConfig(merged)) throw new Error('assembled an invalid SavedViewConfig');
    patch.config = merged;
  }

  if (Object.keys(patch).length === 0) {
    throw new Error('patch must include at least one of name, workspace, or config');
  }
  const result = updateSavedView(file, id, patch);
  if ('error' in result) throw new Error('view-not-found');
  await writeSavedViewsFile(result.file);
  return result.view;
}

export async function runViewsDelete(id: string): Promise<void> {
  const file = await readSavedViewsFile();
  const result = deleteSavedView(file, id);
  if (!result.deleted) throw new Error('view-not-found');
  await writeSavedViewsFile(result.file);
}

// Attach the shared config flag set (used by `add` and `update`).
function addConfigFlags(cmd: Command): Command {
  return cmd
    .option('--workspace <ws>', 'Scope the view to a workspace (default: global)')
    .option('--global', 'Make the view global (workspace = null)')
    .option('--view-mode <mode>', `View mode (${VIEW_MODES.join('|')})`)
    .option('--sort-field <field>', `Sort field (${SORT_FIELDS.join('|')})`)
    .option('--sort-direction <dir>', `Sort direction (${SORT_DIRECTIONS.join('|')})`)
    .option('--status <vals>', 'Status filter, comma-separated ("all"/"" clears)')
    .option('--type <vals>', 'Type filter, comma-separated ("all"/"" clears)')
    .option('--priority <vals>', 'Priority filter, comma-separated ("all"/"" clears)')
    .option('--assignee <vals>', 'Assignee filter, comma-separated ("all"/"" clears)')
    .option('--project-filter <vals>', 'Project filter, comma-separated ("all"/"" clears)')
    .option('--tags <vals>', 'Tags filter, comma-separated ("all"/"" clears)')
    .option('--activity <val>', `Activity filter (${ACTIVITIES.join('|')}; "all" clears)`)
    .option('--date-range-field <field>', `Date range field (${DATE_RANGE_FIELDS.join('|')})`)
    .option('--date-range-preset <preset>', `Date range preset (${DATE_RANGE_PRESETS.join('|')})`)
    .option('--date-from <YYYY-MM-DD>', 'Date range start (exclusive with --date-range-preset)')
    .option('--date-to <YYYY-MM-DD>', 'Date range end (exclusive with --date-range-preset)')
    .option('--clear-date-range', 'Remove the date-range filter')
    .option('--search <text>', 'Search text filter ("" clears)')
    .option('--collapsed <vals>', 'List-view collapsed section ids, comma-separated')
    .option('--kanban-hidden <vals>', 'Kanban hidden column ids, comma-separated')
    .option('--table-hidden <vals>', `Table hidden column ids (${TABLE_COLUMN_IDS.join('|')}), comma-separated`)
    .option('--json', 'Output the resulting view as JSON');
}

export const viewsCommand = new Command('views').description(
  'Manage saved views (~/.syntaur/saved-views.json)',
);

addConfigFlags(
  viewsCommand.command('add').description('Create a saved view').requiredOption('--name <name>', 'View name (1–200 chars)'),
).action(async (opts: ViewFlagOptions) => {
  try {
    const view = await runViewsAdd(opts);
    if (opts.json) console.log(JSON.stringify(view, null, 2));
    else console.log(`Created view ${view.id} ("${view.name}")`);
  } catch (error) {
    fail(error);
  }
});

viewsCommand
  .command('list')
  .description('List saved views')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    try {
      await runViewsList(opts);
    } catch (error) {
      fail(error);
    }
  });

viewsCommand
  .command('show')
  .description('Show one saved view by id')
  .argument('<id>', 'Saved view id')
  .option('--json', 'Output as JSON')
  .action(async (id: string, opts: { json?: boolean }) => {
    try {
      await runViewsShow(id, opts);
    } catch (error) {
      fail(error);
    }
  });

addConfigFlags(
  viewsCommand
    .command('update')
    .description('Update a saved view by id')
    .argument('<id>', 'Saved view id')
    .option('--name <name>', 'New view name (1–200 chars)'),
).action(async (id: string, opts: ViewFlagOptions) => {
  try {
    const view = await runViewsUpdate(id, opts);
    if (opts.json) console.log(JSON.stringify(view, null, 2));
    else console.log(`Updated view ${view.id}`);
  } catch (error) {
    fail(error);
  }
});

viewsCommand
  .command('delete')
  .description('Delete a saved view by id')
  .argument('<id>', 'Saved view id')
  .action(async (id: string) => {
    try {
      await runViewsDelete(id);
      console.log(`Deleted view ${id}`);
    } catch (error) {
      fail(error);
    }
  });
