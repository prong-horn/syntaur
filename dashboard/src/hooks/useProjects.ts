import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useWebSocket } from './useWebSocket';
import type { WsMessage } from './useWebSocket';
import type { ServersResponse, TrackedSession, AgentSessionsResponse, PlaybooksResponse, PlaybookDetail, InventoriesResponse, InventoryDetail } from '../types';

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
  /** `null` for standalone assignments. */
  projectSlug: string | null;
  /** `null` for standalone assignments. */
  projectTitle: string | null;
  blockedReason: string | null;
  availableTransitions: AssignmentTransitionAction[];
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

export interface AssignmentDetail {
  id: string;
  /** `null` for standalone assignments. */
  projectSlug: string | null;
  slug: string;
  title: string;
  status: string;
  priority: AssignmentSummary['priority'];
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

export interface AssignmentReference {
  sourceId: string;
  sourceSlug: string;
  sourceTitle: string;
  sourceProjectSlug: string | null;
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

export interface AttentionItem {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  projectSlug: string;
  projectTitle: string;
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
  projectSlug: string;
  projectTitle: string;
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

export interface HelpResponse {
  generatedAt: string;
  whatIsSyntaur: {
    summary: string;
    bullets: string[];
  };
  coreConcepts: Array<{
    term: string;
    description: string;
  }>;
  workflow: Array<{
    title: string;
    detail: string;
    command?: HelpCommand;
    href?: string;
  }>;
  statusGuide: Array<{
    status: string;
    meaning: string;
    useWhen: string;
  }>;
  ownershipRules: Array<{
    label: string;
    files: string[];
    description: string;
  }>;
  commands: HelpCommand[];
  navigation: Array<{
    label: string;
    description: string;
    href: string;
  }>;
  faq: Array<{
    question: string;
    answer: string;
  }>;
  firstProjectChecklist: Array<{
    title: string;
    detail: string;
    command?: HelpCommand;
    href?: string;
  }>;
  links: Array<{
    label: string;
    href: string;
  }>;
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
  projectSlug: string;
  assignmentSlug?: string;
  appendOnly: boolean;
}

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

function useFetch<T>(url: string | null, websocketScope?: 'projects' | 'project' | 'assignment' | 'assignments' | 'overview' | 'attention' | 'servers' | 'agent-sessions' | 'playbooks' | 'inventories'): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchCount, setFetchCount] = useState(0);

  const refetch = useCallback(() => {
    setFetchCount((count) => count + 1);
  }, []);

