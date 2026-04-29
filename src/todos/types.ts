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
