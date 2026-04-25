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
  updated: string;
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
  body: string;
  progress: ProgressCounts;
  needsAttention: NeedsAttention;
  assignments: AssignmentSummary[];
  resources: ResourceSummary[];
  memories: MemorySummary[];
  dependencyGraph: string | null;
  workspace: string | null;
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
  url: string;
}

export interface AssignmentDetail {
  id: string;
  /** `null` for standalone assignments that live outside any project. */
  projectSlug: string | null;
  slug: string;
  title: string;
  status: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  assignee: string | null;
  dependsOn: string[];
  links: string[];
  reverseLinks: string[];
  enrichedLinks: EnrichedLink[];
  blockedReason: string | null;
  workspace: WorkspaceInfo;
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
}

export interface AttentionResponse {
  generatedAt: string;
  summary: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  items: AttentionItem[];
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
  attention: AttentionItem[];
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
  | 'playbook';

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
}

export interface AgentSessionsResponse {
  sessions: AgentSession[];
  generatedAt: string;
}
