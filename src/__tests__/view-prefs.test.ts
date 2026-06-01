import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  applyViewPrefsPatch,
  isViewPrefsDefaults,
  mergePatch,
  readViewPrefsFile,
  resetViewPrefsFile,
  writeViewPrefsFile,
} from '../utils/view-prefs.js';
import {
  DEFAULT_VIEW_PREFS_FILE,
  mergeForScope,
  type ViewPrefsFile,
} from '../utils/view-prefs-schema.js';

describe('view-prefs storage', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;
  let prefsPath: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-view-prefs-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
    prefsPath = resolve(homeDir, '.syntaur', 'view-prefs.json');
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    vi.restoreAllMocks();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('(a) returns defaults when the file is missing', async () => {
    const file = await readViewPrefsFile();
    expect(file).toEqual(DEFAULT_VIEW_PREFS_FILE);
    expect(isViewPrefsDefaults(file)).toBe(true);
  });

  it('(b) round-trips through write/read', async () => {
    const next: ViewPrefsFile = {
      version: 1,
      global: {
        ...DEFAULT_VIEW_PREFS_FILE.global,
        defaultView: 'table',
        sortField: 'priority',
        sortDirection: 'asc',
        density: 'compact',
      },
      projects: {
        'syntaur-meta': { defaultView: 'list', sortField: 'title' },
      },
    };
    await writeViewPrefsFile(next);
    const read = await readViewPrefsFile();
    expect(read).toEqual(next);
  });

  it('(c) mergeForScope overlays projects[scope] field-by-field over global', async () => {
    const file: ViewPrefsFile = {
      version: 1,
      global: {
        ...DEFAULT_VIEW_PREFS_FILE.global,
        defaultView: 'kanban',
        sortField: 'updated',
        density: 'comfortable',
        filters: { status: 'all', priority: 'high', assignee: 'all', project: 'all', activity: 'all' },
      },
      projects: {
        foo: { defaultView: 'table', filters: { status: 'in_progress' } },
      },
    };
    const effective = mergeForScope(file, 'foo');
    expect(effective.defaultView).toBe('table');
    expect(effective.sortField).toBe('updated');
    // density always inherits from global (ProjectViewPrefs omits density)
    expect(effective.density).toBe('comfortable');
    // filters deep-merge: status from override, priority inherited from global
    expect(effective.filters.status).toBe('in_progress');
    expect(effective.filters.priority).toBe('high');
    // unknown scope returns pure global
    expect(mergeForScope(file, 'bar')).toEqual(file.global);
    // null scope returns global
    expect(mergeForScope(file, null)).toEqual(file.global);
  });

  it('(d) mergePatch deep-merges filters on global', () => {
    const current: ViewPrefsFile = {
      version: 1,
      global: {
        ...DEFAULT_VIEW_PREFS_FILE.global,
        filters: { status: 'in_progress', priority: 'high', assignee: 'alice', project: 'all', activity: 'all' },
      },
      projects: {},
    };
    const next = mergePatch(current, { global: { filters: { status: 'all' } } });
    expect(next.global.filters.status).toBe('all');
    expect(next.global.filters.priority).toBe('high'); // preserved
    expect(next.global.filters.assignee).toBe('alice'); // preserved
  });

  it('(e) mergePatch deep-merges per-scope filters and preserves siblings', () => {
    const current: ViewPrefsFile = {
      version: 1,
      global: { ...DEFAULT_VIEW_PREFS_FILE.global },
      projects: {
        foo: { filters: { status: 'in_progress', priority: 'high' }, defaultView: 'table' },
      },
    };
    const next = mergePatch(current, { projects: { foo: { filters: { status: 'all' } } } });
    expect(next.projects.foo.filters?.status).toBe('all');
    expect(next.projects.foo.filters?.priority).toBe('high'); // preserved
    expect(next.projects.foo.defaultView).toBe('table'); // preserved sibling field
  });

  it('(e2) mergePatch round-trips a filters.type patch without disturbing siblings', () => {
    const current: ViewPrefsFile = {
      version: 1,
      global: {
        ...DEFAULT_VIEW_PREFS_FILE.global,
        filters: { status: 'in_progress', priority: 'high', type: 'all', assignee: 'all', project: 'all', activity: 'all' },
      },
      projects: {},
    };
    const next = mergePatch(current, { global: { filters: { type: 'bug' } } });
    expect(next.global.filters.type).toBe('bug');
    expect(next.global.filters.status).toBe('in_progress'); // preserved
    expect(next.global.filters.priority).toBe('high'); // preserved (the deep-merge proof)
  });

  it('(e3) stale v1 prefs missing filters.type read cleanly — additive field is forward-compat', () => {
    // Simulate a view-prefs.json written before filters.type existed: the
    // schema's deep-merge should accept it, and downstream consumers fall back
    // to 'all' via `?? 'all'`. This test pins mergeForScope() tolerance.
    const stale: ViewPrefsFile = {
      version: 1,
      global: {
        ...DEFAULT_VIEW_PREFS_FILE.global,
        // Manually omit `type` from the filters block (cast to bypass shape check on the literal).
        filters: { status: 'all', priority: 'all', assignee: 'all', project: 'all', activity: 'all' } as ViewPrefsFile['global']['filters'],
      },
      projects: { foo: { filters: { status: 'in_progress' } } },
    };
    const effective = mergeForScope(stale, 'foo');
    expect(effective.filters.type).toBeUndefined();
    // Consumers must treat undefined as 'all' — exercise that contract here:
    expect(effective.filters.type ?? 'all').toBe('all');
    expect(effective.filters.status).toBe('in_progress');
  });

  it('(e4) readViewPrefsFile tolerates a v1 on-disk file missing filters.type', async () => {
    // Disk-level regression for the stale-prefs case: write a JSON file shaped
    // like a v1 prefs file authored before `type` existed in filters, and confirm
    // readViewPrefsFile returns it without throwing or marking the file corrupt.
    const stalePayload = {
      version: 1,
      global: {
        defaultView: 'kanban',
        sortField: 'updated',
        sortDirection: 'desc',
        density: 'comfortable',
        grouping: 'none',
        filters: { status: 'all', priority: 'all', assignee: 'all', project: 'all', activity: 'all' },
      },
      projects: {},
    };
    await writeFile(prefsPath, JSON.stringify(stalePayload));
    const result = await readViewPrefsFile();
    expect(result.version).toBe(1);
    expect(result.global.filters.type).toBeUndefined();
    // No corrupt-backup written:
    const entries = await readdir(resolve(homeDir, '.syntaur'));
    expect(entries.filter((e) => e.startsWith('view-prefs.corrupt-')).length).toBe(0);
  });

  it('(f0) missing version field is treated as v1 (forward-compat with files written without one)', async () => {
    const file = {
      global: {
        ...DEFAULT_VIEW_PREFS_FILE.global,
        defaultView: 'table' as const,
      },
      projects: {},
    };
    await writeFile(prefsPath, JSON.stringify(file));
    const result = await readViewPrefsFile();
    expect(result.version).toBe(1);
    expect(result.global.defaultView).toBe('table');
    // file is NOT renamed
    const entries = await readdir(resolve(homeDir, '.syntaur'));
    expect(entries.filter((e) => e.startsWith('view-prefs.corrupt-')).length).toBe(0);
  });

  it('(f) unknown future version returns defaults without renaming the file', async () => {
    await writeFile(prefsPath, JSON.stringify({ version: 99, global: {}, projects: {} }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = await readViewPrefsFile();
    expect(file).toEqual(DEFAULT_VIEW_PREFS_FILE);
    // file is left intact (forward-compat policy)
    const entries = await readdir(resolve(homeDir, '.syntaur'));
    expect(entries.filter((e) => e.startsWith('view-prefs.corrupt-')).length).toBe(0);
    expect(entries).toContain('view-prefs.json');
    warn.mockRestore();
  });

  it('(g) malformed JSON is renamed to view-prefs.corrupt-* and defaults are returned', async () => {
    await writeFile(prefsPath, 'not json at all');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = await readViewPrefsFile();
    expect(file).toEqual(DEFAULT_VIEW_PREFS_FILE);
    const entries = await readdir(resolve(homeDir, '.syntaur'));
    const corruptFiles = entries.filter((e) => e.startsWith('view-prefs.corrupt-'));
    expect(corruptFiles.length).toBe(1);
    // original file no longer exists at the canonical path
    expect(entries).not.toContain('view-prefs.json');
    // backup retains the bad contents
    const backup = await readFile(resolve(homeDir, '.syntaur', corruptFiles[0]!), 'utf-8');
    expect(backup).toBe('not json at all');
    warn.mockRestore();
  });

  it('(g2) shape-mismatched JSON is also renamed', async () => {
    await writeFile(prefsPath, JSON.stringify({ version: 1, global: 'oops', projects: {} }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await readViewPrefsFile();
    const entries = await readdir(resolve(homeDir, '.syntaur'));
    expect(entries.filter((e) => e.startsWith('view-prefs.corrupt-')).length).toBe(1);
    warn.mockRestore();
  });

  it('(h) resetViewPrefsFile deletes the file', async () => {
    await writeViewPrefsFile({
      ...DEFAULT_VIEW_PREFS_FILE,
      global: { ...DEFAULT_VIEW_PREFS_FILE.global, defaultView: 'table' },
    });
    await resetViewPrefsFile();
    const entries = await readdir(resolve(homeDir, '.syntaur'));
    expect(entries).not.toContain('view-prefs.json');
    // subsequent read returns defaults
    expect(await readViewPrefsFile()).toEqual(DEFAULT_VIEW_PREFS_FILE);
  });

  it('applyViewPrefsPatch round-trip combines read + merge + write', async () => {
    const result = await applyViewPrefsPatch({
      global: { defaultView: 'table', filters: { status: 'in_progress' } },
      projects: { foo: { defaultView: 'list' } },
    });
    expect(result.global.defaultView).toBe('table');
    expect(result.global.filters.status).toBe('in_progress');
    // unmentioned filters preserved from defaults
    expect(result.global.filters.priority).toBe('all');
    expect(result.projects.foo.defaultView).toBe('list');

    // round-trip persists
    const reread = await readViewPrefsFile();
    expect(reread).toEqual(result);

    // further patch keeps the first values
    const second = await applyViewPrefsPatch({ projects: { foo: { sortField: 'priority' } } });
    expect(second.projects.foo.defaultView).toBe('list'); // preserved
    expect(second.projects.foo.sortField).toBe('priority'); // new
  });

  it('isViewPrefsDefaults returns true for defaults and false for any deviation', () => {
    expect(isViewPrefsDefaults(DEFAULT_VIEW_PREFS_FILE)).toBe(true);
    expect(
      isViewPrefsDefaults({
        ...DEFAULT_VIEW_PREFS_FILE,
        global: { ...DEFAULT_VIEW_PREFS_FILE.global, defaultView: 'table' },
      }),
    ).toBe(false);
    expect(
      isViewPrefsDefaults({ ...DEFAULT_VIEW_PREFS_FILE, projects: { foo: {} } }),
    ).toBe(false);
  });

  it('isViewPrefsDefaults compares NORMALIZED filter semantics (arrays)', () => {
    const withFilters = (filters: Record<string, unknown>): ViewPrefsFile => ({
      ...DEFAULT_VIEW_PREFS_FILE,
      global: {
        ...DEFAULT_VIEW_PREFS_FILE.global,
        filters: { ...DEFAULT_VIEW_PREFS_FILE.global.filters, ...filters } as ViewPrefsFile['global']['filters'],
      },
    });
    // Empty array / 'all' / absent are all semantically default.
    expect(isViewPrefsDefaults(withFilters({ status: [] }))).toBe(true);
    expect(isViewPrefsDefaults(withFilters({ status: 'all' }))).toBe(true);
    expect(isViewPrefsDefaults(withFilters({ status: ['all'] }))).toBe(true);
    // A populated array is custom.
    expect(isViewPrefsDefaults(withFilters({ status: ['in_progress'] }))).toBe(false);
    expect(isViewPrefsDefaults(withFilters({ priority: ['high', 'critical'] }))).toBe(false);
    expect(isViewPrefsDefaults(withFilters({ activity: 'stale' }))).toBe(false);
    // `tags` is persisted to view-prefs too, so it must factor into the custom flag.
    expect(isViewPrefsDefaults(withFilters({ tags: [] }))).toBe(true);
    expect(isViewPrefsDefaults(withFilters({ tags: ['backend'] }))).toBe(false);
  });

  it('mergePatch overwrites a prior array with an explicit [] clear', () => {
    const current: ViewPrefsFile = {
      ...DEFAULT_VIEW_PREFS_FILE,
      global: {
        ...DEFAULT_VIEW_PREFS_FILE.global,
        filters: { ...DEFAULT_VIEW_PREFS_FILE.global.filters, status: ['in_progress', 'review'] },
      },
    };
    const next = mergePatch(current, { global: { filters: { status: [] } } });
    expect(next.global.filters.status).toEqual([]);
    expect(isViewPrefsDefaults(next)).toBe(true);
  });

  it('round-trips multi-value array filters through write/read', async () => {
    const next: ViewPrefsFile = {
      ...DEFAULT_VIEW_PREFS_FILE,
      global: {
        ...DEFAULT_VIEW_PREFS_FILE.global,
        filters: { ...DEFAULT_VIEW_PREFS_FILE.global.filters, status: ['in_progress', 'review'], priority: ['high'] },
      },
    };
    await writeViewPrefsFile(next);
    const read = await readViewPrefsFile();
    expect(read.global.filters.status).toEqual(['in_progress', 'review']);
    expect(read.global.filters.priority).toEqual(['high']);
  });
});
