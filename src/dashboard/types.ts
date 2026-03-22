import type { AssignmentStatus, TransitionCommand } from '../lifecycle/types.js';

// Re-export for convenience in dashboard modules
export type { AssignmentStatus, TransitionCommand } from '../lifecycle/types.js';

// --- API Response Types ---

export interface ProgressCounts {
  total: number;
  completed: number;
  in_progress: number;
  blocked: number;
  pending: number;
  review: number;
  failed: number;
}

export interface NeedsAttention {
  blockedCount: number;
  failedCount: number;
  unansweredQuestions: number;
}

export interface MissionSummary {
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
}

export interface AssignmentSummary {
  slug: string;
  title: string;
  status: AssignmentStatus;
  priority: 'low' | 'medium' | 'high' | 'critical';
  assignee: string | null;
  dependsOn: string[];
  updated: string;
}

export interface AssignmentBoardItem extends AssignmentSummary {
  missionSlug: string;
  missionTitle: string;
  blockedReason: string | null;
  availableTransitions: AssignmentTransitionAction[];
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

export interface MissionDetail {
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
  missionSlug: string;
  slug: string;
  title: string;
  status: AssignmentStatus;
  priority: 'low' | 'medium' | 'high' | 'critical';
  assignee: string | null;
  dependsOn: string[];
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
  availableTransitions: AssignmentTransitionAction[];
}

export interface AssignmentTransitionAction {
  command: Exclude<TransitionCommand, 'assign'>;
  label: string;
  description: string;
  targetStatus: AssignmentStatus;
  disabled: boolean;
  disabledReason: string | null;
  warning: string | null;
  requiresReason: boolean;
}

export interface AttentionItem {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  missionSlug: string;
  missionTitle: string;
  assignmentSlug: string;
  assignmentTitle: string;
  status: AssignmentStatus;
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
  type: 'mission' | 'assignment';
  title: string;
  updated: string;
  href: string;
  missionSlug: string;
  missionTitle: string;
  assignmentSlug: string | null;
  summary: string;
}

export interface OverviewResponse {
  generatedAt: string;
  firstRun: boolean;
  stats: {
    activeMissions: number;
    inProgressAssignments: number;
    blockedAssignments: number;
    reviewAssignments: number;
    failedAssignments: number;
    staleAssignments: number;
  };
  attention: AttentionItem[];
  recentMissions: MissionSummary[];
  recentActivity: RecentActivityItem[];
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
  status: AssignmentStatus;
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
  firstMissionChecklist: HelpChecklistItem[];
  links: HelpSectionLink[];
}

export type EditableDocumentType =
  | 'mission'
  | 'assignment'
  | 'plan'
  | 'scratchpad'
  | 'handoff'
  | 'decision-record';

export interface EditableDocumentResponse {
  documentType: EditableDocumentType;
  title: string;
  content: string;
  missionSlug: string;
  assignmentSlug?: string;
  appendOnly: boolean;
}

// --- WebSocket Message Types ---

export type WsMessageType =
  | 'mission-updated'
  | 'assignment-updated'
  | 'servers-updated'
  | 'connected';

export interface WsMessage {
  type: WsMessageType;
  missionSlug?: string;
  assignmentSlug?: string;
  timestamp: string;
}

// --- Server Tracker Types ---

export interface TrackedSession {
  name: string;
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
    mission: string;
    slug: string;
    title: string;
  } | null;
}

export interface ServersResponse {
  sessions: TrackedSession[];
  tmuxAvailable: boolean;
}

export interface SessionFileData {
  session: string;
  registered: string;
  lastRefreshed: string;
  overrides: Record<string, { mission: string; assignment: string }>;
}
