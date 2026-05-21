import type { AssignmentStatus, TransitionCommand } from '../lifecycle/types.js';

// Re-export for convenience in dashboard modules
export type { AssignmentStatus, TransitionCommand } from '../lifecycle/types.js';

// --- API Response Types ---

export type ProgressCounts = Record<string, number> & { total: number };

export interface NeedsAttention {
  blockedCount: number;
  failedCount: number;
  openQuestions: number;
}

export interface ProjectSummary {
  slug: string;
  title: string;
  status: string;
  statusOverride: string | null;
  archived: boolean;
  archivedAt: string | null;
  archivedReason: string | null;
  created: string;
  updated: string;
  tags: string[];
  progress: ProgressCounts;
  needsAttention: NeedsAttention;
  workspace: string | null;
}

export interface EnrichedLink {
  slug: string;
  projectSlug: string;
  assignmentSlug: string;
  title: string;
  status: string;
  isReverse: boolean;
}

export interface AssignmentSummary {
  id: string;
  slug: string;
  title: string;
  status: string;
  type: string | null;
  priority: 'low' | 'medium' | 'high' | 'critical';
  assignee: string | null;
  dependsOn: string[];
  links: string[];
  updated: string;
}

export interface AssignmentBoardItem extends AssignmentSummary {
  /** `null` for standalone assignments that live outside any project. */
  projectSlug: string | null;
  /** `null` for standalone assignments. */
  projectTitle: string | null;
  blockedReason: string | null;
  availableTransitions: AssignmentTransitionAction[];
  /** Workspace this assignment belongs to. Sourced from `project.workspace` for project-nested assignments, from `workspaceGroup` for standalone assignments. `null` when neither is set. */
  projectWorkspace: string | null;
}

export interface ResourceSummary {
  name: string;
  slug: string;
  category: string;
  source: string;
  relatedAssignments: string[];
  updated: string;
}

export interface MemorySummary {
  name: string;
  slug: string;
  source: string;
  scope: string;
  sourceAssignment: string | null;
  relatedAssignments: string[];
  updated: string;
}

/** Cross-project list shape: project-scoped summary enriched with project context. */
export interface MemorySummaryWithProject extends MemorySummary {
  projectSlug: string;
  projectTitle: string;
}

export interface ResourceSummaryWithProject extends ResourceSummary {
  projectSlug: string;
  projectTitle: string;
}

export interface MemoryDetail extends MemorySummaryWithProject {
  body: string;
  created: string;
  tags: string[];
}

export interface ResourceDetail extends ResourceSummaryWithProject {
  body: string;
  created: string;
}

export interface MemoriesResponse {
  generatedAt: string;
  memories: MemorySummaryWithProject[];
}

export interface ResourcesResponse {
  generatedAt: string;
  resources: ResourceSummaryWithProject[];
}

export interface ProjectDetail {
  slug: string;
  title: string;
  status: string;
  statusOverride: string | null;
  archived: boolean;
  archivedAt: string | null;
  archivedReason: string | null;
  created: string;
  updated: string;
  tags: string[];
  externalIds: ExternalIdInfo[];
  body: string;
  progress: ProgressCounts;
  needsAttention: NeedsAttention;
  assignments: AssignmentSummary[];
  resources: ResourceSummary[];
  memories: MemorySummary[];
  dependencyGraph: string | null;
  workspace: string | null;
  /** Repository paths the project spans. Empty array when the project.md frontmatter omits the field. */
  repositories: string[];
}

export interface WorkspaceInfo {
  repository: string | null;
  worktreePath: string | null;
  branch: string | null;
  parentBranch: string | null;
}

export interface ExternalIdInfo {
  system: string;
  id: string;
  url: string | null;
}

export interface AssignmentDetail {
  id: string;
  /** `null` for standalone assignments that live outside any project. */
  projectSlug: string | null;
  slug: string;
  title: string;
  status: string;
  type: string | null;
  priority: 'low' | 'medium' | 'high' | 'critical';
  assignee: string | null;
  dependsOn: string[];
  links: string[];
  reverseLinks: string[];
  enrichedLinks: EnrichedLink[];
  blockedReason: string | null;
  workspace: WorkspaceInfo;
  /** Project-workspace this assignment belongs to. Sourced from `project.workspace` for project-nested assignments, from `workspaceGroup` for standalone assignments. `null` when neither is set. Distinct from `workspace` above, which is the assignment-workspace block (repo/worktree/branch). */
  projectWorkspace: string | null;
  externalIds: ExternalIdInfo[];
  tags: string[];
  created: string;
  updated: string;
  body: string;
  plan: { status: string; updated: string; body: string } | null;
  scratchpad: { updated: string; body: string } | null;
  handoff: { updated: string; handoffCount: number; body: string } | null;
  decisionRecord: { updated: string; decisionCount: number; body: string } | null;
  progress: AssignmentProgress | null;
  comments: AssignmentComments | null;
  referencedBy: AssignmentReference[];
  availableTransitions: AssignmentTransitionAction[];
}

