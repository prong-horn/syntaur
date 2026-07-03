import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileQuery, validateQuery } from '../utils/query/index.js';
import { buildQueryRegistry } from '../utils/fact-registry.js';
import { ASSIGNMENT_FIELDS } from '../utils/query/index.js';
import { boardItemToQueryItem, filterBoardItems } from '../../dashboard/src/lib/queryFilter';
import type { AssignmentBoardItem } from '../../dashboard/src/hooks/useProjects';
import { writeWorkflowsConfig, type WorkflowDefinition } from '../utils/config.js';
import { buildDefaultStatusConfig } from '../utils/status-defaults.js';
import { getUnionQueryRegistry, clearStatusConfigCache } from '../dashboard/api.js';

let seq = 0;
function makeItem(overrides: Partial<AssignmentBoardItem> = {}): AssignmentBoardItem {
  seq += 1;
  return {
    id: `a-${seq}`,
    slug: `slug-${seq}`,
    title: `Item ${seq}`,
    status: 'in_progress',
    type: 'feature',
    workflow: null,
    resolvedWorkflow: 'default',
    workflowLabel: 'Default',
    statusLabel: 'In progress',
    priority: 'high',
    assignee: 'claude',
    dependsOn: [],
    links: [],
    tags: [],
    externalIds: [],
    created: '2026-06-01T10:00:00Z',
    updated: '2026-06-08T10:00:00Z',
    archived: false,
    archivedAt: null,
    archivedReason: null,
    completedAt: null,
    statusAge: null,
    projectSlug: 'p',
    projectTitle: 'P',
    phase: null,
    disposition: null,
    phaseAge: null,
    facts: {},
    ...overrides,
  } as AssignmentBoardItem;
}

describe('workflow AQL field', () => {
  it('registers `workflow` in the built-in vocabulary', () => {
    expect('workflow' in ASSIGNMENT_FIELDS).toBe(true);
    expect(validateQuery('workflow:bug')).toEqual([]);
  });

  it('maps resolvedWorkflow into the query item', () => {
    const qi = boardItemToQueryItem(makeItem({ resolvedWorkflow: 'bug' }));
    expect(qi.resolvedWorkflow).toBe('bug');
  });

  it('filters board items by resolved workflow', () => {
    const items = [
      makeItem({ resolvedWorkflow: 'bug' }),
      makeItem({ resolvedWorkflow: 'default' }),
      makeItem({ resolvedWorkflow: 'bug' }),
    ];
    const { query } = compileQuery('workflow:bug', buildQueryRegistry([]));
    const matched = filterBoardItems(items, query);
    expect(matched).toHaveLength(2);
    expect(matched.every((i) => i.resolvedWorkflow === 'bug')).toBe(true);
  });

  it('falls back to the raw override when resolvedWorkflow is absent', () => {
    const qi = boardItemToQueryItem(
      makeItem({ resolvedWorkflow: undefined as unknown as string, workflow: 'rfc' }),
    );
    // The `workflow` field get() prefers resolvedWorkflow, falling to workflow.
    expect(qi.resolvedWorkflow ?? qi.workflow).toBe('rfc');
  });
});

describe('getUnionQueryRegistry', () => {
  const originalHome = process.env.HOME;
  const originalSyntaurHome = process.env.SYNTAUR_HOME;
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'syntaur-union-'));
    await mkdir(join(tmpHome, '.syntaur'), { recursive: true });
    process.env.HOME = tmpHome;
    process.env.SYNTAUR_HOME = join(tmpHome, '.syntaur');
    clearStatusConfigCache();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = originalSyntaurHome;
    await rm(tmpHome, { recursive: true, force: true });
    clearStatusConfigCache();
  });

  it('merges custom fact fields declared by a non-default workflow', async () => {
    const def: WorkflowDefinition = { label: 'Default', ...buildDefaultStatusConfig() };
    const bug: WorkflowDefinition = {
      label: 'Bug',
      ...buildDefaultStatusConfig(),
      facts: [{ name: 'flakyRepro', type: 'bool', binds: null }],
    };
    await writeWorkflowsConfig({ default: def, bug }, 'default');
    clearStatusConfigCache();

    const registry = await getUnionQueryRegistry();
    // Built-in vocabulary always present.
    expect('status' in registry).toBe(true);
    expect('workflow' in registry).toBe(true);
    // The bug workflow's custom fact field is unioned in (registry keys lowercased).
    expect('flakyrepro' in registry).toBe(true);
    // A query referencing the non-default field validates against the union but
    // would FAIL against the default-only registry.
    expect(validateQuery('flakyRepro:true', registry)).toEqual([]);
    expect(validateQuery('flakyRepro:true', buildQueryRegistry([])).length).toBeGreaterThan(0);
  });
});
