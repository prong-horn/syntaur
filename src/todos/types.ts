export type TodoStatus = 'open' | 'in_progress' | 'completed' | 'blocked';
export type ArchiveInterval = 'daily' | 'weekly' | 'monthly' | 'never';

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
}

export type BundleScope = 'workspace' | 'project' | 'global';

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

export interface BundleStatusSummary {
  status: 'open' | 'in_progress' | 'blocked' | 'completed' | 'mixed';
  counts: { open: number; in_progress: number; blocked: number; completed: number; total: number };
}

export interface TodoChecklist {
  workspace: string;
  archiveInterval: ArchiveInterval;
  items: TodoItem[];
}

export interface LogEntry {
  timestamp: string;
  itemIds: string[];
  items: string;
  session: string | null;
  branch: string | null;
  summary: string;
  blockers: string | null;
  status: string | null;
}

export interface TodoLog {
  workspace: string;
  entries: LogEntry[];
}
