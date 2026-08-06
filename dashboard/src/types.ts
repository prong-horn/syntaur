import type { SessionAttribution } from '@shared/session-attribution';
export interface TrackedSession {
  name: string;
  kind?: 'tmux' | 'process';
  registered: string;
  lastRefreshed: string;
  scannedAt: string;
  alive: boolean;
  windows: TrackedWindow[];
}

export interface TrackedWindow {
  index: number;
  name: string;
  panes: TrackedPane[];
}

export interface TrackedPane {
  index: number;
  command: string;
  cwd: string;
  branch: string | null;
  worktree: boolean;
  ports: number[];
  urls: string[];
  assignment: {
    project: string;
    slug: string;
    title: string;
  } | null;
}

export interface ServersResponse {
  sessions: TrackedSession[];
  tmuxAvailable: boolean;
}

export interface OverviewServerStats {
  trackedSessions: number;
  aliveSessions: number;
  deadSessions: number;
  totalPorts: number;
}

// --- Resource Lease Types ---

export type MemberStatus = 'idle' | 'leased' | 'retired';
export type LeaseState = 'active' | 'released' | 'expired' | 'revoked';

export interface Inventory {
  slug: string;
  kind: string;
  display_name: string | null;
  default_ttl_s: number;
  created_at: string;
}

export interface InventoryMember {
  inventory_slug: string;
  member_id: string;
  status: MemberStatus;
  generation: number;
  metadata_json: string | null;
  last_used_at: string | null;
  retired_at: string | null;
}

export interface Lease {
  lease_id: string;
  inventory_slug: string;
  member_id: string;
  member_gen: number;
  state: LeaseState;
  granted_at: string;
  expires_at: string;
  released_at: string | null;
  requested_for: string | null;
}

export interface InventoryDetail {
  inventory: Inventory;
  members: InventoryMember[];
  active_leases: Lease[];
}

export interface InventoriesResponse {
  inventories: InventoryDetail[];
}

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
  assignmentSlug: string | null;
  agent: string;
  sessionId: string;
  started: string;
  ended?: string | null;
  status: AgentSessionStatus;
  path: string;
  description?: string | null;
  transcriptPath?: string | null;
  pid?: number | null;
  pidStartedAt?: string | null;
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
  isLive: boolean;
  resumeSupported: boolean;
  forkSupported: boolean;
}

// ── Phase D: browser-attach detail + token ────────────────────────────────

export type DaemonSessionState = 'working' | 'blocked' | 'done' | 'failed' | 'stopped';

export interface SettledScreen {
  lastScreen: string | null;
  cols: number;
  rows: number;
  exitCode?: number | null;
  exitSignal?: number | null;
  state: DaemonSessionState;
}

export interface AgentSessionDetail extends AgentSessionWithLiveness {
  syntaurdShortId: string | null;
  attachable: boolean;
  syntaurdState?: DaemonSessionState | null;
  needs?: string | null;
  daemonUnavailable?: boolean;
  settled?: SettledScreen | null;
}

export interface AgentSessionDetailResponse {
  session: AgentSessionDetail;
  generatedAt: string;
}

export interface PtyTokenResponse {
  token: string;
  short: string;
  expiresAt: number;
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

// --- Todos ---

export type TodoStatus = 'open' | 'in_progress' | 'completed' | 'blocked';

export interface TodoAttachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  createdAt: string;
}

export interface TodoItem {
  id: string;
  description: string;
  status: TodoStatus;
  tags: string[];
  session: string | null;
  branch: string | null;
  worktreePath: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  planDir: string | null;
  linkedAssignmentId: string | null;
  linkedAssignmentRef: string | null;
  bundleId: string | null;
  // Present on list/single GET responses (computed server-side from disk).
  attachments?: TodoAttachment[];
}

// --- Bundles (read-only in v1) ---

export type BundleScope = 'workspace' | 'project' | 'global';

export type BundleStatus = 'open' | 'in_progress' | 'blocked' | 'completed' | 'mixed';

export interface BundleStatusSummary {
  status: BundleStatus;
  counts: {
    open: number;
    in_progress: number;
    blocked: number;
    completed: number;
    total: number;
  };
}

export interface TodoBundle {
  id: string;
  slug: string | null;
  scope: BundleScope;
  scopeId: string;
  todoIds: string[];
  planDir: string | null;
  branch: string | null;
  worktreePath: string | null;
  repository: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BundleWithMembers extends TodoBundle {
  members: TodoItem[];
  derivedStatus: BundleStatusSummary;
}

export interface BundleScopeGroup {
  scope: BundleScope;
  scopeId: string;
  bundles: BundleWithMembers[];
}

export interface BundlesAggregateResponse {
  scopes: BundleScopeGroup[];
}

export interface BundlesSingleScopeResponse {
  scope: BundleScope;
  scopeId: string;
  bundles: BundleWithMembers[];
}

export interface TodoCounts {
  open: number;
  in_progress: number;
  completed: number;
  blocked: number;
  total: number;
}

export interface TodoListResponse {
  workspace: string;
  archiveInterval: string;
  items: TodoItem[];
  counts: TodoCounts;
}

export interface TodoLogEntry {
  timestamp: string;
  itemIds: string[];
  items: string;
  session: string | null;
  branch: string | null;
  summary: string;
  blockers: string | null;
  status: string | null;
}

export interface TodoAggregateResponse {
  workspaces: TodoListResponse[];
}
