export type AssignmentStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'completed'
  | 'failed';

export type TransitionCommand =
  | 'start'
  | 'complete'
  | 'block'
  | 'unblock'
  | 'review'
  | 'fail'
  | 'reopen'
  | 'assign';

export const TERMINAL_STATUSES: ReadonlySet<AssignmentStatus> = new Set([
  'completed',
  'failed',
]);

export interface ExternalId {
  system: string;
  id: string;
  url: string;
}

export interface Workspace {
  repository: string | null;
  worktreePath: string | null;
  branch: string | null;
  parentBranch: string | null;
}

export interface AssignmentFrontmatter {
  id: string;
  slug: string;
  title: string;
  status: AssignmentStatus;
  priority: 'low' | 'medium' | 'high' | 'critical';
  created: string;
  updated: string;
  assignee: string | null;
  externalIds: ExternalId[];
  dependsOn: string[];
  blockedReason: string | null;
  workspace: Workspace;
  tags: string[];
}

export interface TransitionResult {
  success: boolean;
  message: string;
  fromStatus: AssignmentStatus;
  toStatus?: AssignmentStatus;
  warnings?: string[];
}
