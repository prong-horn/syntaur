import { useState, useMemo } from 'react';
import Fuse from 'fuse.js';
import type { TreeNode } from '../types.js';

interface SearchableItem {
  id: string;
  label: string;
  slug: string;
  status: string;
  assignee: string;
  priority: string;
  projectSlug: string;
}

export function useSearch(nodes: TreeNode[]) {
  const [query, setQuery] = useState('');
  const [searchActive, setSearchActive] = useState(false);

  const fuse = useMemo(() => {
    const items: SearchableItem[] = [];
    for (const project of nodes) {
      items.push({
        id: project.id,
        label: project.label,
        slug: project.slug,
        status: project.status,
        assignee: '',
        priority: '',
        projectSlug: project.projectSlug,
      });
      if (project.children) {
        for (const child of project.children) {
          items.push({
            id: child.id,
            label: child.label,
            slug: child.slug,
            status: child.status,
            assignee: child.assignee ?? '',
            priority: child.priority ?? '',
            projectSlug: child.projectSlug,
          });
        }
      }
    }
    return new Fuse(items, {
      keys: ['label', 'slug', 'status', 'assignee', 'priority'],
      threshold: 0.4,
      includeScore: true,
    });
  }, [nodes]);

  const filteredIds = useMemo<Set<string> | null>(() => {
    if (!query.trim()) return null;
    const results = fuse.search(query);
    return new Set(results.map((r) => r.item.id));
  }, [fuse, query]);

  return {
    query,
    setQuery,
    searchActive,
    setSearchActive,
    filteredIds,
  };
}
