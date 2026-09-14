import type { CSSProperties } from 'react';
import type { StatusConfigResponse, StatusDefinition } from '../hooks/useStatusConfig';
import { STAGE_TABLE } from '../hooks/useStatusConfig';

export const STATUS_PENDING_CLASS = 'border-status-pending-foreground/30 bg-status-pending text-status-pending-foreground';
export const STATUS_IN_PROGRESS_CLASS = 'border-status-in-progress-foreground/30 bg-status-in-progress text-status-in-progress-foreground';
export const STATUS_BLOCKED_CLASS = 'border-status-blocked-foreground/30 bg-status-blocked text-status-blocked-foreground';
export const STATUS_REVIEW_CLASS = 'border-status-review-foreground/30 bg-status-review text-status-review-foreground';
export const STATUS_COMPLETED_CLASS = 'border-status-completed-foreground/30 bg-status-completed text-status-completed-foreground';
export const STATUS_FAILED_CLASS = 'border-status-failed-foreground/30 bg-status-failed text-status-failed-foreground';
export const STATUS_ARCHIVED_CLASS = 'border-status-archived-foreground/30 bg-status-archived text-status-archived-foreground';

const NEUTRAL_PILL_CLASS = STATUS_PENDING_CLASS;

const BUILTIN_STATUS_CLASS: Record<string, string> = {
  backlog: STATUS_PENDING_CLASS,
  planning: STATUS_PENDING_CLASS,
  ready: STATUS_IN_PROGRESS_CLASS,
  in_progress: STATUS_IN_PROGRESS_CLASS,
  review: STATUS_REVIEW_CLASS,
  done: STATUS_COMPLETED_CLASS,
  dropped: STATUS_FAILED_CLASS,
  active: STATUS_IN_PROGRESS_CLASS,
  pending: STATUS_PENDING_CLASS,
  blocked: STATUS_BLOCKED_CLASS,
  completed: STATUS_COMPLETED_CLASS,
  failed: STATUS_FAILED_CLASS,
  archived: STATUS_ARCHIVED_CLASS,
};

function fallbackClass(status: string): string {
  return BUILTIN_STATUS_CLASS[status] ?? NEUTRAL_PILL_CLASS;
}

const NAMED_TOKEN_CLASS: Record<string, string> = {
  slate: NEUTRAL_PILL_CLASS,
  gray: NEUTRAL_PILL_CLASS,
  grey: NEUTRAL_PILL_CLASS,
  violet: STATUS_PENDING_CLASS,
  blue: STATUS_IN_PROGRESS_CLASS,
  teal: STATUS_IN_PROGRESS_CLASS,
  amber: STATUS_REVIEW_CLASS,
  emerald: STATUS_COMPLETED_CLASS,
  rose: STATUS_FAILED_CLASS,
};

export interface StatusAppearance {
  label: string;
  className: string;
  style?: CSSProperties;
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

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) {
    h = h.split('').map((c) => c + c).join('');
  }
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function colorToAppearance(status: string, color?: string): { className: string; style?: CSSProperties } {
  const trimmed = color?.trim();
  if (trimmed) {
    if (trimmed.startsWith('#')) {
      const rgb = hexToRgb(trimmed);
      if (rgb) {
        const { r, g, b } = rgb;
        return {
          className: '',
          style: {
            backgroundColor: `rgba(${r}, ${g}, ${b}, 0.15)`,
            borderColor: `rgba(${r}, ${g}, ${b}, 0.4)`,
            color: trimmed,
          },
        };
      }
    } else {
      const tokenClass = NAMED_TOKEN_CLASS[trimmed.toLowerCase()];
      if (tokenClass) return { className: tokenClass };
    }
  }
  return { className: fallbackClass(status) };
}

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

export function isTerminalStatus(def?: Pick<StatusDefinition, 'id' | 'terminal'>): boolean {
  if (!def) return false;
  return Boolean(def.terminal) || def.id === 'done' || def.id === 'dropped';
}

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

/** Fixed stage labels from STAGE_TABLE. */
export const STAGE_LABELS: Record<string, string> = Object.fromEntries(
  STAGE_TABLE.map((s) => [s.id, s.label]),
);
