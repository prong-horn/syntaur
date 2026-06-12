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