/**
 * Reverse link: an assignment that mentions the current one in its Todos, comments,
 * progress, or handoff body. Populated by the dashboard when returning AssignmentDetail.
 */
export interface AssignmentReference {
  /** UUID of the source assignment. */
  sourceId: string;
  /** Slug of the source assignment (folder name or display slug). */
  sourceSlug: string;
  /** Title of the source assignment. */
  sourceTitle: string;
  /** Project slug of the source, or `null` if source is standalone. */
  sourceProjectSlug: string | null;
  /** Number of distinct mentions across the source's searched bodies. */
  mentions: number;
}

export interface AssignmentProgressEntry {
  timestamp: string;
  body: string;
}

export interface AssignmentProgress {
  updated: string;
  entryCount: number;
  entries: AssignmentProgressEntry[];
}

export interface AssignmentCommentEntry {
  id: string;
  timestamp: string;
  author: string;
  type: 'question' | 'note' | 'feedback';
  body: string;
  replyTo?: string;
  resolved?: boolean;
}

export interface AssignmentComments {
  updated: string;
  entryCount: number;
  entries: AssignmentCommentEntry[];
}

export interface AssignmentTransitionAction {
  command: string;
  label: string;
  description: string;
  targetStatus: string;
  disabled: boolean;
  disabledReason: string | null;
  warning: string | null;
  requiresReason: boolean;
}

/**
 * Overview segment identifier. Every row in the new segmented Overview maps
 * to exactly one of these. Backed by the Overview row reason copy in
 * `overviewCopy.ts`.
 */
export type OverviewSegmentId =
  | 'readyForReview'
  | 'readyToImplement'
  | 'readyForPlanning'
  | 'inProgress'
  | 'drafts'
  | 'blocked'
  | 'newestCreated'
  | 'stale';

export interface AttentionItem {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** `null` for standalone assignments. */
  projectSlug: string | null;
  /** `null` for standalone assignments. */
  projectTitle: string | null;
  assignmentSlug: string;
  assignmentTitle: string;
  status: string;
  reason: string;
  updated: string;
  href: string;
  stale: boolean;
  blockedReason: string | null;
  /** Which Overview segment this row was bucketed into. */
  segment: OverviewSegmentId;
  /** Milliseconds since the row was last updated, relative to response time. */
  agingMs: number;
  /** Current assignee from frontmatter; `null` if unclaimed. */
  assignee: string | null;
  /** Transitions available right now; powers the Advance quick action. */
  availableTransitions: AssignmentTransitionAction[];
}

/** Hero category — drives both copy lookup and the row reference. */
export type OverviewHeroKind =
  | 'review'
  | 'ready_to_implement'
  | 'ready_for_planning'
  | 'in_progress'
  | 'draft'
  | 'blocked'
  | 'stale'
  | 'clean';

export interface OverviewHeroRecommendation {
  kind: OverviewHeroKind;
  /**
   * Copy key in `overviewCopy.ts`. For non-clean kinds the backend may emit
   * either the plural key (`'review'`) or the singular variant
   * (`'review.singular'`) — `total` carries the count.
   */
  copyKey: string;
  /** AttentionItem.id of the row this hero references; `null` when `kind === 'clean'`. */
  itemId: string | null;
  /** Pre-cap total in the chosen segment. `0` when `kind === 'clean'`. */
  total: number;
}

export interface OverviewSegmentPayload {
  items: AttentionItem[];
  /** Pre-cap total before display truncation. */
  total: number;
}

export interface OverviewStaleSegmentPayload extends OverviewSegmentPayload {
  /** Page size used by the server for this response. */
  limit: number;
  /** Page offset honored by the server for this response. */
  offset: number;
  /** True when there are more stale rows beyond `offset + items.length`. */
  hasMore: boolean;
}

