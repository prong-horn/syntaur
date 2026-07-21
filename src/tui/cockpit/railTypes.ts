import { basename } from 'node:path';
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
  contentRect: Rect;
  active: boolean;
  onSelectAssignment: (projectSlug: string | null, assignmentSlug: string) => void;
}

export interface LeftRailProps {
  contentRect: Rect;
  sessions: AgentSessionWithLiveness[];
  selectedSessionId: string | null;
  focused: boolean;
  onSelectSession: (s: AgentSessionWithLiveness) => void;
  /** sessionId -> transcript-derived activity phrase (e.g. "editing DetailPane.tsx"), from `useLiveActivity`. */
  liveActivity?: Map<string, string>;
}

// --- Row model (railTypes owns the single render+hit-test source, mirroring actionBarLayout.ts) ---

export interface RailSessionRow {
  kind: 'session';
  session: AgentSessionWithLiveness;
  agent: string;
  label: string;
  glyph: string;
  glyphColor: string;
  activityText: string | null;
  isWaiting: boolean;
  age: string;
}

export interface RailGroupHeaderRow {
  kind: 'group-header';
  group: 'live' | 'recent';
  label: string;
  expanded: boolean;
}

export interface RailMoreRow {
  kind: 'more';
  count: number;
}

export type RailRow = RailSessionRow | RailGroupHeaderRow | RailMoreRow;

const RECENT_CAP = 20;

/** Never a bare UUID: assignmentSlug (qualified by projectSlug when present) → description → basename of the session's working path → a generic fallback. */
function resolveLabel(s: AgentSessionWithLiveness): string {
  if (s.assignmentSlug) return s.projectSlug ? `${s.projectSlug}/${s.assignmentSlug}` : s.assignmentSlug;
  if (s.description) return s.description;
  if (s.path) {
    const base = basename(s.path);
    if (base) return base;
  }
  return 'session';
}

function isWaiting(s: AgentSessionWithLiveness): boolean {
  return s.needs != null || s.waitingFor != null || s.state === 'blocked' || s.activity === 'awaiting-input';
}

function isWorking(s: AgentSessionWithLiveness): boolean {
  return s.state === 'working' || s.activity === 'working';
}

/**
 * `⚠ <needs|waitingFor>` always wins (the headline attention signal). `needs`
 * (syntaurd daemon-adapter provenance) wins over `waitingFor` (claude-native
 * monitor provenance) when both are present — the daemon adapter sees the
 * live screen/hooks, while the native view is a slower external poll (D4).
 * Otherwise prefer the transcript-derived `liveActivity` phrase (e.g.
 * "editing DetailPane.tsx") over the coarse working/idle state — richer and
 * more current, since it comes from the session's own latest transcript
 * event rather than a coarse enum.
 */
function resolveActivityText(s: AgentSessionWithLiveness, liveActivity: string | null): string | null {
  const reason = s.needs ?? s.waitingFor;
  if (reason) return `⚠ ${reason}`;
  if (isWaiting(s)) return '⚠ awaiting input';
  if (liveActivity) return liveActivity;
  if (isWorking(s)) return 'working';
  if (s.activity === 'idle') return 'idle';
  return null;
}

function recencyMs(s: AgentSessionWithLiveness, now: number): number {
  const raw = s.updatedAt ?? s.ended ?? s.started;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? now - parsed : Number.POSITIVE_INFINITY;
}

/** Formats an age in ms as a short relative label: `<1m`, `5m`, `3h`, `2d`. */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function liveRank(s: AgentSessionWithLiveness): number {
  if (isWaiting(s)) return 0;
  if (isWorking(s)) return 1;
  return 2;
}

function sessionRow(s: AgentSessionWithLiveness, now: number, liveActivity: string | null): RailSessionRow {
  const waiting = isWaiting(s);
  return {
    kind: 'session',
    session: s,
    agent: s.agent,
    label: resolveLabel(s),
    glyph: s.isLive ? (waiting ? '◐' : '●') : '○',
    glyphColor: s.isLive ? (waiting ? 'yellow' : 'green') : 'gray',
    activityText: resolveActivityText(s, liveActivity),
    isWaiting: waiting,
    age: formatAge(recencyMs(s, now)),
  };
}

export interface BuildRailRowsOptions {
  recentExpanded: boolean;
  /** Injectable for tests; defaults to Date.now(). */
  now?: number;
  /** sessionId -> transcript-derived activity phrase, from `useLiveActivity`. */
  liveActivity?: Map<string, string>;
}

/**
 * Pure row builder — render and click hit-testing both consume this SAME
 * output (design's single-source invariant, mirroring `actionBarLayout.ts`).
 * Live sessions sort waiting → working (by recency) → idle and are always
 * shown; dead sessions collapse behind a `RECENT (N)` header, expandable to a
 * capped, most-recent-first list with a trailing `…and N more` row.
 */
export function buildRailRows(sessions: AgentSessionWithLiveness[], opts: BuildRailRowsOptions): RailRow[] {
  const now = opts.now ?? Date.now();
  const live = sessions.filter((s) => s.isLive);
  const recent = sessions.filter((s) => !s.isLive);

  live.sort((a, b) => {
    const ra = liveRank(a);
    const rb = liveRank(b);
    if (ra !== rb) return ra - rb;
    return recencyMs(a, now) - recencyMs(b, now);
  });
  recent.sort((a, b) => recencyMs(a, now) - recencyMs(b, now));

  const rows: RailRow[] = [];
  rows.push({ kind: 'group-header', group: 'live', label: `LIVE (${live.length})`, expanded: true });
  for (const s of live) rows.push(sessionRow(s, now, opts.liveActivity?.get(s.sessionId) ?? null));

  rows.push({ kind: 'group-header', group: 'recent', label: `RECENT (${recent.length})`, expanded: opts.recentExpanded });
  if (opts.recentExpanded) {
    const shown = recent.slice(0, RECENT_CAP);
    for (const s of shown) rows.push(sessionRow(s, now, null));
    if (recent.length > shown.length) rows.push({ kind: 'more', count: recent.length - shown.length });
  }

  return rows;
}
