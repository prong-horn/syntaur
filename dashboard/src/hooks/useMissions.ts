import { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';
import type { WsMessage } from './useWebSocket';
import type { ServersResponse, TrackedSession } from '../types';

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
  status: 'pending' | 'in_progress' | 'blocked' | 'review' | 'completed' | 'failed';
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

export interface AssignmentTransitionAction {
  command: 'start' | 'complete' | 'block' | 'unblock' | 'review' | 'fail' | 'reopen';
  label: string;
  description: string;
  targetStatus: AssignmentSummary['status'];
  disabled: boolean;
  disabledReason: string | null;
  warning: string | null;
  requiresReason: boolean;
}

export interface AssignmentDetail {
  missionSlug: string;
  slug: string;
  title: string;
  status: AssignmentSummary['status'];
  priority: AssignmentSummary['priority'];
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

export interface AttentionItem {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  missionSlug: string;
  missionTitle: string;
  assignmentSlug: string;
  assignmentTitle: string;
  status: AssignmentSummary['status'];
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
    status: AssignmentSummary['status'];
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
  firstMissionChecklist: Array<{
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

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

function useFetch<T>(url: string | null, websocketScope?: 'missions' | 'mission' | 'assignment' | 'assignments' | 'overview' | 'attention' | 'servers'): FetchState<T> {
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

    if (message.type === 'mission-updated' || message.type === 'assignment-updated') {
      refetch();
    }

    if (message.type === 'servers-updated' && websocketScope === 'servers') {
      refetch();
    }
  });

  return { data, loading, error, refetch };
}

export function useMissions(): FetchState<MissionSummary[]> {
  return useFetch<MissionSummary[]>('/api/missions', 'missions');
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

export function useMission(slug: string | undefined): FetchState<MissionDetail> {
  const url = slug ? `/api/missions/${slug}` : null;
  return useFetch<MissionDetail>(url, 'mission');
}

export function useAssignment(
  missionSlug: string | undefined,
  assignmentSlug: string | undefined,
): FetchState<AssignmentDetail> {
  const url =
    missionSlug && assignmentSlug
      ? `/api/missions/${missionSlug}/assignments/${assignmentSlug}`
      : null;
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
