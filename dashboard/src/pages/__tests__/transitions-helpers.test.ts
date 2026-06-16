import { describe, it, expect } from 'vitest';
import {
  defaultTransitions,
  toEditableTransitions,
  fromEditableTransitions,
  makeTransitionRowKey,
  deriveGraph,
  detectOrphanStatuses,
  detectUndefinedRefs,
  type EditableTransition,
  type StatusOption,
} from '../transitions-helpers';

// Build an EditableTransition without the random rowKey churn where we need a
// stable key for assertions.
function row(
  from: string,
  command: string,
  to: string,
  extra: Partial<EditableTransition> = {},
): EditableTransition {
  return {
    rowKey: makeTransitionRowKey(),
    from,
    command,
    to,
    label: '',
    description: '',
    requiresReason: false,
    ...extra,
  };
}

function status(id: string, extra: Partial<StatusOption> = {}): StatusOption {
  return { id, label: id, ...extra };
}

// Mirrors the user's live ~/.syntaur/config.md status set: no `pending`, and
// `planning` / `code_review` / `parked` defined but unreachable under the
// default transition table.
const LIVE_STATUSES: StatusOption[] = [
  status('draft'),
  status('ready_for_planning'),
  status('ready_to_implement'),
  status('planning'),
  status('in_progress'),
  status('code_review'),
  status('review'),
  status('blocked'),
  status('completed', { terminal: true }),
  status('failed', { terminal: true }),
  status('parked'),
];

describe('deriveGraph', () => {
  it('produces one node per defined status (in order) and one edge per row keyed by rowKey', () => {
    const statuses = [status('draft', { color: '#111' }), status('in_progress'), status('blocked')];
    const rows = [row('draft', 'start', 'in_progress'), row('in_progress', 'block', 'blocked')];

    const { nodes, edges } = deriveGraph(rows, statuses);

    expect(nodes.map((n) => n.id)).toEqual(['draft', 'in_progress', 'blocked']);
    expect(nodes[0].color).toBe('#111');
    expect(nodes.every((n) => !n.missing)).toBe(true);
    expect(edges.map((e) => e.rowKey)).toEqual(rows.map((r) => r.rowKey));
    expect(edges.every((e) => !e.undefinedRef)).toBe(true);
  });

  it('synthesizes a ghost node for an undefined-status reference and flags the edge', () => {
    const statuses = [status('draft'), status('in_progress')];
    const rows = [row('pending', 'start', 'in_progress')];

    const { nodes, edges } = deriveGraph(rows, statuses);

    const ghost = nodes.find((n) => n.id === 'pending');
    expect(ghost).toBeDefined();
    expect(ghost?.missing).toBe(true);
    expect(edges[0].undefinedRef).toBe(true);
  });

  it('marks terminal nodes from the status option', () => {
    const statuses = [status('draft'), status('completed', { terminal: true })];
    const { nodes } = deriveGraph([row('draft', 'complete', 'completed')], statuses);
    expect(nodes.find((n) => n.id === 'completed')?.terminal).toBe(true);
    expect(nodes.find((n) => n.id === 'draft')?.terminal).toBe(false);
  });
});

describe('detectOrphanStatuses', () => {
  it('flags a defined non-entry status with no incoming edge', () => {
    const statuses = [status('draft'), status('in_progress'), status('parked')];
    const rows = [row('draft', 'start', 'in_progress')];
    const orphans = detectOrphanStatuses(rows, statuses);
    expect(orphans.has('parked')).toBe(true);
    expect(orphans.has('in_progress')).toBe(false);
  });

  it('does NOT flag the entry status (statuses[0]) even with no incoming edge', () => {
    const statuses = [status('draft'), status('in_progress')];
    const rows = [row('draft', 'start', 'in_progress')];
    const orphans = detectOrphanStatuses(rows, statuses);
    expect(orphans.has('draft')).toBe(false);
  });

  it('flags planning / code_review / parked as orphans against the live status set + default table', () => {
    const rows = toEditableTransitions(defaultTransitions());
    const orphans = detectOrphanStatuses(rows, LIVE_STATUSES);
    expect(orphans.has('planning')).toBe(true);
    expect(orphans.has('code_review')).toBe(true);
    expect(orphans.has('parked')).toBe(true);
    // Reachable / entry statuses must NOT be flagged.
    expect(orphans.has('draft')).toBe(false); // entry status
    expect(orphans.has('in_progress')).toBe(false);
    expect(orphans.has('completed')).toBe(false);
  });
});

describe('detectUndefinedRefs', () => {
  it('flags the two `pending` default rows against a status set lacking `pending`', () => {
    const rows = toEditableTransitions(defaultTransitions());
    const statusIds = new Set(LIVE_STATUSES.map((s) => s.id));
    const undefined_ = detectUndefinedRefs(rows, statusIds);

    const pendingRows = rows.filter((r) => r.from === 'pending');
    expect(pendingRows).toHaveLength(2); // pending:start, pending:block
    for (const pr of pendingRows) {
      const hit = undefined_.find((u) => u.rowKey === pr.rowKey);
      expect(hit).toBeDefined();
      expect(hit?.missing).toContain('pending');
    }
    // No other rows are flagged for the live status set.
    expect(undefined_).toHaveLength(2);
  });

  it('dedupes when from === to and both are undefined', () => {
    const rows = [row('ghost', 'loop', 'ghost')];
    const hits = detectUndefinedRefs(rows, new Set(['draft']));
    expect(hits).toHaveLength(1);
    expect(hits[0].missing).toEqual(['ghost']);
  });
});

describe('persistence contract is unchanged by the graph helpers', () => {
  it('round-trips fromEditableTransitions(toEditableTransitions(x)) byte-identically', () => {
    const wire = defaultTransitions();
    expect(fromEditableTransitions(toEditableTransitions(wire))).toEqual(wire);
  });

  it('preserves optional fields exactly on round-trip', () => {
    const wire = [
      { from: 'draft', command: 'start', to: 'in_progress' },
      { from: 'in_progress', command: 'block', to: 'blocked', label: 'Block it', requiresReason: true },
      { from: 'review', command: 'fail', to: 'failed', description: 'why' },
    ];
    expect(fromEditableTransitions(toEditableTransitions(wire))).toEqual(wire);
  });
});
