/**
 * Browser-safe default status-set primitives. Extracted from `config.ts` (which
 * is Node-only — it imports `node:fs`) so the pure `workflow-resolve.ts`
 * selector can synthesize the built-in `default` workflow without dragging Node
 * into the dashboard bundle. Mirrors the `derive-config.ts` extraction pattern;
 * `config.ts` re-exports these so existing Node-side imports keep resolving.
 *
 * Zero Node imports — only browser-safe lifecycle constants.
 */
import type { StatusConfig } from './config.js';
import { DEFAULT_STATUSES } from '../lifecycle/types.js';
import { DEFAULT_TRANSITION_TABLE } from '../lifecycle/state-machine.js';

/**
 * Default per-status accent colors. Statuses without an entry fall back to
 * `'gray'` in {@link buildDefaultStatusConfig}. Shared by the dashboard's
 * `getStatusConfig()` and the `syntaur status` CLI so the two never drift.
 */
export const DEFAULT_STATUS_COLORS: Record<string, string> = {
  pending: 'slate',
  in_progress: 'teal',
  blocked: 'amber',
  review: 'violet',
  completed: 'emerald',
  failed: 'rose',
};

/** Turn a snake_case status id into a human label ("in_progress" → "In Progress"). */
export function toTitleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Materialize the built-in default status set as an explicit {@link StatusConfig}.
 *
 * `DEFAULT_CONFIG.statuses` is `null` (the runtime resolves defaults lazily), so
 * `syntaur status init` / `list` cannot read defaults from there. This builder
 * reproduces exactly what the dashboard's `getStatusConfig()` no-block branch
 * builds — same ids/labels/colors/terminal flags and the same transition table —
 * so the CLI and the dashboard share one source of truth.
 */
export function buildDefaultStatusConfig(): StatusConfig {
  return {
    statuses: DEFAULT_STATUSES.map((id) => ({
      id,
      label: toTitleCase(id),
      color: DEFAULT_STATUS_COLORS[id] ?? 'gray',
      terminal: id === 'completed' || id === 'failed',
    })),
    order: [...DEFAULT_STATUSES],
    transitions: Array.from(DEFAULT_TRANSITION_TABLE.entries()).map(([key, to]) => {
      const [from, command] = key.split(':');
      return { from, command, to };
    }),
  };
}
