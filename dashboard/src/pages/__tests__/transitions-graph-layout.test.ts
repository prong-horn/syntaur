import { describe, it, expect } from 'vitest';
import { layoutGraph } from '../transitions-graph-layout';

const NODES = [
  { id: 'draft' },
  { id: 'in_progress' },
  { id: 'blocked' },
  { id: 'parked' }, // isolated / orphan: no incident edges
];
const EDGES = [
  { from: 'draft', to: 'in_progress' },
  { from: 'in_progress', to: 'blocked' },
];

function isFinitePos(p: { x: number; y: number } | undefined) {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

describe('layoutGraph', () => {
  it('returns a finite position for every node id', () => {
    const pos = layoutGraph(NODES, EDGES);
    for (const n of NODES) expect(isFinitePos(pos.get(n.id))).toBe(true);
    expect(pos.size).toBe(NODES.length);
  });

  it('positions an isolated/orphan node (no incident edges)', () => {
    const pos = layoutGraph(NODES, EDGES);
    expect(isFinitePos(pos.get('parked'))).toBe(true);
  });

  it('is deterministic across runs', () => {
    const a = layoutGraph(NODES, EDGES);
    const b = layoutGraph(NODES, EDGES);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('does not throw on an edge referencing an unknown endpoint', () => {
    expect(() =>
      layoutGraph([{ id: 'draft' }], [{ from: 'draft', to: 'ghost' }]),
    ).not.toThrow();
    const pos = layoutGraph([{ id: 'draft' }], [{ from: 'draft', to: 'ghost' }]);
    expect(isFinitePos(pos.get('draft'))).toBe(true);
    expect(pos.has('ghost')).toBe(false);
  });

  it('returns an empty map for empty input', () => {
    expect(layoutGraph([], []).size).toBe(0);
  });

  it('lays out left-to-right: a downstream node has a greater x than the entry', () => {
    const pos = layoutGraph(NODES, EDGES, { direction: 'LR' });
    expect(pos.get('in_progress')!.x).toBeGreaterThan(pos.get('draft')!.x);
  });
});
