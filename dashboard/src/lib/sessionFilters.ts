/**
 * Pure client-side filter / sort / limit engine for agent sessions.
 * Mirrors the assignment board pattern (filterBoardItems + sortAssignments).
 * No React imports — testable under Node/vitest.
 */

import type { AgentSessionWithLiveness } from '../types';
import type {
  SortField,
  SortDirection,
  DateRangeFilter,
} from '@shared/view-prefs-schema';

// ── Duration preset resolution (matches AQL semantics) ──────────────────────
// Preset → boundary epoch ms. Sessions whose `started` falls on the "keep" side
// of the boundary pass the filter.
// last_*  → started >= now - X
// older_* → started <  now - X

const PRESET_MS: Record<string, number> = {
  last_24h: 24 * 60 * 60 * 1000,
  last_7d: 7 * 24 * 60 * 60 * 1000,
  last_30d: 30 * 24 * 60 * 60 * 1000,
  last_90d: 90 * 24 * 60 * 60 * 1000,
  older_7d: 7 * 24 * 60 * 60 * 1000,
  older_30d: 30 * 24 * 60 * 60 * 1000,
};

function parseIso(value: string | undefined | null): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Resolve a dateRange filter against a session `started` timestamp.
 * Returns true when the session passes the filter.
 */
function matchDateRange(
  startedIso: string,
  dr: DateRangeFilter,
  now: number = Date.now(),
): boolean {
  const started = parseIso(startedIso);

  if (dr.preset) {
    const window = PRESET_MS[dr.preset];
    if (!window) return true; // unknown preset → no-op
    if (dr.preset.startsWith('older_')) {
      return started < now - window;
    }
    // last_*
    return started >= now - window;
  }

  const from = dr.from ? Date.parse(`${dr.from}T00:00:00.000Z`) : null;
  const to = dr.to ? Date.parse(`${dr.to}T23:59:59.999Z`) : null;
  if (from !== null && Number.isFinite(from) && started < from) return false;
  if (to !== null && Number.isFinite(to) && started > to) return false;
  return true;
}

// ── SessionFilterOptions ─────────────────────────────────────────────────────

export interface SessionFilterOptions {
  dateRange?: DateRangeFilter;
  project?: string[];
  agent?: string[];
  sessionStatus?: string[];
  limit?: number;
}

/**
 * Filter a list of agent sessions by the provided options.
 * Returns a new array — does not mutate input.
 */
export function filterSessions(
  sessions: AgentSessionWithLiveness[],
  options: SessionFilterOptions,
  now: number = Date.now(),
): AgentSessionWithLiveness[] {
  const { dateRange, project, agent, sessionStatus } = options;
  const projectSet = new Set(project ?? []);
  const agentSet = new Set(agent ?? []);
  const statusSet = new Set(sessionStatus ?? []);

  return sessions.filter((s) => {
    // dateRange — always applied to `started`
    if (dateRange) {
      if (!matchDateRange(s.started, dateRange, now)) return false;
    }

    // project — empty set = no constraint
    if (projectSet.size > 0) {
      const slug = s.projectSlug ?? '__standalone__';
      if (!projectSet.has(slug)) return false;
    }

    // agent — exact match, case-insensitive
    if (agentSet.size > 0) {
      const match = Array.from(agentSet).some(
        (a) => a.toLowerCase() === s.agent.toLowerCase(),
      );
      if (!match) return false;
    }

    // sessionStatus
    if (statusSet.size > 0) {
      let pass = false;
      for (const st of statusSet) {
        switch (st) {
          case 'active':
            if (s.status === 'active') pass = true;
            break;
          case 'ended':
            if (s.status === 'completed' || s.status === 'stopped') pass = true;
            break;
          case 'tracked':
            pass = true; // all items from /api/agent-sessions are tracked
            break;
          case 'untracked':
            // MVP: untracked requires merging /api/servers scan data, so it
            // never matches a DB-tracked session. Deferred (see decision-record).
            break;
          default:
            break;
        }
        if (pass) break;
      }
      if (!pass) return false;
    }

    return true;
  });
}

/**
 * Sort sessions by the given field and direction.
 * Unknown sort fields fall back to `started` desc (defensive).
 * Returns a new array — does not mutate input.
 */
export function sortSessions(
  sessions: AgentSessionWithLiveness[],
  sortField: SortField,
  sortDirection: SortDirection,
): AgentSessionWithLiveness[] {
  const sorted = [...sessions].sort((a, b) => {
    let cmp = 0;
    switch (sortField) {
      case 'started':
        cmp = parseIso(a.started) - parseIso(b.started);
        break;
      case 'lastActivity':
        cmp = parseIso(a.updatedAt) - parseIso(b.updatedAt);
        break;
      case 'projectName': {
        const pa = a.projectSlug ?? '';
        const pb = b.projectSlug ?? '';
        cmp = pa.localeCompare(pb);
        break;
      }
      case 'agentName':
        cmp = a.agent.localeCompare(b.agent);
        break;
      default:
        // Defensive: unknown fields fall back to started desc
        cmp = parseIso(a.started) - parseIso(b.started);
        break;
    }
    return sortDirection === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

/**
 * Apply a max-results limit. No limit when undefined, null, NaN, or ≤ 0.
 */
export function applySessionLimit(
  sessions: AgentSessionWithLiveness[],
  limit: number | undefined,
): AgentSessionWithLiveness[] {
  if (limit === undefined || limit === null || Number.isNaN(limit) || limit <= 0) {
    return sessions;
  }
  return sessions.slice(0, limit);
}
