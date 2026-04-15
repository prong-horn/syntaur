export type AssignmentStatus = string;

export type TransitionCommand = string;

export const DEFAULT_STATUSES = [
  'pending',
  'in_progress',
  'blocked',
  'review',
  'completed',
  'failed',
] as const;

export const DEFAULT_COMMANDS = [
  'start',
  'complete',
  'block',
  'unblock',
  'review',
  'fail',
  'reopen',
  'assign',
] as const;

export const DEFAULT_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
]);

export const TERMINAL_STATUSES: ReadonlySet<string> = DEFAULT_TERMINAL_STATUSES;

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
  links: string[];
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
