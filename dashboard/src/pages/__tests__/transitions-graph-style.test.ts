import { describe, it, expect } from 'vitest';
import {
  statusRankMap,
  classifyEdge,
  spineRankEdges,
  bundleEdges,
  computeFocusSet,
} from '../transitions-graph-style';
import type { GraphTransitionEdge, StatusOption } from '../transitions-helpers';

function status(id: string, extra: Partial<StatusOption> = {}): StatusOption {
  return { id, label: id, ...extra };
}

// Lifecycle display order → spine rank by index.
const STATUSES: StatusOption[] = [
  status('draft'),
  status('ready_for_planning'),
  status('ready_to_implement'),
  status('in_progress'),
  status('review'),
  status('blocked'),
  status('completed', { terminal: true }),
  status('failed', { terminal: true }),
];

let n = 0;
function edge(
  from: string,
  command: string,
  to: string,
  extra: Partial<GraphTransitionEdge> = {},
): GraphTransitionEdge {
  n += 1;
  return {
    rowKey: `e${n}`,
    from,
    command,
    to,
    label: '',
    requiresReason: false,
    undefinedRef: false,
    ...extra,
  };
}

describe('classifyEdge', () => {
  const rank = statusRankMap(STATUSES);

  it('classifies a forward lifecycle step as forward', () => {
    expect(classifyEdge(edge('draft', 'start', 'in_progress'), rank)).toBe('forward');
    expect(classifyEdge(edge('in_progress', 'complete', 'completed'), rank)).toBe('forward');
  });

  it('classifies fail/block commands as exception', () => {
    expect(classifyEdge(edge('in_progress', 'fail', 'failed'), rank)).toBe('exception');
    expect(classifyEdge(edge('in_progress', 'block', 'blocked'), rank)).toBe('exception');
  });

  it('classifies reopen/unblock commands as recovery', () => {
    expect(classifyEdge(edge('completed', 'reopen', 'in_progress'), rank)).toBe('recovery');
    expect(classifyEdge(edge('blocked', 'unblock', 'in_progress'), rank)).toBe('recovery');
  });

  it('classifies a backward (lower-rank target) edge as recovery even with a neutral command', () => {
    // review (rank 4) -> in_progress (rank 3): backward.
    expect(classifyEdge(edge('review', 'start', 'in_progress'), rank)).toBe('recovery');
  });

  it('falls back to forward when an endpoint is undefined (red styling handled elsewhere)', () => {
    expect(classifyEdge(edge('pending', 'start', 'in_progress', { undefinedRef: true }), rank)).toBe('forward');
  });
});

describe('spineRankEdges', () => {
  it('excludes recovery edges from the ranking subset but keeps forward + exception', () => {
    const edges = [
      edge('draft', 'start', 'in_progress'), // forward
      edge('in_progress', 'fail', 'failed'), // exception
      edge('completed', 'reopen', 'in_progress'), // recovery — excluded
      edge('review', 'start', 'in_progress'), // backward recovery — excluded
    ];
    const ranked = spineRankEdges(edges, STATUSES);
    expect(ranked).toEqual([
      { from: 'draft', to: 'in_progress' },
      { from: 'in_progress', to: 'failed' },
    ]);
  });
});

describe('bundleEdges', () => {
  it('collapses parallel commands between the same from→to into one bundle (order preserved)', () => {
    const a = edge('in_progress', 'review', 'review');
    const b = edge('in_progress', 'complete', 'review');
    const c = edge('draft', 'start', 'in_progress');
    const bundles = bundleEdges([a, b, c]);
    expect(bundles).toHaveLength(2);
    expect(bundles[0]).toMatchObject({ from: 'in_progress', to: 'review' });
    expect(bundles[0].commands.map((x) => x.command)).toEqual(['review', 'complete']);
    expect(bundles[0].commands.map((x) => x.rowKey)).toEqual([a.rowKey, b.rowKey]);
    expect(bundles[1]).toMatchObject({ from: 'draft', to: 'in_progress' });
    expect(bundles[1].commands).toHaveLength(1);
  });
});

describe('computeFocusSet', () => {
  it('returns the node, its in/out neighbors, and the incident edge keys', () => {
    const e1 = edge('draft', 'start', 'in_progress');
    const e2 = edge('in_progress', 'block', 'blocked');
    const e3 = edge('completed', 'reopen', 'in_progress');
    const e4 = edge('draft', 'shape', 'ready_for_planning'); // not incident to in_progress
    const { nodeIds, edgeKeys } = computeFocusSet('in_progress', [e1, e2, e3, e4]);
    expect([...nodeIds].sort()).toEqual(['blocked', 'completed', 'draft', 'in_progress']);
    expect([...edgeKeys].sort()).toEqual([e1.rowKey, e2.rowKey, e3.rowKey].sort());
    expect(edgeKeys.has(e4.rowKey)).toBe(false);
  });
});
