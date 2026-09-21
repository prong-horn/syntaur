import type { SessionAttribution } from '@shared/session-attribution';

// --- Playbook Types ---

export interface PlaybookSummary {
  slug: string;
  name: string;
  description: string;
  whenToUse: string;
  tags: string[];
  created: string;
  updated: string;
  enabled: boolean;
}

export interface PlaybookDetail extends PlaybookSummary {
  body: string;
}

export interface PlaybooksResponse {
  generatedAt: string;
  playbooks: PlaybookSummary[];
}

// --- Agent Session Types ---

export type AgentSessionStatus = 'active' | 'completed' | 'stopped';

export interface AgentSession {
  projectSlug: string | null;
  ticketSlug: string | null;
  /** Resolved ticket UUID when the session binding has one. */
  ticketId?: string | null;
  agent: string;
  sessionId: string;
  started: string;
  ended?: string | null;
  status: AgentSessionStatus;
  path: string;
  description?: string | null;
  transcriptPath?: string | null;
  originalHeadSha?: string | null;
  updatedAt?: string | null;
  /** Rolled-up spend joined from usage_events at serve time; null when the collector has no rows. */
  usage?: SessionUsageSummary | null;
  /** Synthetic row that exists only in usage_events (no tracked session) — no transcript/liveness/actions. */
  usageOnly?: boolean;
  /** Short auto-generated blurb from the session transcript; null until summarized. */
  summary?: string | null;
  /** When {@link summary} was written (ISO 8601). */
  summarizedAt?: string | null;
  /** Who wrote `description`: 'human' is protected from the auto-summarizer. */
  descriptionSource?: 'human' | 'auto' | null;
  /** When the session was pinned (ISO 8601); null when unpinned. Pinned sessions lead the result set. */
  pinnedAt?: string | null;
  /** When the session was archived (ISO 8601); null when not archived. Hidden from the default list. */
  archivedAt?: string | null;
}

/** Per-session spend attached to AgentSession.usage. */
export interface SessionUsageSummary {
  totalCost: number;
  totalTokens: number;
  /**
   * Prompt and completion tokens. These do NOT sum to `totalTokens` — the
   * remainder is `totalCacheTokens`, which for a long session is typically two
   * or three orders of magnitude larger than either. Render them as their own
   * quantity, never as a breakdown that should add up to the total.
   *
   * Optional on purpose. The server always sends them, but a browser holding a
   * newer bundle can be talking to a server that hasn't restarted yet, and
   * these were absent before that build. Treating them as guaranteed made one
   * missing number blank the entire page.
   */
  totalInputTokens?: number;
  totalOutputTokens?: number;
  /** Cache creation + cache read. */
  totalCacheTokens?: number;
  models: Array<{ model: string; cost: number; tokens: number }>;
}

export interface AgentSessionWithLiveness extends AgentSession {
  /**
   * `status === 'active'`. The resume/fork capability flags went with the
   * terminal profiles they were derived from (phase 4).
   */
  isLive: boolean;
}

/**
 * One session's detail payload. Phase 4 removed the daemon join that used to
 * enrich it (short id, attachability, live state, the settled final screen) —
 * the chat owns its adapters directly and there is no browser terminal.
 */
export type AgentSessionDetail = AgentSessionWithLiveness;

export interface AgentSessionDetailResponse {
  session: AgentSessionDetail;
  generatedAt: string;
}

export interface SessionPageMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  pageCount: number;
  attribution: SessionAttribution;
  /** Row counts per attribution bucket, so the filter can show what it hides. */
  attributionCounts: Record<SessionAttribution, number>;
}

export interface AgentSessionsResponse {
  sessions: AgentSessionWithLiveness[];
  generatedAt: string;
  /** Present only when the request opted into paging via `pageSize`. */
  page?: SessionPageMeta;
}
