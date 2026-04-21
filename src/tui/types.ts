import type { WorkspaceInfo } from '../dashboard/types.js';

export interface TreeNode {
  id: string;
  kind: 'project' | 'assignment';
  label: string;
  slug: string;
  projectSlug: string;
  status: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  assignee?: string | null;
  workspace?: WorkspaceInfo;
  progress?: { completed: number; total: number };
  children?: TreeNode[];
}

export interface FlatNode extends TreeNode {
  depth: number;
  expanded?: boolean;
  hasChildren?: boolean;
}
