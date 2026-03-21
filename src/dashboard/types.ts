import type { AssignmentStatus } from '../lifecycle/types.js';

// Re-export for convenience in dashboard modules
export type { AssignmentStatus } from '../lifecycle/types.js';

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
  archived: boolean;
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
  archived: boolean;
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
  plan: { status: string; body: string } | null;
  scratchpad: { body: string } | null;
  handoff: { handoffCount: number; body: string } | null;
  decisionRecord: { decisionCount: number; body: string } | null;
}

// --- WebSocket Message Types ---

export type WsMessageType =
  | 'mission-updated'
  | 'assignment-updated'
  | 'connected';

export interface WsMessage {
  type: WsMessageType;
  missionSlug?: string;
  assignmentSlug?: string;
  timestamp: string;
}
