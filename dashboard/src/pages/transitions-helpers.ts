/**
 * Pure helpers for the Transitions editor: defaults seeding from
 * DEFAULT_TRANSITION_TABLE, grouping by from-status, editable-model
 * conversion, and from/to validation against defined statuses.
 */
import { DEFAULT_TRANSITION_TABLE } from '@shared/state-machine';
import type { StatusTransition } from '../hooks/useStatusConfig';

let rowKeyCounter = 0;
export function makeTransitionRowKey(): string {
  rowKeyCounter += 1;
  return `tr_${rowKeyCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface EditableTransition {
  rowKey: string;
  from: string;
  command: string;
  to: string;
  label: string;
  description: string;
  requiresReason: boolean;
}

export function toEditableTransition(t: StatusTransition): EditableTransition {
  return {
    rowKey: makeTransitionRowKey(),
    from: t.from,
    command: t.command,
    to: t.to,
    label: t.label ?? '',
    description: t.description ?? '',
    requiresReason: t.requiresReason ?? false,
  };
}

export function toEditableTransitions(transitions: StatusTransition[]): EditableTransition[] {
  return transitions.map(toEditableTransition);
}

/** Strip row keys + empty optional fields back to the wire shape. */
export function fromEditableTransition(e: EditableTransition): StatusTransition {
  const out: StatusTransition = { from: e.from, command: e.command, to: e.to };
  if (e.label.trim()) out.label = e.label.trim();
  if (e.description.trim()) out.description = e.description.trim();
  if (e.requiresReason) out.requiresReason = true;
  return out;
}

export function fromEditableTransitions(rows: EditableTransition[]): StatusTransition[] {
  return rows.map(fromEditableTransition);
}

/** The built-in default transition table as wire-shape rows. */
export function defaultTransitions(): StatusTransition[] {
  const out: StatusTransition[] = [];
  for (const [key, to] of DEFAULT_TRANSITION_TABLE) {
    const idx = key.indexOf(':');
    out.push({ from: key.slice(0, idx), command: key.slice(idx + 1), to });
  }
  return out;
}

/** Keep only rows whose `from` is a currently-defined status. */
export function filterToStatuses<T extends { from: string }>(rows: T[], statusIds: Set<string>): T[] {
  return rows.filter((r) => statusIds.has(r.from));
}

/**
 * Keep only rows whose `from` AND `to` are currently-defined statuses — used
 * when seeding the read-only defaults / customize view so no phantom row
 * references a status the user's config doesn't define (which would otherwise
 * make the unified Save fail validation).
 */
export function filterValidTransitions<T extends { from: string; to: string }>(
  rows: T[],
  statusIds: Set<string>,
): T[] {
  return rows.filter((r) => statusIds.has(r.from) && statusIds.has(r.to));
}

export interface TransitionGroup<T> {
  from: string;
  rows: T[];
}

/** Group rows by `from`, preserving first-seen group order and row order. */
export function groupTransitions<T extends { from: string }>(rows: T[]): TransitionGroup<T>[] {
  const groups: TransitionGroup<T>[] = [];
  const byFrom = new Map<string, TransitionGroup<T>>();
  for (const row of rows) {
    let g = byFrom.get(row.from);
    if (!g) {
      g = { from: row.from, rows: [] };
      byFrom.set(row.from, g);
      groups.push(g);
    }
    g.rows.push(row);
  }
  return groups;
}

/** from/to of every row must reference a defined status. */
export function validateTransitions(rows: EditableTransition[], statusIds: Set<string>): string[] {
  const problems: string[] = [];
  for (const r of rows) {
    if (!statusIds.has(r.from)) {
      problems.push(`transition ${r.from} --${r.command}--> ${r.to}: "${r.from}" is not a defined status`);
    }
    if (!statusIds.has(r.to)) {
      problems.push(`transition ${r.from} --${r.command}--> ${r.to}: "${r.to}" is not a defined status`);
    }
  }
  return problems;
}

// ── Graph model ────────────────────────────────────────────────────────────
// The Transitions editor is a state machine: statuses are nodes, transition
// commands are labeled directed edges. The helpers below derive a pure,
// lib-free graph model (no ReactFlow types) so they stay testable under the
// dashboard's node vitest env. They always operate on `EditableTransition[]`;
// callers holding wire-shape rows (e.g. `defaultTransitions()`) must wrap with
// `toEditableTransitions` first.

/**
 * A status, as passed from WorkflowPage. `color`/`terminal` are optional so
 * callers that only have `{ id, label }` (e.g. DeriveRulesSection) stay valid.
 */
export interface StatusOption {
  id: string;
  label: string;
  color?: string;
  terminal?: boolean;
}

export interface GraphStatusNode {
  id: string;
  label: string;
  color?: string;
  terminal: boolean;
  /** Defined status with no incoming edge (excluding the entry status). */
  orphan: boolean;
  /** Ghost node synthesized for a status id referenced by a transition but not defined. */
  missing: boolean;
}

export interface GraphTransitionEdge {
  rowKey: string;
  from: string;
  to: string;
  command: string;
  label: string;
  requiresReason: boolean;
  /** `from` and/or `to` is not a defined status. */
  undefinedRef: boolean;
}

export interface TransitionGraph {
  nodes: GraphStatusNode[];
  edges: GraphTransitionEdge[];
}

/**
 * Statuses that are defined but have NO incoming edge (no transition whose
 * `to` equals the status id), EXCLUDING the entry status. The entry status is
 * the first status in display order (`statuses[0]`) — it legitimately has no
 * incoming edge, so flagging it would be a false positive. Operates on the
 * given (unfiltered) rows so undefined-status references still count.
 */
export function detectOrphanStatuses(
  rows: EditableTransition[],
  statuses: StatusOption[],
): Set<string> {
  const entryId = statuses[0]?.id;
  const hasIncoming = new Set<string>();
  for (const r of rows) {
    if (r.to) hasIncoming.add(r.to);
  }
  const orphans = new Set<string>();
  for (const s of statuses) {
    if (s.id === entryId) continue;
    if (!hasIncoming.has(s.id)) orphans.add(s.id);
  }
  return orphans;
}

export interface UndefinedRef {
  rowKey: string;
  /** The undefined status id(s) this row references (deduped). */
  missing: string[];
}

/**
 * Rows whose `from` and/or `to` is not a defined status. Structured companion
 * to the string-based `validateTransitions` (reuse its wording for display).
 */
export function detectUndefinedRefs(
  rows: EditableTransition[],
  statusIds: Set<string>,
): UndefinedRef[] {
  const out: UndefinedRef[] = [];
  for (const r of rows) {
    const missing = new Set<string>();
    if (!statusIds.has(r.from)) missing.add(r.from);
    if (!statusIds.has(r.to)) missing.add(r.to);
    if (missing.size) out.push({ rowKey: r.rowKey, missing: [...missing] });
  }
  return out;
}

/**
 * Derive the graph model: one node per defined status (in display order),
 * one edge per transition row (keyed by `rowKey`), plus a ghost node
 * (`missing: true`) for any status id referenced by a row but not defined so
 * undefined-status edges still have endpoints to draw to. Orphan statuses and
 * undefined-ref edges are flagged rather than filtered.
 */
export function deriveGraph(
  rows: EditableTransition[],
  statuses: StatusOption[],
): TransitionGraph {
  const statusIds = new Set(statuses.map((s) => s.id));
  const orphans = detectOrphanStatuses(rows, statuses);

  const nodes: GraphStatusNode[] = statuses.map((s) => ({
    id: s.id,
    label: s.label,
    color: s.color,
    terminal: s.terminal ?? false,
    orphan: orphans.has(s.id),
    missing: false,
  }));

  // Ghost nodes for referenced-but-undefined status ids (e.g. `pending`).
  const seen = new Set(statusIds);
  for (const r of rows) {
    for (const id of [r.from, r.to]) {
      if (id && !seen.has(id)) {
        seen.add(id);
        nodes.push({ id, label: id, terminal: false, orphan: false, missing: true });
      }
    }
  }

  const edges: GraphTransitionEdge[] = rows.map((r) => ({
    rowKey: r.rowKey,
    from: r.from,
    to: r.to,
    command: r.command,
    label: r.label,
    requiresReason: r.requiresReason,
    undefinedRef: !statusIds.has(r.from) || !statusIds.has(r.to),
  }));

  return { nodes, edges };
}
