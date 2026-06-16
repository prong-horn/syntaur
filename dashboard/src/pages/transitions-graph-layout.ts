// Presentational layout for the Transitions graph. Wraps dagre to compute a
// directed layered layout (statuses flow left-to-right). Kept out of
// transitions-helpers.ts (which must stay lib-free for the pure-logic tests);
// dagre is pure JS so this module is still unit-testable under the node env.
import { graphlib, layout } from '@dagrejs/dagre';

export interface LayoutNodeInput {
  id: string;
}

export interface LayoutEdgeInput {
  from: string;
  to: string;
}

export interface LayoutOptions {
  direction?: 'LR' | 'TB';
  nodeWidth?: number;
  nodeHeight?: number;
}

/**
 * Compute a position (top-left corner) for every node id via dagre. Edges
 * referencing an unknown endpoint are skipped (never throws). Deterministic for
 * a given input. Returns an empty map for empty input.
 */
export function layoutGraph(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  opts: LayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return result;

  const width = opts.nodeWidth ?? 150;
  const height = opts.nodeHeight ?? 64;

  const g = new graphlib.Graph();
  g.setGraph({ rankdir: opts.direction ?? 'LR', nodesep: 40, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set<string>();
  for (const n of nodes) {
    ids.add(n.id);
    g.setNode(n.id, { width, height });
  }
  for (const e of edges) {
    if (ids.has(e.from) && ids.has(e.to)) g.setEdge(e.from, e.to);
  }

  layout(g);

  for (const id of ids) {
    const node = g.node(id);
    if (node) result.set(id, { x: node.x - width / 2, y: node.y - height / 2 });
  }
  return result;
}
