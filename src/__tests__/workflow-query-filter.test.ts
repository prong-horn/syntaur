import { describe, it, expect } from 'vitest';
import { compileQuery, validateQuery } from '../utils/query/index.js';
import { buildQueryRegistry } from '../utils/query/registry.js';
import { TICKET_FIELDS } from '../utils/query/index.js';
import { boardItemToQueryItem, filterBoardItems } from '../../dashboard/src/lib/queryFilter';
import type { TicketBoardItem } from '../../dashboard/src/hooks/useProjects';

let seq = 0;
function makeItem(overrides: Partial<TicketBoardItem> = {}): TicketBoardItem {
  seq += 1;
  return {
    id: `a-${seq}`,
    slug: `slug-${seq}`,
    title: `Item ${seq}`,
    status: 'in_progress',
    template: 'feature',
    statusLabel: 'In progress',
    priority: 'high',
    assignee: 'claude',
    depends_on: [],
    links: [],
    tags: [],
    blocked: null,
    parked: null,
    created: '2026-06-01T10:00:00Z',
    updated: '2026-06-08T10:00:00Z',
    completedAt: null,
    statusAge: null,
    projectSlug: 'p',
    projectTitle: 'P',
    availableVerbs: [],
    ...overrides,
  } as TicketBoardItem;
}

describe('workflow AQL field', () => {
  it('registers `workflow` in the built-in vocabulary', () => {
    expect('workflow' in TICKET_FIELDS).toBe(true);
    expect(validateQuery('workflow:bug')).toEqual([]);
  });

  it('maps template into the query item', () => {
    const qi = boardItemToQueryItem(makeItem({ template: 'bug' }));
    expect(qi.template).toBe('bug');
  });

  it('filters board items by template', () => {
    const items = [
      makeItem({ template: 'bug' }),
      makeItem({ template: 'feature' }),
      makeItem({ template: 'bug' }),
    ];
    const { query } = compileQuery('template:bug', buildQueryRegistry());
    const matched = filterBoardItems(items, query);
    expect(matched).toHaveLength(2);
    expect(matched.every((i) => i.template === 'bug')).toBe(true);
  });
});

// ── WS-3 compat aliases — dual-evaluator agreement (T7) ─────────────────────
describe('WS-3 compat aliases — dual-evaluator agreement (T7)', () => {
  const now = Date.now();
  const FIVE_DAYS = 5 * 24 * 60 * 60 * 1000;

  it('phase/disposition/pinned/phaseAge agree between the CLI item and boardItemToQueryItem', () => {
    const cliItem = {
      status: 'planning',
      blocked: 'waiting',
      parked: null,
      statusAge: FIVE_DAYS,
      phaseAge: null,
      phase: null,
      disposition: null,
    };
    const browserItem = boardItemToQueryItem(
      makeItem({
        status: 'planning',
        blocked: 'waiting',
        statusAge: FIVE_DAYS,
      }),
    );
    const registry = buildQueryRegistry([]);
    for (const expr of [
      'status:planning',
      'disposition:blocked',
      'pinned:false',
      'phaseAge > 3d',
    ]) {
      const { query, errors } = compileQuery(expr, registry);
      expect(errors).toEqual([]);
      const cli = query!.predicate(cliItem, { now });
      const browser = query!.predicate(browserItem, { now });
      expect(browser).toBe(cli);
      expect(browser).toBe(true);
    }
  });

  it('filterBoardItems honors the aliases end-to-end', () => {
    const items = [
      makeItem({ status: 'planning', blocked: 'waiting' }),
      makeItem({ status: 'draft' }),
    ];
    const { query } = compileQuery('status:planning AND disposition:blocked', buildQueryRegistry([]));
    const matched = filterBoardItems(items, query);
    expect(matched).toHaveLength(1);
    expect(matched[0].status).toBe('planning');
  });
});