  useEffect(() => {
    if (!url) {
      setLoading(false);
      setData(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error || `HTTP ${response.status}`);
        }
        return response.json() as Promise<T>;
      })
      .then((json) => {
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      })
      .catch((fetchError: Error) => {
        if (!cancelled) {
          setError(fetchError.message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url, fetchCount]);

  useWebSocket((message: WsMessage) => {
    if (!websocketScope) {
      return;
    }

    if (message.type === 'project-updated' || message.type === 'assignment-updated') {
      refetch();
    }

    if (message.type === 'servers-updated' && websocketScope === 'servers') {
      refetch();
    }

    if (message.type === 'agent-sessions-updated' && websocketScope === 'agent-sessions') {
      refetch();
    }

    if (message.type === 'playbooks-updated' && websocketScope === 'playbooks') {
      refetch();
    }

    if (message.type === 'leases-updated' && websocketScope === 'inventories') {
      refetch();
    }
  });

  return { data, loading, error, refetch };
}

export function useProjects(): FetchState<ProjectSummary[]> {
  return useFetch<ProjectSummary[]>('/api/projects', 'projects');
}

export function useWorkspaces(): FetchState<{ workspaces: string[]; hasUngrouped: boolean }> {
  return useFetch<{ workspaces: string[]; hasUngrouped: boolean }>('/api/workspaces', 'projects');
}

/** Returns the URL prefix for workspace-scoped links: '/w/syntaur' or '' */
export function useWorkspacePrefix(): string {
  const { workspace } = useParams<{ workspace?: string }>();
  return workspace ? `/w/${workspace}` : '';
}

export function useOverview(): FetchState<OverviewResponse> {
  return useFetch<OverviewResponse>('/api/overview', 'overview');
}

export function useAssignmentsBoard(): FetchState<AssignmentsBoardResponse> {
  return useFetch<AssignmentsBoardResponse>('/api/assignments', 'assignments');
}

export function useAttention(): FetchState<AttentionResponse> {
  return useFetch<AttentionResponse>('/api/attention', 'attention');
}

export function useHelp(): FetchState<HelpResponse> {
  return useFetch<HelpResponse>('/api/help');
}

export function useProject(slug: string | undefined): FetchState<ProjectDetail> {
  const url = slug ? `/api/projects/${slug}` : null;
  return useFetch<ProjectDetail>(url, 'project');
}

export function useAssignment(
  projectSlug: string | undefined,
  assignmentSlug: string | undefined,
): FetchState<AssignmentDetail> {
  const url =
    projectSlug && assignmentSlug
      ? `/api/projects/${projectSlug}/assignments/${assignmentSlug}`
      : null;
  return useFetch<AssignmentDetail>(url, 'assignment');
}

export function useAssignmentById(
  id: string | undefined,
): FetchState<AssignmentDetail> {
  const url = id ? `/api/assignments/${id}` : null;
  return useFetch<AssignmentDetail>(url, 'assignment');
}

export function useEditableDocument(
  url: string | null,
): FetchState<EditableDocumentResponse> {
  return useFetch<EditableDocumentResponse>(url);
}

export function useServers(): FetchState<ServersResponse> {
  return useFetch<ServersResponse>('/api/servers', 'servers');
}

export function useServer(name: string | null): FetchState<TrackedSession> {
  return useFetch<TrackedSession>(
    name ? `/api/servers/${encodeURIComponent(name)}` : null,
    'servers',
  );
}

export function useInventories(): FetchState<InventoriesResponse> {
  return useFetch<InventoriesResponse>('/api/leases', 'inventories');
}

export function useInventory(slug: string | null): FetchState<InventoryDetail> {
  return useFetch<InventoryDetail>(
    slug ? `/api/leases/${encodeURIComponent(slug)}` : null,
    'inventories',
  );
}

export function useAgentSessions(): FetchState<AgentSessionsResponse> {
  return useFetch<AgentSessionsResponse>('/api/agent-sessions', 'agent-sessions');
}

export function useAssignmentSessions(
  projectSlug: string | undefined,
  assignmentSlug: string | undefined,
): FetchState<AgentSessionsResponse> {
  const url =
    projectSlug && assignmentSlug
      ? `/api/agent-sessions/${projectSlug}?assignment=${assignmentSlug}`
      : null;
  return useFetch<AgentSessionsResponse>(url, 'agent-sessions');
}

export function useAssignmentSessionsById(
  id: string | undefined,
): FetchState<AgentSessionsResponse> {
  const url = id ? `/api/assignments/${id}/sessions` : null;
  return useFetch<AgentSessionsResponse>(url, 'agent-sessions');
}

export function usePlaybooks(): FetchState<PlaybooksResponse> {
  return useFetch<PlaybooksResponse>('/api/playbooks', 'playbooks');
}

export function usePlaybook(slug: string | undefined): FetchState<PlaybookDetail> {
  const url = slug ? `/api/playbooks/${slug}` : null;
  return useFetch<PlaybookDetail>(url, 'playbooks');
}

export function useMemories(): FetchState<MemoriesResponse> {
  return useFetch<MemoriesResponse>('/api/memories', 'project');
}

export function useMemory(
  projectSlug: string | undefined,
  itemSlug: string | undefined,
): FetchState<MemoryDetail> {
  const url = projectSlug && itemSlug ? `/api/projects/${projectSlug}/memories/${itemSlug}` : null;
  return useFetch<MemoryDetail>(url, 'project');
}

export function useResources(): FetchState<ResourcesResponse> {
  return useFetch<ResourcesResponse>('/api/resources', 'project');
}

export function useResource(
  projectSlug: string | undefined,
  itemSlug: string | undefined,
): FetchState<ResourceDetail> {
  const url = projectSlug && itemSlug ? `/api/projects/${projectSlug}/resources/${itemSlug}` : null;
  return useFetch<ResourceDetail>(url, 'project');
}
