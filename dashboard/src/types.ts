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
}

export interface AgentSessionWithLiveness extends AgentSession {
  isLive: boolean;
  resumeSupported: boolean;
  forkSupported: boolean;
}

export interface AgentSessionsResponse {
  sessions: AgentSessionWithLiveness[];
  generatedAt: string;
}

// --- Todos ---

export type TodoStatus = 'open' | 'in_progress' | 'completed' | 'blocked';

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
