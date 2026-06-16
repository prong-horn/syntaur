import { describe, it, expect } from 'vitest';
import { buildIndex, type PaletteEntry } from '../paletteIndex';
import { compileQuery, type QueryItem } from '@shared/query';
import { PALETTE_FIELDS } from '../paletteQuery';
import type { ProjectSummary } from '../../hooks/useProjects';

const project = {
  slug: 'acme',
  title: 'Acme',
  workspace: null,
  tags: ['backend'],
  externalIds: [{ system: 'jira', id: 'PROJ-123', url: null }],
} as unknown as ProjectSummary;

function projectEntry(externalIds?: boolean): PaletteEntry {
  const entries = buildIndex({ projects: [project], wsPrefix: '', externalIds });
  const entry = entries.find((e) => e.id === 'project-acme');
  if (!entry) throw new Error('project entry not built');
  return entry;
}

const matches = (expr: string, item: QueryItem): boolean => {
  const r = compileQuery(expr, PALETTE_FIELDS);
  if (!r.query) throw new Error(`compile failed: ${JSON.stringify(r.errors)}`);
  return r.query.predicate(item, { now: 0 });
};

describe('buildIndex — external-ID gating', () => {
  it('folds external IDs into keywords + carries the externalIds fact by default', () => {
    const entry = projectEntry(undefined); // omitted === enabled
    expect(entry.externalIds).toEqual([{ system: 'jira', id: 'PROJ-123', url: null }]);
    expect(entry.keywords).toContain('PROJ-123');
    expect(entry.keywords).toContain('jira:PROJ-123');
  });

  it('externalIds=true behaves the same as the default', () => {
    const entry = projectEntry(true);
    expect(entry.externalIds).toBeDefined();
    expect(entry.keywords).toContain('PROJ-123');
  });

  it('externalIds=false drops the fact AND the id keywords', () => {
    const entry = projectEntry(false);
    expect(entry.externalIds).toBeUndefined();
    expect(entry.keywords ?? []).not.toContain('PROJ-123');
    expect(entry.keywords ?? []).not.toContain('jira:PROJ-123');
    // Non-ID keywords (tags) are unaffected.
    expect(entry.keywords).toContain('backend');
  });

  it('with externalIds=false, jira:/externalid: atoms match nothing (empty haystack, full registry)', () => {
    const disabled = projectEntry(false) as unknown as QueryItem;
    const enabled = projectEntry(true) as unknown as QueryItem;
    // The gate compiles against the full PALETTE_FIELDS either way (no bad-gate
    // fallback) — suppression is purely the empty haystack.
    expect(matches('jira:PROJ-123', enabled)).toBe(true);
    expect(matches('jira:PROJ-123', disabled)).toBe(false);
    expect(matches('externalid:PROJ-123', enabled)).toBe(true);
    expect(matches('externalid:PROJ-123', disabled)).toBe(false);
  });
});
