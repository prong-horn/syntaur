export type AssignmentStatus = string;

export type TransitionCommand = string;

export const DEFAULT_STATUSES = [
  'draft',
  'pending',
  'ready_for_planning',
  'ready_to_implement',
  'in_progress',
  'blocked',
  'review',
  'completed',
  'failed',
] as const;

export const DEFAULT_COMMANDS = [
  'start',
  'shape',
  'plan-ready',
  'implement',
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
  url: string | null;
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
  project: string | null;
  type: string | null;
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
