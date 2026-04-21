import { useState, useEffect } from 'react';
import { listProjects, getProjectDetail } from '../../dashboard/api.js';
import type { ProjectSummary, ProjectDetail } from '../../dashboard/types.js';
import type { TreeNode } from '../types.js';

export function useProjects(projectsDir: string) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const projects = await listProjects(projectsDir);
        const details = await Promise.all(
          projects.map((m) => getProjectDetail(projectsDir, m.slug)),
        );

        if (cancelled) return;

        const tree: TreeNode[] = projects.map((m, i) => {
          const detail = details[i];
          const children: TreeNode[] = (detail?.assignments ?? []).map((a) => ({
            id: `a:${m.slug}:${a.slug}`,
            kind: 'assignment' as const,
            label: a.title,
            slug: a.slug,
            projectSlug: m.slug,
            status: a.status,
            priority: a.priority,
            assignee: a.assignee,
          }));

          return {
            id: `m:${m.slug}`,
            kind: 'project' as const,
            label: m.title,
            slug: m.slug,
            projectSlug: m.slug,
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
  }, [projectsDir]);

  return { nodes, loading, error };
}
