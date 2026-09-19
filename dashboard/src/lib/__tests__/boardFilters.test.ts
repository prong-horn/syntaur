import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW_PREFS_FILE } from '@shared/view-prefs-schema';
import {
  deepMergeViewPrefsPreservingProject,
  filterTicketsByProjectSlugs,
  mergeBoardFilters,
} from '../boardFilters';
import { parseBoardUrlParams } from '../boardUrlParams';

describe('boardFilters', () => {
  const file = {
    ...DEFAULT_VIEW_PREFS_FILE,
    global: {
      ...DEFAULT_VIEW_PREFS_FILE.global,
      filters: {
        ...DEFAULT_VIEW_PREFS_FILE.global.filters,
        project: 'saved-only',
        status: 'done',
        tags: 'legacy-tag',
      },
    },
    projects: {
      'p:alpha': {
        filters: { status: ['review'] },
      },
    },
  };

  it('ignores saved project filter but uses other prefs', () => {
    const url = parseBoardUrlParams(new URLSearchParams('project=beta'));
    const effective = mergeBoardFilters({ url, prefsFile: file, urlHasQuery: false });
    expect(effective.project).toEqual(['beta']);
    expect(effective.status).toEqual(['done']);
  });

  it('uses scoped prefs when exactly one URL project matches scope', () => {
    const url = parseBoardUrlParams(new URLSearchParams('project=alpha'));
    const effective = mergeBoardFilters({ url, prefsFile: file, urlHasQuery: false });
    expect(effective.status).toEqual(['review']);
  });

  it('query param is authoritative over chip synthesis', () => {
    const url = parseBoardUrlParams(new URLSearchParams('query=status:done&status=review'));
    const effective = mergeBoardFilters({ url, prefsFile: file, urlHasQuery: true });
    expect(effective.query).toBe('status:done');
  });

  it('deep-merges prefs without touching stored project filter', () => {
    const next = deepMergeViewPrefsPreservingProject(file, null, {
      filters: { status: ['in_progress'], tags: ['new'] },
    });
    expect(next.global.filters.project).toBe('saved-only');
    expect(next.global.filters.status).toEqual(['in_progress']);
    expect(next.global.filters.tags).toEqual(['new']);
  });

  it('filters board items by URL project slugs', () => {
    const items = [
      { projectSlug: 'a', id: '1' },
      { projectSlug: 'b', id: '2' },
      { projectSlug: null, id: '3' },
    ];
    expect(filterTicketsByProjectSlugs(items, []).map((i) => i.id)).toEqual(['1', '2', '3']);
    expect(filterTicketsByProjectSlugs(items, ['a']).map((i) => i.id)).toEqual(['1']);
  });
});
