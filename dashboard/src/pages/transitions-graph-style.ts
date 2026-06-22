/**
 * Pure presentation helpers for the Transitions graph — edge classification,
 * spine-ranking, parallel-edge bundling, and focus-set computation. Kept lib-free
 * (like `transitions-helpers.ts`) so it's unit-testable under the dashboard's node
 * vitest env and so the de-hairball logic stays separate from ReactFlow.
 */
import type { GraphTransitionEdge, StatusOption } from './transitions-helpers';

export type EdgeClass = 'forward' | 'exception' | 'recovery';

/** Spine rank for each status = its display-order index (the lifecycle order). */
export function statusRankMap(statuses: StatusOption[]): Map<string, number> {
  const rank = new Map<string, number>();
  statuses.forEach((s, i) => {
    if (!rank.has(s.id)) rank.set(s.id, i);
  });
  return rank;
}

type ClassifiableEdge = Pick<GraphTransitionEdge, 'from' | 'to' | 'command'>;

const EXCEPTION_COMMANDS = new Set(['fail', 'block']);
const RECOVERY_COMMANDS = new Set(['reopen', 'unblock']);

/**
 * Classify an edge for semantic styling and spine ranking:
 * - `exception` — failure/block commands (`fail`, `block`).
 * - `recovery` — explicit recovery commands (`reopen`, `unblock`) OR an edge that
 *   points backward in spine rank (target ranks before source).
 * - `forward` — everything else, including edges with an undefined endpoint
 *   (their red "undefined reference" styling is handled separately).
 */
export function classifyEdge(edge: ClassifiableEdge, rank: Map<string, number>): EdgeClass {
  if (EXCEPTION_COMMANDS.has(edge.command)) return 'exception';
  if (RECOVERY_COMMANDS.has(edge.command)) return 'recovery';
  const from = rank.get(edge.from);
  const to = rank.get(edge.to);
  if (from != null && to != null && to < from) return 'recovery';
  return 'forward';
}

/**
 * The edge subset handed to dagre for ranking: forward + exception edges only.
 * Excluding recovery (back-)edges keeps the happy path laid out as a straight
 * spine instead of being pulled into a hairball by reopen/unblock returns.
 */
export function spineRankEdges(
  edges: GraphTransitionEdge[],
  statuses: StatusOption[],
): Array<{ from: string; to: string }> {
  const rank = statusRankMap(statuses);
  return edges
    .filter((e) => classifyEdge(e, rank) !== 'recovery')
    .map((e) => ({ from: e.from, to: e.to }));
}

export interface BundledCommand {
  rowKey: string;
  command: string;
  requiresReason: boolean;
  undefinedRef: boolean;
}

export interface BundledEdge {
  from: string;
  to: string;
  commands: BundledCommand[];
}

/**
 * Collapse parallel edges (same `from→to`) into one bundle carrying each
 * command, so the graph draws one line per status pair while every command stays
 * individually selectable by `rowKey`. First-seen pair order is preserved.
 */
export function bundleEdges(edges: GraphTransitionEdge[]): BundledEdge[] {
  const bundles: BundledEdge[] = [];
  const byPair = new Map<string, BundledEdge>();
  for (const e of edges) {
    const key = `${e.from}>${e.to}`;
    let bundle = byPair.get(key);
    if (!bundle) {
      bundle = { from: e.from, to: e.to, commands: [] };
      byPair.set(key, bundle);
      bundles.push(bundle);
    }
    bundle.commands.push({
      rowKey: e.rowKey,
      command: e.command,
      requiresReason: e.requiresReason,
      undefinedRef: e.undefinedRef,
    });
  }
  return bundles;
}

export interface FocusSet {
  nodeIds: Set<string>;
  edgeKeys: Set<string>;
}

/**
 * The neighborhood of `nodeId`: the node itself, every status directly connected
 * by an edge, and the `rowKey` of every incident edge. Drives focus mode (dim
 * everything outside the set).
 */
export function computeFocusSet(nodeId: string, edges: GraphTransitionEdge[]): FocusSet {
  const nodeIds = new Set<string>([nodeId]);
  const edgeKeys = new Set<string>();
  for (const e of edges) {
    if (e.from === nodeId || e.to === nodeId) {
      nodeIds.add(e.from);
      nodeIds.add(e.to);
      edgeKeys.add(e.rowKey);
    }
  }
  return { nodeIds, edgeKeys };
}
