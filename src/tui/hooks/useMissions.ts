import { useState, useEffect } from 'react';
import { listMissions, getMissionDetail } from '../../dashboard/api.js';
import type { MissionSummary, MissionDetail } from '../../dashboard/types.js';
import type { TreeNode } from '../types.js';

export function useMissions(missionsDir: string) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const missions = await listMissions(missionsDir);
        const details = await Promise.all(
          missions.map((m) => getMissionDetail(missionsDir, m.slug)),
        );

        if (cancelled) return;

        const tree: TreeNode[] = missions.map((m, i) => {
          const detail = details[i];
          const children: TreeNode[] = (detail?.assignments ?? []).map((a) => ({
            id: `a:${m.slug}:${a.slug}`,
            kind: 'assignment' as const,
            label: a.title,
            slug: a.slug,
            missionSlug: m.slug,
            status: a.status,
            priority: a.priority,
            assignee: a.assignee,
          }));

          return {
            id: `m:${m.slug}`,
            kind: 'mission' as const,
            label: m.title,
            slug: m.slug,
            missionSlug: m.slug,
            status: m.status,
            progress: {
              completed: m.progress.completed,
              total: m.progress.total,
            },
            children,
          };
        });

        setNodes(tree);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [missionsDir]);

  return { nodes, loading, error };
}
