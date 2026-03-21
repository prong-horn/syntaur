import { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';
import type { WsMessage } from './useWebSocket';

// --- Types matching server API responses ---

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
  status: string;
  priority: string;
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
  status: string;
  priority: string;
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

// --- Generic fetch hook ---

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

function useFetch<T>(url: string | null): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchCount, setFetchCount] = useState(0);

  const refetch = useCallback(() => {
    setFetchCount((c) => c + 1);
  }, []);

  useEffect(() => {
    if (!url) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (!cancelled) {
          setData(json as T);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url, fetchCount]);

  return { data, loading, error, refetch };
}

// --- Mission List Hook ---

export function useMissions(): FetchState<MissionSummary[]> {
  const state = useFetch<MissionSummary[]>('/api/missions');

  useWebSocket((msg: WsMessage) => {
    if (msg.type === 'mission-updated' || msg.type === 'assignment-updated') {
      state.refetch();
    }
  });

  return state;
}

// --- Mission Detail Hook ---

export function useMission(slug: string | undefined): FetchState<MissionDetail> {
  const url = slug ? `/api/missions/${slug}` : null;
  const state = useFetch<MissionDetail>(url);

  useWebSocket((msg: WsMessage) => {
    if (msg.missionSlug === slug) {
      state.refetch();
    }
  });

  return state;
}

// --- Assignment Detail Hook ---

export function useAssignment(
  missionSlug: string | undefined,
  assignmentSlug: string | undefined,
): FetchState<AssignmentDetail> {
  const url =
    missionSlug && assignmentSlug
      ? `/api/missions/${missionSlug}/assignments/${assignmentSlug}`
      : null;
  const state = useFetch<AssignmentDetail>(url);

  useWebSocket((msg: WsMessage) => {
    if (
      msg.missionSlug === missionSlug &&
      (msg.type === 'mission-updated' ||
        (msg.type === 'assignment-updated' && msg.assignmentSlug === assignmentSlug))
    ) {
      state.refetch();
    }
  });

  return state;
}
