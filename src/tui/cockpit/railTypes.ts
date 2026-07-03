import type { Rect } from '../mouse/registry.js';
import type { AgentSessionWithLiveness } from '../../dashboard/types.js';

/**
 * Maps a mouse click's absolute row (`mouseY`) to a 0-based row index within a
 * list rendered inside `rect`, skipping `headerRows` rows at the top of the
 * rect. Returns null when the click is outside the rect vertically, or lands
 * on/above the header rows.
 */
export function resolveRowIndex(rect: Rect, mouseY: number, headerRows: number): number | null {
  if (mouseY < rect.y || mouseY >= rect.y + rect.height) return null;
  const idx = mouseY - rect.y - headerRows;
  return idx >= 0 ? idx : null;
}

export interface ProjectTreeProps {
  projectsDir: string;
  active: boolean;
  onSelectAssignment: (projectSlug: string | null, assignmentSlug: string) => void;
}

export interface LeftRailProps {
  projectsDir: string;
  railRect: Rect;
  sessions: AgentSessionWithLiveness[];
  focused: boolean;
  active: boolean;
  onSelectSession: (s: AgentSessionWithLiveness) => void;
  onSelectAssignment: (projectSlug: string | null, assignmentSlug: string) => void;
}