export interface OverviewSegments {
  readyForReview: OverviewSegmentPayload;
  readyToImplement: OverviewSegmentPayload;
  readyForPlanning: OverviewSegmentPayload;
  inProgress: OverviewSegmentPayload;
  drafts: OverviewSegmentPayload;
  blocked: OverviewSegmentPayload;
  newestCreated: OverviewSegmentPayload;
  stale: OverviewStaleSegmentPayload;
}

export interface AssignmentsBoardResponse {
  generatedAt: string;
  assignments: AssignmentBoardItem[];
}

export interface RecentActivityItem {
  id: string;
  type: 'project' | 'assignment';
  title: string;
  updated: string;
  href: string;
  /** `null` when the activity is for a standalone assignment. */
  projectSlug: string | null;
  /** `null` when the activity is for a standalone assignment. */
  projectTitle: string | null;
  assignmentSlug: string | null;
  summary: string;
}

export interface OverviewResponse {
  generatedAt: string;
  firstRun: boolean;
  stats: {
    activeProjects: number;
    inProgressAssignments: number;
    blockedAssignments: number;
    reviewAssignments: number;
    failedAssignments: number;
    staleAssignments: number;
  };
  hero: OverviewHeroRecommendation;
  segments: OverviewSegments;
  recentSessions: AgentSession[];
  recentProjects: ProjectSummary[];
  recentActivity: RecentActivityItem[];
  serverStats?: {
    trackedSessions: number;
    aliveSessions: number;
    deadSessions: number;
    totalPorts: number;
  };
}

export interface HelpCommand {
  command: string;
  description: string;
  example: string;
}

export interface HelpSectionLink {
  label: string;
  href: string;
}

export interface HelpConcept {
  term: string;
  description: string;
}

export interface HelpStatusGuideEntry {
  status: string;
  meaning: string;
  useWhen: string;
}

export interface HelpOwnershipRule {
  label: string;
  files: string[];
  description: string;
}

export interface HelpChecklistItem {
  title: string;
  detail: string;
  command?: HelpCommand;
  href?: string;
}

export interface HelpNavigationItem {
  label: string;
  description: string;
  href: string;
}

export interface HelpResponse {
  generatedAt: string;
  whatIsSyntaur: {
    summary: string;
    bullets: string[];
  };
  coreConcepts: HelpConcept[];
  workflow: HelpChecklistItem[];
  statusGuide: HelpStatusGuideEntry[];
  ownershipRules: HelpOwnershipRule[];
  commands: HelpCommand[];
  navigation: HelpNavigationItem[];
  faq: Array<{
    question: string;
    answer: string;
  }>;
  firstProjectChecklist: HelpChecklistItem[];
  links: HelpSectionLink[];
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

export type EditableDocumentType =
  | 'project'
  | 'assignment'
  | 'plan'
  | 'scratchpad'
  | 'handoff'
  | 'decision-record'
  | 'playbook'
  | 'memory'
  | 'resource';

export interface EditableDocumentResponse {
  documentType: EditableDocumentType;
  title: string;
  content: string;
  projectSlug: string | null;
  assignmentSlug?: string;
  /** For standalone assignments, the UUID (routes use /assignments/:id/...). */
  assignmentId?: string;
  appendOnly: boolean;
}

// --- WebSocket Message Types ---

export type WsMessageType =
  | 'project-updated'
  | 'assignment-updated'
  | 'servers-updated'
  | 'agent-sessions-updated'
  | 'playbooks-updated'
  | 'todos-updated'
  | 'leases-updated'
  | 'connected';

export interface WsMessage {
  type: WsMessageType;
  projectSlug?: string | null;
  assignmentSlug?: string;
  timestamp: string;
}

// --- Server Tracker Types ---

export interface TrackedSession {
  name: string;
  kind?: SessionKind;
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
    project: string | null;
    slug: string;
    title: string;
  } | null;
}

export interface ServersResponse {
  sessions: TrackedSession[];
  tmuxAvailable: boolean;
}

export type SessionKind = 'tmux' | 'process';

export interface SessionFileData {
  session: string;
  registered: string;
  lastRefreshed: string;
  overrides: Record<string, { project: string; assignment: string }>;
  auto?: boolean;
  kind?: SessionKind;
  pid?: number;
  ports?: number[];
  cwd?: string;
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
