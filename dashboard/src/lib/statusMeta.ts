import type { CSSProperties } from 'react';
import type { StatusConfigResponse, StatusDefinition } from '../hooks/useStatusConfig';

/**
 * Config-driven status appearance + option helpers. This module is intentionally
 * React-free (only `import type` from React/hooks, which esbuild erases) so it can
 * be unit-tested under the node-environment root vitest, which only includes
 * `src/__tests__/**` — a test co-located under `dashboard/` would never run.
 */

// Built-in status color classes (Tailwind). Single source of truth — also consumed
// by StatusBadge's STATUS_META. Kept here (string-only, no React) so this module
// stays unit-testable under the node-env root vitest.
export const STATUS_PENDING_CLASS = 'border-status-pending-foreground/30 bg-status-pending text-status-pending-foreground';
export const STATUS_IN_PROGRESS_CLASS = 'border-status-in-progress-foreground/30 bg-status-in-progress text-status-in-progress-foreground';
export const STATUS_BLOCKED_CLASS = 'border-status-blocked-foreground/30 bg-status-blocked text-status-blocked-foreground';
export const STATUS_REVIEW_CLASS = 'border-status-review-foreground/30 bg-status-review text-status-review-foreground';
export const STATUS_COMPLETED_CLASS = 'border-status-completed-foreground/30 bg-status-completed text-status-completed-foreground';
export const STATUS_FAILED_CLASS = 'border-status-failed-foreground/30 bg-status-failed text-status-failed-foreground';
export const STATUS_ARCHIVED_CLASS = 'border-status-archived-foreground/30 bg-status-archived text-status-archived-foreground';

/** Pill chrome used when a status has no usable color (neutral). */
const NEUTRAL_PILL_CLASS = STATUS_PENDING_CLASS;

/**
 * Known built-in statuses keep their familiar color when the live config has NOT
 * supplied an explicit color yet — initial boot, or fetch failure (when
 * `useStatusConfig()` falls back to DEFAULT_STATUS_CONFIG, which carries labels
 * only). Mirrors the legacy STATUS_META class mapping so existing read-only
 * StatusBadge call sites don't regress to the neutral pill.
 */
const BUILTIN_STATUS_CLASS: Record<string, string> = {
  draft: STATUS_PENDING_CLASS,
  pending: STATUS_PENDING_CLASS,
  ready_for_planning: STATUS_PENDING_CLASS,
  ready_to_implement: STATUS_IN_PROGRESS_CLASS,
  in_progress: STATUS_IN_PROGRESS_CLASS,
  blocked: STATUS_BLOCKED_CLASS,
  review: STATUS_REVIEW_CLASS,
  code_review: STATUS_REVIEW_CLASS,
  completed: STATUS_COMPLETED_CLASS,
  failed: STATUS_FAILED_CLASS,
  active: STATUS_IN_PROGRESS_CLASS,
  stopped: STATUS_PENDING_CLASS,
  archived: STATUS_ARCHIVED_CLASS,
};

/** Class for a known status when no config color applies, else the neutral pill. */
function fallbackClass(status: string): string {
  return BUILTIN_STATUS_CLASS[status] ?? NEUTRAL_PILL_CLASS;
}

/**
 * Named color tokens a status `color:` may use instead of a hex string. They map
 * to existing Tailwind status-* utility classes; anything unknown falls back to
 * the built-in/neutral class. (Hex colors are handled separately via inline style.)
 */
const NAMED_TOKEN_CLASS: Record<string, string> = {
  slate: NEUTRAL_PILL_CLASS,
  gray: NEUTRAL_PILL_CLASS,
  grey: NEUTRAL_PILL_CLASS,
};

export interface StatusAppearance {
  label: string;
  /** Tailwind chrome appended to the shared pill base (always set). */
  className: string;
  /** Present only when the color is a hex string; drives bg/border/text inline. */
  style?: CSSProperties;
  /** Optional config icon name (StatusBadge maps it to a lucide icon). */
  iconName?: string;
}

export interface StatusOption {
  id: string;
  label: string;
  terminal: boolean;
}

function titleCase(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Expand `#rgb` / `#rrggbb` to an `{r,g,b}` triple, or null if unparseable. */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/**
 * Resolve a status `color:` into pill chrome. Cases:
 *  - hex string → empty className + inline style derived from the hex
 *  - named token (e.g. "slate") → mapped class
 *  - absent / unparseable hex / unknown token → the built-in/neutral fallback class
 */
function colorToAppearance(status: string, color?: string): { className: string; style?: CSSProperties } {
  const trimmed = color?.trim();
  if (trimmed) {
    if (trimmed.startsWith('#')) {
      const rgb = hexToRgb(trimmed);
      if (rgb) {
        const { r, g, b } = rgb;
        return {
          // No color class: the inline style owns bg/border/text so it cannot
          // fight a Tailwind utility. The shared base still supplies the shape.
          className: '',
          style: {
            backgroundColor: `rgba(${r}, ${g}, ${b}, 0.15)`,
            borderColor: `rgba(${r}, ${g}, ${b}, 0.4)`,
            color: trimmed,
          },
        };
      }
      // Unparseable hex → fall through to the built-in/neutral class.
    } else {
      const tokenClass = NAMED_TOKEN_CLASS[trimmed.toLowerCase()];
      if (tokenClass) return { className: tokenClass };
      // Unknown named token → fall through to the built-in/neutral class.
    }
  }
  return { className: fallbackClass(status) };
}

/**
 * Resolve a status id to its label + pill appearance from the live status config.
 * When config supplies a color it wins; otherwise known built-ins keep their
 * familiar class (so they don't flash neutral before the config loads, and stay
 * correct if the fetch fails) and unknown statuses fall back to the neutral pill
 * with a title-cased label.
 */
export function resolveStatusAppearance(
  statuses: Pick<StatusDefinition, 'id' | 'label' | 'color' | 'icon' | 'terminal'>[],
  status: string,
): StatusAppearance {
  const def = statuses.find((s) => s.id === status);
  const { className, style } = colorToAppearance(status, def?.color);
  return {
    label: def?.label ?? titleCase(status),
    className,
    style,
    iconName: def?.icon,
  };
}

/**
 * Terminal-status predicate. The client only has `StatusDefinition.terminal`, so
 * mirror the server fallback that treats `completed`/`failed` as terminal even
 * when no flags are declared (`src/dashboard/api.ts`).
 */
export function isTerminalStatus(def?: Pick<StatusDefinition, 'id' | 'terminal'>): boolean {
  if (!def) return false;
  return Boolean(def.terminal) || def.id === 'completed' || def.id === 'failed';
}

/**
 * Ordered, de-duplicated option list for a status `<select>` / override menu.
 * Follows `config.order`, then appends any statuses present in `config.statuses`
 * but missing from `order`. Each option carries a `terminal` flag.
 */
export function deriveStatusOptions(config: StatusConfigResponse): StatusOption[] {
  const byId = new Map(config.statuses.map((s) => [s.id, s] as const));
  const order = config.order.length > 0 ? config.order : config.statuses.map((s) => s.id);
  const seen = new Set<string>();
  const options: StatusOption[] = [];
  const push = (id: string, def?: StatusDefinition) => {
    if (seen.has(id)) return;
    seen.add(id);
    options.push({
      id,
      label: def?.label ?? titleCase(id),
      terminal: isTerminalStatus(def ?? { id }),
    });
  };
  for (const id of order) push(id, byId.get(id));
  for (const s of config.statuses) push(s.id, s);
  return options;
}
